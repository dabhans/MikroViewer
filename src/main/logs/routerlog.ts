// The router's own log (System Log), kept by MikroViewer. The router only remembers its last
// 1,000 lines by default, and a firewall rule that logs can fill those in minutes. Every line
// MikroViewer sees is kept here: in memory for the System Log view, and on disk in one file per
// day (logs/<router id>/system/2026-10-29.jsonl) so the history survives a restart.
//
// Firewall lines are already stored as records in Logs, so only the newest of them are kept, in
// memory – a busy rule can't push the other messages out.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const OTHER_MAX = 20_000
const FIREWALL_MAX = 2_000
const FLUSH_MS = 1000
const DAY = 24 * 3600_000
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** A line from the router's log. */
export interface RouterLogLine {
  /** When it was written (ms). */
  t: number
  topics: string[]
  message: string
  /** The router's own number for the line (.id) – it starts over when the router reboots. */
  rid?: number
}

export interface StoredLine extends RouterLogLine {
  /** Order in which MikroViewer kept the lines; the System Log view asks for what is newer. */
  seq: number
}

const isFirewall = (l: RouterLogLine): boolean => l.topics.includes('firewall')
const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10)

/** "*1A2F" → 6703 */
export function routerLogId(id: string | undefined): number | undefined {
  const n = parseInt((id ?? '').replace('*', ''), 16)
  return Number.isFinite(n) ? n : undefined
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * The time of a line already in the router's log, from the router's "time" field: "21:42:08" today,
 * "2026-10-28 21:42:08", "oct/28 21:42:08" or "oct/28/2026 21:42:08" earlier. Unknown formats count as now.
 */
export function parseLogTime(time: string, now = Date.now()): number {
  const clock = (h: string, m: string, s: string, d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate(), +h, +m, +s).getTime()
  let m = time.match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
  if (m) {
    const t = clock(m[1], m[2], m[3], new Date(now))
    // A time later than now belongs to yesterday (the clocks differ a little, or it's just after midnight).
    return t > now + 3600_000 ? t - DAY : t
  }
  m = time.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  m = time.match(/^([a-z]{3})\/(\d{2})(?:\/(\d{4}))? (\d{1,2}):(\d{2}):(\d{2})$/i)
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    const month = MONTHS.indexOf(m[1].toLowerCase())
    const year = m[3] ? +m[3] : new Date(now).getFullYear()
    const t = new Date(year, month, +m[2], +m[4], +m[5], +m[6]).getTime()
    // Without a year it's this year's date, unless that is still to come.
    return !m[3] && t > now + DAY ? new Date(year - 1, month, +m[2], +m[4], +m[5], +m[6]).getTime() : t
  }
  return now
}

export class RouterLogStore {
  private other: StoredLine[] = []
  private firewall: StoredLine[] = []
  private seq = 0
  /** The newest line kept: where the router's log is picked up after (re)connecting. */
  private last?: StoredLine
  /** The router's number of the newest line, since its last reboot (-1: not known). */
  private lastRid = -1
  private pending = new Map<string, string[]>()
  private flushTimer?: NodeJS.Timeout
  private writing: Promise<void> = Promise.resolve()
  /** Resolves when the lines from earlier runs are read. */
  readonly ready: Promise<void>

  /** `dir` null: kept in memory only. */
  constructor(private readonly dir: string | null) {
    this.ready = this.load()
  }

  /**
   * The lines that were in the router's log when MikroViewer connected. Those it already has are
   * skipped: by the router's line numbers when the newest kept line is still there, otherwise
   * (the router rebooted, or its log moved on) by time.
   */
  addBacklog(lines: RouterLogLine[]): void {
    const last = this.last
    const anchored = last?.rid !== undefined && lines.some((l) => l.rid === last.rid && l.message === last.message)
    const fresh = !last ? lines : anchored ? lines.filter((l) => l.rid !== undefined && l.rid > last.rid!) : lines.filter((l) => l.t > last.t)
    for (const l of fresh) this.keep(l)
    const rids = lines.map((l) => l.rid).filter((r): r is number => r !== undefined)
    this.lastRid = rids.length ? Math.max(...rids) : -1
  }

  /** A line the router has just written. */
  add(line: RouterLogLine): void {
    if (line.rid !== undefined && this.lastRid >= 0 && line.rid <= this.lastRid) return
    if (line.rid !== undefined) this.lastRid = line.rid
    this.keep(line)
  }

