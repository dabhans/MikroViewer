// Stores the log of one router: recent records in memory, everything in hourly files on disk
// (logs/<router id>/2026-10-26T14.jsonl, one JSON record per line, UTC hours).
//
// Records are only ever appended: a session is written when it ends, like the traffic log of a
// firewall, and a firewall record when the router logs the packet.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LogEntry, LogHistogram, LogQueryResult } from '../../shared/types'
import type { LogPredicate } from '../../shared/logquery'
import { systemLogFiles } from './routerlog'

/** Records kept in memory. Queries that reach further back read the files. */
const MEMORY_MAX = 200_000
const FLUSH_MS = 1000
const HOUR = 3600_000
const FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/

export type NewLogEntry = Omit<LogEntry, 'id'>

/** What a router session writes to. */
export interface LogSink {
  add(entry: NewLogEntry): number
}

// ---------- File format ----------

// Short keys keep the files about a third smaller. "end" is only in files from before 0.3.
const KEYS: [string, string][] = [
  ['id', 'i'],
  ['t', 't'],
  ['type', 'k'],
  ['action', 'a'],
  ['protocol', 'p'],
  ['src', 's'],
  ['srcPort', 'sp'],
  ['srcName', 'sn'],
  ['srcMac', 'sm'],
  ['dst', 'd'],
  ['dstPort', 'dp'],
  ['dstName', 'dn'],
  ['start', 'st'],
  ['startBefore', 'sb'],
  ['endReason', 'er'],
  ['end', 'e'],
  ['durationSec', 'du'],
  ['approx', 'ax'],
  ['txBytes', 'tx'],
  ['rxBytes', 'rx'],
  ['chain', 'c'],
  ['inInterface', 'ii'],
  ['outInterface', 'oi'],
  ['rule', 'r'],
  ['prefix', 'px'],
  ['ruleNumber', 'rn'],
  ['tcpFlags', 'tf'],
  ['connState', 'cs'],
  ['length', 'l'],
  ['icmp', 'ic'],
  ['message', 'm']
]
const SHORT = new Map(KEYS)
const LONG = new Map(KEYS.map(([l, s]) => [s, l]))

function encode(e: LogEntry): string {
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined) continue
    if (k === 'nat') {
      const n = v as LogEntry['nat']
      o.nk = n!.kind
      o.na = n!.address
    } else {
      const s = SHORT.get(k)
      if (s) o[s] = v
    }
  }
  return JSON.stringify(o) + '\n'
}

function decode(o: Record<string, unknown>): Record<string, unknown> {
  const e: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    const l = LONG.get(k)
    if (l) e[l] = v
  }
  if (typeof o.nk === 'string') e.nat = { kind: o.nk, address: String(o.na ?? '') }
  return e
}

/**
 * Before 0.3 a session was written when it opened (t = start) and completed by an update line
 * when it closed. Those become records of the end, like new ones; sessions that never closed are left out.
 */
function fromLegacy(e: Record<string, unknown>): LogEntry | null {
  if (e.type !== 'session' || e.start !== undefined) return e as unknown as LogEntry
  if (typeof e.end !== 'number') return null
  const { end, ...rest } = e
  return { ...rest, start: e.t, t: end, ...(e.approx ? { startBefore: true } : {}) } as unknown as LogEntry
}

function hourKey(t: number): string {
  return new Date(t).toISOString().slice(0, 13)
}

function hourStart(key: string): number {
  return Date.parse(`${key}:00:00Z`)
}

// ---------- Histogram ----------

const BUCKETS = [10e3, 30e3, 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]

/** Buckets of an hour or more start on local hours/days. */
function alignDown(t: number, step: number): number {
  const offset = step >= HOUR ? -new Date(t).getTimezoneOffset() * 60e3 : 0
  return Math.floor((t + offset) / step) * step - offset
}

class Histogram {
  readonly from: number
  readonly bucketMs: number
  readonly counts: number[]
  readonly blocked: number[]

  constructor(from: number, to: number) {
    this.bucketMs = BUCKETS.find((b) => (to - from) / b <= 60) ?? 7 * 24 * HOUR
    this.from = alignDown(from, this.bucketMs)
    const n = Math.max(1, Math.ceil((to - this.from) / this.bucketMs))
    this.counts = new Array(n).fill(0)
    this.blocked = new Array(n).fill(0)
  }

  add(e: LogEntry): void {
    const i = Math.floor((e.t - this.from) / this.bucketMs)
    if (i < 0 || i >= this.counts.length) return
    this.counts[i]++
    if (e.action === 'drop' || e.action === 'reject') this.blocked[i]++
  }

  toJSON(): LogHistogram {
    return { from: this.from, bucketMs: this.bucketMs, counts: this.counts, blocked: this.blocked }
  }
}

// ---------- Store ----------

export class LogStore implements LogSink {
  private recent: LogEntry[] = []
  /** Everything from this time on is in `recent`. */
  private memoryFrom = Date.now()
  private lastId = 0

  private pendingLines = new Map<string, string[]>()
  private pendingAdded: LogEntry[] = []
  private flushTimer?: NodeJS.Timeout
  private writing: Promise<void> = Promise.resolve()

  constructor(
    readonly dir: string,
    private readonly onChange: (added: LogEntry[]) => void
  ) {}

  private nextId(): number {
    // Unique across restarts: microseconds since 1970, made strictly increasing.
    this.lastId = Math.max(Date.now() * 1000, this.lastId + 1)
    return this.lastId
  }

  add(entry: NewLogEntry): number {
    const e = { ...entry, id: this.nextId() } as LogEntry
    this.recent.push(e)
    if (this.recent.length > MEMORY_MAX * 1.1) this.trimMemory()
    this.queue(hourKey(e.t), encode(e))
    this.pendingAdded.push(e)
    this.scheduleFlush()
    return e.id
  }

  private trimMemory(): void {
    const cut = this.recent[this.recent.length - MEMORY_MAX].t
    this.recent = this.recent.filter((e) => e.t >= cut)
    this.memoryFrom = Math.max(this.memoryFrom, cut)
  }