  private keep(line: RouterLogLine): void {
    const l: StoredLine = { ...line, seq: ++this.seq }
    this.last = l
    if (isFirewall(l)) {
      this.firewall.push(l)
      if (this.firewall.length > FIREWALL_MAX * 1.1) this.firewall = this.firewall.slice(-FIREWALL_MAX)
      return
    }
    this.other.push(l)
    if (this.other.length > OTHER_MAX * 1.1) this.other = this.other.slice(-OTHER_MAX)
    if (!this.dir) return
    let lines = this.pending.get(dayKey(l.t))
    if (!lines) this.pending.set(dayKey(l.t), (lines = []))
    lines.push(JSON.stringify({ t: l.t, tp: l.topics.join(','), m: l.message, ...(l.rid !== undefined ? { r: l.rid } : {}) }) + '\n')
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS)
  }

  /** The kept lines newer than `afterSeq`, oldest first. */
  since(afterSeq = 0): StoredLine[] {
    const pick = (ls: StoredLine[]): StoredLine[] => (afterSeq > 0 ? ls.filter((l) => l.seq > afterSeq) : ls)
    return [...pick(this.other), ...pick(this.firewall)].sort((a, b) => a.seq - b.seq)
  }

  // ---------- Files ----------

  private async load(): Promise<void> {
    if (!this.dir) return
    let names: string[]
    try {
      names = (await fsp.readdir(this.dir)).filter((n) => FILE_RE.test(n)).sort()
    } catch {
      return
    }
    // Newest days first, until there are enough lines.
    const days: StoredLine[][] = []
    let count = 0
    for (const name of names.reverse()) {
      if (count >= OTHER_MAX) break
      const lines = await this.readFile(name)
      days.unshift(lines)
      count += lines.length
    }
    const loaded = days.flat().sort((a, b) => a.t - b.t)
    const keep = loaded.slice(-OTHER_MAX)
    for (const l of keep) l.seq = ++this.seq
    // Lines that arrived while the files were read come after them.
    for (const l of [...this.other, ...this.firewall]) l.seq += keep.length
    this.other = [...keep, ...this.other]
    if (!this.last && keep.length) this.last = keep[keep.length - 1]
  }

  private async readFile(name: string): Promise<StoredLine[]> {
    let text: string
    try {
      text = await fsp.readFile(path.join(this.dir!, name), 'utf8')
    } catch {
      return []
    }
    const out: StoredLine[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const o = JSON.parse(line)
        if (typeof o.t !== 'number' || typeof o.m !== 'string') continue
        out.push({ t: o.t, topics: String(o.tp ?? '').split(',').filter(Boolean), message: o.m, rid: typeof o.r === 'number' ? o.r : undefined, seq: 0 })
      } catch {
        // a half-written last line
      }
    }
    return out
  }

  private takePending(): Map<string, string[]> {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const lines = this.pending
    this.pending = new Map()
    return lines
  }

  async flush(): Promise<void> {
    const lines = this.takePending()
    const dir = this.dir
    if (!dir || !lines.size) return
    this.writing = this.writing
      .then(async () => {
        await fsp.mkdir(dir, { recursive: true })
        for (const [day, ls] of lines) await fsp.appendFile(path.join(dir, `${day}.jsonl`), ls.join(''))
      })
      .catch((err) => console.error('Could not write the system log:', err))
    await this.writing
  }

  /** Used when the app quits – there is no time to wait for async writes. */
  flushSync(): void {
    const lines = this.takePending()
    if (!this.dir || !lines.size) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      for (const [day, ls] of lines) fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), ls.join(''))
    } catch (err) {
      console.error('Could not write the system log:', err)
    }
  }

  /** Forgets everything (the files are deleted together with the rest of the router's logs). */
  async clear(): Promise<void> {
    this.takePending()
    await this.writing
    this.other = []
    this.firewall = []
    this.last = undefined
    this.lastRid = -1
  }
}

/** The system log files of one router, with the time each covers from – for pruning. */
export async function systemLogFiles(dir: string): Promise<{ file: string; start: number; end: number }[]> {
  try {
    return (await fsp.readdir(dir))
      .map((name) => ({ name, m: name.match(FILE_RE) }))
      .filter((f) => f.m)
      .map((f) => {
        const start = Date.parse(`${f.m![1]}T00:00:00Z`)
        return { file: path.join(dir, f.name), start, end: start + DAY }
      })
  } catch {
    return []
  }
}