  private queue(hour: string, line: string): void {
    let lines = this.pendingLines.get(hour)
    if (!lines) this.pendingLines.set(hour, (lines = []))
    lines.push(line)
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS)
  }

  private takePending(): Map<string, string[]> {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const added = this.pendingAdded
    this.pendingAdded = []
    if (added.length) this.onChange(added)
    const lines = this.pendingLines
    this.pendingLines = new Map()
    return lines
  }

  async flush(): Promise<void> {
    const lines = this.takePending()
    this.writing = this.writing
      .then(async () => {
        if (!lines.size) return
        await fsp.mkdir(this.dir, { recursive: true })
        for (const [hour, ls] of lines) await fsp.appendFile(path.join(this.dir, `${hour}.jsonl`), ls.join(''))
      })
      .catch((err) => console.error('Could not write the log:', err))
    await this.writing
  }

  /** Used when the app quits – there is no time to wait for async writes. */
  flushSync(): void {
    const lines = this.takePending()
    if (!lines.size) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      for (const [hour, ls] of lines) fs.appendFileSync(path.join(this.dir, `${hour}.jsonl`), ls.join(''))
    } catch (err) {
      console.error('Could not write the log:', err)
    }
  }

  // ---------- Reading ----------

  private async files(): Promise<{ name: string; start: number }[]> {
    try {
      const names = await fsp.readdir(this.dir)
      return names
        .map((name) => ({ name, m: name.match(FILE_RE) }))
        .filter((f) => f.m)
        .map((f) => ({ name: f.name, start: hourStart(f.m![1]) }))
        .sort((a, b) => a.start - b.start)
    } catch {
      return []
    }
  }

  private async readFile(name: string): Promise<LogEntry[]> {
    let text: string
    try {
      text = await fsp.readFile(path.join(this.dir, name), 'utf8')
    } catch {
      return []
    }
    const byId = new Map<number, Record<string, unknown>>()
    for (const line of text.split('\n')) {
      if (!line) continue
      let o: Record<string, unknown>
      try {
        o = JSON.parse(line)
      } catch {
        continue // a half-written last line
      }
      if (typeof o.u === 'number') {
        // An update line (files from before 0.3).
        const e = byId.get(o.u)
        if (e) Object.assign(e, decode(o))
      } else {
        const e = decode(o)
        if (typeof e.id === 'number') byId.set(e.id, e)
      }
    }
    const out: LogEntry[] = []
    for (const e of byId.values()) {
      const entry = fromLegacy(e)
      if (entry) out.push(entry)
    }
    return out
  }

  /**
   * Calls `each` with the matching records in [from, to], one batch at a time, newest batch first
   * (or oldest first). Records within a batch are sorted the same way.
   */
  private async scan(pred: LogPredicate, from: number, to: number, order: 'asc' | 'desc', each: (batch: LogEntry[]) => void | Promise<void>): Promise<void> {
    const keep = (e: LogEntry): boolean => e.t >= from && e.t <= to && pred(e)
    const sort = (a: LogEntry, b: LogEntry): number => (order === 'desc' ? b.t - a.t || b.id - a.id : a.t - b.t || a.id - b.id)

    if (from >= this.memoryFrom) {
      await each(this.recent.filter(keep).sort(sort))
      return
    }
    await this.flush()
    const files = (await this.files()).filter((f) => f.start <= to && f.start + HOUR > from)
    if (order === 'desc') files.reverse()
    for (const f of files) {
      const batch = (await this.readFile(f.name)).filter(keep)
      await each(batch.sort(sort))
    }
  }

  /** The time of the oldest record – used for "All". */
  async earliest(): Promise<number | undefined> {
    const files = await this.files()
    if (files.length) return files[0].start
    return this.recent.length ? Math.min(...this.recent.slice(0, 1000).map((e) => e.t)) : undefined
  }

  async query(pred: LogPredicate, from: number, to: number, limit: number): Promise<LogQueryResult> {
    const started = performance.now()
    if (from <= 0) from = (await this.earliest()) ?? to - HOUR
    const hist = new Histogram(from, to)
    const entries: LogEntry[] = []
    let total = 0
    await this.scan(pred, from, to, 'desc', (batch) => {
      total += batch.length
      for (const e of batch) {
        hist.add(e)
        if (entries.length < limit) entries.push(e)
      }
    })
    return { entries, total, histogram: hist.toJSON(), from, to, tookMs: Math.round(performance.now() - started) }
  }

  /** All matching records, oldest first, for export. */
  async forEach(pred: LogPredicate, from: number, to: number, each: (batch: LogEntry[]) => void | Promise<void>): Promise<void> {
    if (from <= 0) from = (await this.earliest()) ?? 0
    await this.scan(pred, from, to, 'asc', each)
  }

  async clear(): Promise<void> {
    this.takePending()
    this.pendingLines.clear()
    this.recent = []
    this.memoryFrom = Date.now()
    await this.writing
    await fsp.rm(this.dir, { recursive: true, force: true })
  }

  /** The hour files with the time each covers – for pruning. */
  async fileSpans(): Promise<{ file: string; start: number; end: number }[]> {
    return (await this.files()).map((f) => ({ file: path.join(this.dir, f.name), start: f.start, end: f.start + HOUR }))
  }
}

/** Total size of all log files (all routers). */
export async function logStorageBytes(root: string): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    let items: fs.Dirent[]
    try {
      items = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const p = path.join(dir, it.name)
      if (it.isDirectory()) await walk(p)
      else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size
    }
  }
  await walk(root)
  return total
}

/**
 * Deletes the log files (all routers, Logs and System Log) older than the retention period, then
 * the oldest ones until all of them fit in `maxBytes` (0: no limit). Files still being written are
 * kept, so the newest hour of each router always stays.
 */
export async function pruneAll(root: string, retentionDays: number, maxBytes = 0): Promise<void> {
  let dirs: string[]
  try {
    dirs = await fsp.readdir(root)
  } catch {
    return
  }
  const now = Date.now()
  const oldest = now - retentionDays * 24 * HOUR
  const kept: { file: string; start: number; end: number; size: number }[] = []
  for (const d of dirs) {
    const dir = path.join(root, d)
    const files = [...(await new LogStore(dir, () => {}).fileSpans()), ...(await systemLogFiles(path.join(dir, 'system')))]
    for (const f of files) {
      if (f.end < oldest) await fsp.rm(f.file, { force: true })
      else kept.push({ ...f, size: (await fsp.stat(f.file).catch(() => ({ size: 0 }))).size })
    }
  }
  if (!maxBytes) return
  let total = kept.reduce((sum, f) => sum + f.size, 0)
  for (const f of kept.sort((a, b) => a.start - b.start)) {
    if (total <= maxBytes) break
    if (f.end > now) continue
    await fsp.rm(f.file, { force: true })
    total -= f.size
  }
}
