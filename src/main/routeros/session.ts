// One RouterSession per router profile. It keeps the API connection open, polls data in the
// background, reconnects automatically and writes the log: sessions by diffing snapshots of the
// connection table (written when they end), firewall records from the router's log.

import { RouterOSClient, RouterOSError, type ApiRecord, type Stream } from './client'
import { bool, num, parseDuration, parseHealth, primaryTemperature, splitHostPort, stripPrefix } from './parse'
import { MATCH_PROPS, describeMatch, matchRule, parseFirewallMessage, type FirewallPacket, type FirewallRule, type RuleTable } from '../logs/firewall'
import type { LogSink, NewLogEntry } from '../logs/store'
import { RouterLogStore, parseLogTime, routerLogId, type RouterLogLine } from '../logs/routerlog'
import type {
  ConnectionRow,
  FirewallLogStatus,
  HealthSensor,
  InterfaceRow,
  LeaseRow,
  NatInfo,
  OverviewData,
  ResourceSample,
  RouterLogEntry,
  RouterSummary,
  SessionEndReason,
  SessionEvent,
  SessionStatus,
  SystemInfo,
  TestResult,
  TrafficPoint
} from '../../shared/types'

export interface SessionCredentials {
  host: string
  port: number
  tls: boolean
  username: string
  password: string
  expectedFingerprint?: string
}

export interface SessionHost {
  getCredentials(id: string): Promise<SessionCredentials | null>
  onFingerprint(id: string, fingerprint: string): void
  /** The router's identity, so a profile without a name can be named after it. */
  onIdentity(id: string, identity: string): void
  emit(event: SessionEvent): void
}

const RESOURCE_INTERVAL = 2000
const INTERFACE_INTERVAL = 2000
const LEASE_INTERVAL = 10000
const SLOW_INTERVAL = 30000
const HISTORY_LEN = 180 // 6 minutes at 2 s
const IF_HISTORY_LEN = 90 // 3 minutes at 2 s
/** Used when the router can't stream its log. */
const LOG_POLL_INTERVAL = 5000
/** Above this many entries the connection table is no longer fetched (to spare the router's CPU). */
const CONN_ROW_LIMIT = 20000

const CONN_PROPLIST = [
  '.id',
  'protocol',
  'src-address',
  'dst-address',
  // RouterOS 7.20 and later have the ports in fields of their own.
  'src-port',
  'dst-port',
  'reply-src-address',
  'reply-dst-address',
  'reply-src-port',
  'reply-dst-port',
  'tcp-state',
  'timeout',
  'orig-bytes',
  'repl-bytes',
  'orig-rate',
  'repl-rate',
  'fasttrack'
].join(',')

const RULE_TABLES: RuleTable[] = ['filter', 'raw', 'nat', 'mangle']
const RULE_PROPLIST = ['.id', 'chain', 'action', 'log', 'log-prefix', 'comment', 'disabled', 'dynamic', 'packets', ...MATCH_PROPS].join(',')

function connectionInterval(total: number): number {
  if (total <= 2000) return 3000
  if (total <= 8000) return 6000
  return 15000
}

function pushCapped<T>(arr: T[], item: T, max: number): void {
  arr.push(item)
  if (arr.length > max) arr.splice(0, arr.length - max)
}

interface Endpoint {
  ip: string
  port?: number
}

/** RouterOS 7.20+ has separate port fields; older versions write "ip:port" in the address. */
function endpoint(r: ApiRecord, addrKey: string, portKey: string): Endpoint {
  const a = splitHostPort(r[addrKey])
  const p = r[portKey]
  if (a.port === undefined && p !== undefined && p !== '' && Number.isFinite(Number(p))) return { ip: a.ip, port: Number(p) }
  return a
}

function formatEndpoint(e: Endpoint): string {
  return e.port !== undefined ? `${e.ip}:${e.port}` : e.ip
}

function differs(a: Endpoint, b: Endpoint): boolean {
  return !!a.ip && (a.ip !== b.ip || (a.port !== undefined && b.port !== undefined && a.port !== b.port))
}

interface Tracked {
  row: ConnectionRow
  seenAt: number
  /** Protocol and endpoints – an id reused after a router reboot is a different connection. */
  key: string
  /** It already existed when MikroViewer started watching, so its real start is unknown. */
  startBefore: boolean
  /** A closed TCP connection stays in the table for a while (time-wait) – it ended when that began. */
  closingAt?: number
}

/** TCP states that mean the connection was closed: by FIN, or by RST ("close"). */
const FIN_STATES = new Set(['fin-wait', 'close-wait', 'last-ack', 'time-wait'])

function endReason(tr: Tracked): SessionEndReason {
  const state = tr.row.tcpState
  if (state === 'close') return 'reset'
  if (state && FIN_STATES.has(state)) return 'fin'
  return 'aged-out'
}

/** A line of the router's log, as the System Log keeps it. */
function logLine(r: ApiRecord, t: number): RouterLogLine {
  return { t, topics: (r.topics ?? '').split(',').filter(Boolean), message: r.message ?? '', rid: routerLogId(r['.id']) }
}

/** The log record of a connection that has ended. `lost`: it went away while we weren't watching. */
function sessionRecord(tr: Tracked, lost: boolean): NewLogEntry {
  const row = tr.row
  const end = tr.closingAt ?? tr.seenAt
  return {
    t: end,
    type: 'session',
    action: 'accept',
    protocol: row.protocol,
    src: row.srcAddress,
    srcPort: row.srcPort,
    srcName: row.srcName,
    dst: row.dstAddress,
    dstPort: row.dstPort,
    dstName: row.dstName,
    nat: row.nat,
    start: row.firstSeen,
    ...(tr.startBefore ? { startBefore: true } : {}),
    endReason: lost ? 'lost' : endReason(tr),
    durationSec: Math.max(0, (end - row.firstSeen) / 1000),
    ...(lost || tr.startBefore ? { approx: true } : {}),
    txBytes: row.txBytes,
    rxBytes: row.rxBytes
  }
}

export class RouterSession {
  status: SessionStatus
  private client: RouterOSClient | null = null
  private wanted = false
  private generation = 0
  private timers = new Set<NodeJS.Timeout>()
  private retryTimer?: NodeJS.Timeout
  private retryDelay = 2000
  private focused = false

  private system: SystemInfo | null = null
  private history: ResourceSample[] = []
  private health: HealthSensor[] = []
  private noHealth = false

  private connections: ConnectionRow[] = []
  private connTotal = 0
  private connThrottled = false
  /** Kept across reconnects so a connection that is still open isn't logged twice. */
  private tracked = new Map<string, Tracked>()
  /** The next snapshot only records what exists (after connecting) – it opens no sessions. */
  private connBaseline = true
  private noCountOnly = false
  private noConnProplist = false

  private rules: FirewallRule[] = []
  private logStream?: Stream
  private noLogStream = false
  private lastLogId = -1
  /** New lines of the router's log wait here while the lines it already had are read. */
  private logBacklog: RouterLogLine[] | null = null
  /** What the firewall log has delivered since connecting – shown under Firewall Logging. */
  private fwFeed: { feed: 'stream' | 'poll'; since: number; lines: number; unparsed: number; lastAt?: number } | null = null

  private leases: LeaseRow[] = []
  private leaseError?: string
  private leaseByIp = new Map<string, LeaseRow>()

  private interfaces: InterfaceRow[] = []
  private ifPrev = new Map<string, { rx: number; tx: number; t: number }>()
  private ifHistory = new Map<string, TrafficPoint[]>()
  private wanNames: string[] = []

  private dnsByIp = new Map<string, string>()
  private routerIps = new Set<string>()

  constructor(
    readonly id: string,
    private readonly host: SessionHost,
    private readonly log: LogSink,
    private readonly systemLog: RouterLogStore = new RouterLogStore(null)
  ) {
    this.status = { id, state: 'disconnected' }
  }

  // ---------- Connection ----------

  async connect(opts: { retryOnFail?: boolean } = {}): Promise<void> {
    this.wanted = true
    clearTimeout(this.retryTimer)
    if (this.client && !this.client.isClosed) return
    await this.open(opts.retryOnFail ?? false)
  }

  disconnect(): void {
    this.wanted = false
    this.generation++
    clearTimeout(this.retryTimer)
    this.stopLoops()
    this.client?.close()
    this.client = null
    this.fwFeed = null
    this.setStatus({ id: this.id, state: 'disconnected' })
  }

  dispose(): void {
    this.disconnect()
  }

  private async open(retryOnFail: boolean): Promise<void> {
    const gen = ++this.generation
    if (this.status.state === 'reconnecting') this.setStatus({ ...this.status, nextRetryAt: undefined })
    else this.setStatus({ id: this.id, state: 'connecting' })
    const creds = await this.host.getCredentials(this.id)
    if (gen !== this.generation) return
    if (!creds) {
      this.setStatus({ id: this.id, state: 'error', error: 'The router profile no longer exists' })
      return
    }
    try {
      const client = await RouterOSClient.connect({
        host: creds.host,
        port: creds.port,
        tls: creds.tls,
        username: creds.username,
        password: creds.password,
        expectedFingerprint: creds.expectedFingerprint
      })
      if (gen !== this.generation || !this.wanted) {
        client.close()
        return
      }
      this.client = client
      if (client.fingerprint && !creds.expectedFingerprint) this.host.onFingerprint(this.id, client.fingerprint)
      client.on('close', (err: RouterOSError) => this.onLost(gen, err))
      this.retryDelay = 2000
      this.connBaseline = true
      this.ifPrev.clear()
      try {
        await this.loadSystem(client)
        if (this.system?.identity) this.host.onIdentity(this.id, this.system.identity)
      } catch (err) {
        if (client.isClosed) throw err
      }
      if (gen !== this.generation) return
      this.setStatus({ id: this.id, state: 'connected', connectedAt: Date.now() })
      this.startLoops(gen)
    } catch (err) {
      if (gen !== this.generation) return
      const e = err instanceof RouterOSError ? err : new RouterOSError(String((err as Error)?.message ?? err), 'network')
      this.client = null
      const transient = e.kind === 'network' || e.kind === 'timeout' || e.kind === 'fatal'
      if (retryOnFail && transient && this.wanted) {
        this.scheduleRetry(e.message)
      } else {
        this.wanted = false
        this.setStatus({ id: this.id, state: 'error', error: e.message })
      }
    }
  }

  private onLost(gen: number, err: RouterOSError): void {
    if (gen !== this.generation) return
    this.stopLoops()
    this.client = null
    this.fwFeed = null
    if (this.wanted) this.scheduleRetry(err.message)
    else this.setStatus({ id: this.id, state: 'disconnected' })
  }

  private scheduleRetry(message: string): void {
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, 30000)
    this.setStatus({ id: this.id, state: 'reconnecting', error: message, nextRetryAt: Date.now() + delay })
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.open(true), delay)
  }

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.host.emit({ type: 'status', status })
  }

  // ---------- Polling ----------

  private startLoops(gen: number): void {
    this.loop(gen, () => LEASE_INTERVAL, (c) => this.pollLeases(c))
    this.loop(gen, () => SLOW_INTERVAL, (c) => this.pollSlow(c))
    this.loop(gen, () => INTERFACE_INTERVAL, (c) => this.pollInterfaces(c))
    this.loop(gen, () => RESOURCE_INTERVAL, (c) => this.pollResource(c))
    this.loop(gen, () => (this.connThrottled ? 10000 : connectionInterval(this.connTotal)), (c) => this.pollConnections(c))
    if (this.client) void this.readLogBacklog(this.client, gen)
    this.startFirewallLog(gen)
  }

  /** The lines already in the router's log: those written while MikroViewer wasn't watching. */
  private async readLogBacklog(c: RouterOSClient, gen: number): Promise<void> {
    this.logBacklog = []
    try {
      const recs = await c.print('/log')
      await this.systemLog.ready
      if (gen !== this.generation) return
      const now = Date.now()
      this.systemLog.addBacklog(recs.filter((r) => !r['.dead']).map((r) => logLine(r, parseLogTime(r.time ?? '', now))))
    } catch (err) {
      if (!c.isClosed) console.warn(`[${this.id}]`, (err as Error).message)
    } finally {
      if (gen === this.generation) {
        const waiting = this.logBacklog ?? []
        this.logBacklog = null
        for (const l of waiting) this.systemLog.add(l)
      }
    }
  }

  /** New lines in the router's log arrive as a stream; older routers that can't stream are polled. */
  private startFirewallLog(gen: number): void {
    const c = this.client
    if (!c) return
    const counts = this.fwFeed ?? { lines: 0, unparsed: 0 }
    if (this.noLogStream) {
      this.lastLogId = -1
      this.fwFeed = { ...counts, feed: 'poll', since: Date.now() }
      this.loop(gen, () => LOG_POLL_INTERVAL, (c) => this.pollRouterLog(c))
      return
    }
    this.fwFeed = { ...counts, feed: 'stream', since: Date.now() }
    this.logStream = c.stream(['/log/print', '=follow-only='], (r) => this.onRouterLog(r))
    const fallBack = (): void => {
      if (gen !== this.generation || c.isClosed) return
      this.noLogStream = true
      this.startFirewallLog(gen)
    }
    // A router that doesn't know follow-only either refuses it or prints once and stops.
    this.logStream.done.then(fallBack, (err) => {
      if (err instanceof RouterOSError && err.kind === 'trap') fallBack()
    })
  }

  private async pollRouterLog(c: RouterOSClient): Promise<void> {
    const recs = await c.print('/log')
    const idOf = (r: ApiRecord): number => parseInt((r['.id'] ?? '').replace('*', ''), 16)
    const max = recs.reduce((m, r) => Math.max(m, idOf(r) || 0), -1)
    // The first poll only marks where we are. Ids start over when the router reboots.
    if (this.lastLogId >= 0 && max >= this.lastLogId) for (const r of recs) if (idOf(r) > this.lastLogId) this.onRouterLog(r)
    this.lastLogId = max
  }

  private onRouterLog(r: ApiRecord): void {
    if (r['.dead']) return
    const line = logLine(r, Date.now())
    if (this.logBacklog) this.logBacklog.push(line)
    else this.systemLog.add(line)
    if (!line.topics.includes('firewall')) return
    const message = r.message ?? ''
    const packet = parseFirewallMessage(message)
    const t = Date.now()
    if (this.fwFeed) {
      this.fwFeed.lines++
      this.fwFeed.lastAt = t
      if (!packet) this.fwFeed.unparsed++
    }
    if (!packet) {
      this.log.add({ t, type: 'firewall', action: 'log', protocol: '', src: '', dst: '', message })
      return
    }
    this.log.add({ t, ...this.firewallRecord(packet, message) })
  }

  /** A firewall log line as a record: the packet, the rule that logged it and the names of both ends. */
  private firewallRecord(packet: FirewallPacket, message: string): Omit<NewLogEntry, 't'> {
    const match = matchRule(this.rules, packet.chain, packet.prefix)
    return {
      type: 'firewall',
      ...packet,
      action: match.action,
      rule: match.rule,
      ruleNumber: match.ruleNumber,
      srcName: this.nameForIp(packet.src, false),
      dstName: this.nameForIp(packet.dst, true),
      message
    }
  }

  private loop(gen: number, interval: () => number, fn: (c: RouterOSClient) => Promise<void>): void {
    const run = async (): Promise<void> => {
      const c = this.client
      if (gen !== this.generation || !c || c.isClosed) return
      try {
        await fn(c)
      } catch (err) {
        if (c.isClosed) return
        console.warn(`[${this.id}]`, (err as Error).message)
      }
      if (gen !== this.generation) return
      const t = setTimeout(() => {
        this.timers.delete(t)
        void run()
      }, interval())
      this.timers.add(t)
    }
    void run()
  }

  private stopLoops(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private async loadSystem(c: RouterOSClient): Promise<void> {
    const [ident, res, rb] = await Promise.all([
      c.print('/system/identity'),
      c.print('/system/resource'),
      c.print('/system/routerboard').catch(() => [] as ApiRecord[])
    ])
    const r = res[0] ?? {}
    const b = rb[0] ?? {}
    this.system = {
      identity: ident[0]?.name ?? '',
      boardName: r['board-name'] ?? '',
      model: b.model,
      serialNumber: b['serial-number'],
      firmware: b['current-firmware'],
      version: r.version ?? '',
      architecture: r['architecture-name'] ?? '',
      cpu: r.cpu ?? '',
      cpuCount: num(r['cpu-count'], 1),
      cpuFrequencyMhz: num(r['cpu-frequency'])
    }
  }

  private async pollResource(c: RouterOSClient): Promise<void> {
    const [res, healthRecs] = await Promise.all([
      c.print('/system/resource'),
      this.noHealth
        ? Promise.resolve([] as ApiRecord[])
        : c.print('/system/health').catch((err) => {
            if (err instanceof RouterOSError && err.kind === 'trap') this.noHealth = true
            return [] as ApiRecord[]
          })
    ])
    const r = res[0] ?? {}
    this.health = parseHealth(healthRecs)
    const memTotal = num(r['total-memory'])
    const diskTotal = num(r['total-hdd-space'])
    const sample: ResourceSample = {
      t: Date.now(),
      cpuLoad: num(r['cpu-load']),
      memTotal,
      memUsed: memTotal - num(r['free-memory']),
      diskTotal,
      diskUsed: diskTotal - num(r['free-hdd-space']),
      uptimeSec: parseDuration(r.uptime),
      temperature: primaryTemperature(this.health)
    }
    if (this.system && r.version) this.system.version = r.version
    pushCapped(this.history, sample, HISTORY_LEN)
    this.emitSummary()
    if (this.focused) this.emitOverview()
  }

  private async pollInterfaces(c: RouterOSClient): Promise<void> {
    const recs = await c.print('/interface')
    const now = Date.now()
    const seen = new Set<string>()
    this.interfaces = recs.map((r) => {
      const name = r.name ?? r['.id']
      seen.add(name)
      const rxBytes = num(r['rx-byte'])
      const txBytes = num(r['tx-byte'])
      const prev = this.ifPrev.get(name)
      let rxBps = 0
      let txBps = 0
      if (prev && now > prev.t) {
        const dt = (now - prev.t) / 1000
        rxBps = Math.max(0, ((rxBytes - prev.rx) * 8) / dt)
        txBps = Math.max(0, ((txBytes - prev.tx) * 8) / dt)
        let hist = this.ifHistory.get(name)
        if (!hist) this.ifHistory.set(name, (hist = []))
        pushCapped(hist, { t: now, rx: rxBps, tx: txBps }, IF_HISTORY_LEN)
      }
      this.ifPrev.set(name, { rx: rxBytes, tx: txBytes, t: now })
      return {
        id: r['.id'] ?? name,
        name,
        type: r.type ?? '',
        running: bool(r.running),
        disabled: bool(r.disabled),
        comment: r.comment || undefined,
        mac: r['mac-address'] || undefined,
        rxBps,
        txBps,
        rxBytes,
        txBytes,
        isWan: false,
        history: this.ifHistory.get(name) ?? []
      }
    })
    for (const name of this.ifHistory.keys()) if (!seen.has(name)) this.ifHistory.delete(name)
    const wan = this.wanInterface()
    for (const i of this.interfaces) i.isWan = this.wanNames.includes(i.name) || i.name === wan
    if (this.focused) this.host.emit({ type: 'interfaces', id: this.id, rows: this.interfaces })
  }

  private async pollConnections(c: RouterOSClient): Promise<void> {
    const path = '/ip/firewall/connection'
    let total: number | null = null
    if (!this.noCountOnly) {
      try {
        total = num((await c.command([`${path}/print`, '=count-only='])).done.ret)
      } catch (err) {
        if (!(err instanceof RouterOSError && err.kind === 'trap')) throw err
        this.noCountOnly = true
      }
    }

    if (total !== null && total > CONN_ROW_LIMIT) {
      if (!this.connThrottled) {
        this.connThrottled = true
        this.connBaseline = true
      }
      this.connTotal = total
      this.connections = []
      this.emitConnections()
      return
    }

    const recs = await this.printConnections(c, path)
    this.connThrottled = false
    const now = Date.now()
    const baseline = this.connBaseline
    const rows: ConnectionRow[] = []
    const current = new Map<string, Tracked>()
    for (const r of recs) {
      const id = r['.id']
      if (!id) continue
      const src = endpoint(r, 'src-address', 'src-port')
      const dst = endpoint(r, 'dst-address', 'dst-port')
      const key = `${r.protocol}|${formatEndpoint(src)}|${formatEndpoint(dst)}`
      let prev = this.tracked.get(id)
      if (prev && prev.key !== key) {
        this.log.add(sessionRecord(prev, true))
        prev = undefined
      }
      const row = this.toConnectionRow(r, src, dst, now, prev)
      const closing = row.tcpState === 'time-wait' || row.tcpState === 'close'
      rows.push(row)
      current.set(id, {
        row,
        seenAt: now,
        key,
        // Right after connecting, everything in the table was already open.
        startBefore: prev ? prev.startBefore : baseline,
        closingAt: prev?.closingAt ?? (closing ? now : undefined)
      })
    }
    // Gone since the last snapshot: they have ended. Right after (re)connecting we don't know when.
    for (const [id, prev] of this.tracked) if (!current.has(id)) this.log.add(sessionRecord(prev, baseline))

    this.tracked = current
    this.connBaseline = false
    this.connections = rows
    this.connTotal = total ?? rows.length
    this.emitConnections()
  }

  private async printConnections(c: RouterOSClient, path: string): Promise<ApiRecord[]> {
    if (this.noConnProplist) return c.print(path)
    try {
      return await c.print(path, { '.proplist': CONN_PROPLIST })
    } catch (err) {
      if (!(err instanceof RouterOSError && err.kind === 'trap')) throw err
      this.noConnProplist = true
      return c.print(path)
    }
  }

  private toConnectionRow(r: ApiRecord, src: Endpoint, dst: Endpoint, now: number, prev?: Tracked): ConnectionRow {
    const replySrc = endpoint(r, 'reply-src-address', 'reply-src-port')
    const replyDst = endpoint(r, 'reply-dst-address', 'reply-dst-port')
    let nat: NatInfo | undefined
    if (differs(replySrc, dst)) nat = { kind: 'dstnat', address: formatEndpoint(replySrc) }
    else if (differs(replyDst, src)) nat = { kind: 'srcnat', address: formatEndpoint(replyDst) }

    const txBytes = num(r['orig-bytes'])
    const rxBytes = num(r['repl-bytes'])
    let txBps = 0
    let rxBps = 0
    // After a long gap (reconnect) the router's own rate is closer to the truth than an average.
    if (prev && now > prev.seenAt && now - prev.seenAt < 30000 && (r['orig-bytes'] !== undefined || r['repl-bytes'] !== undefined)) {
      const dt = (now - prev.seenAt) / 1000
      txBps = Math.max(0, ((txBytes - prev.row.txBytes) * 8) / dt)
      rxBps = Math.max(0, ((rxBytes - prev.row.rxBytes) * 8) / dt)
    } else {
      txBps = num(r['orig-rate'])
      rxBps = num(r['repl-rate'])
    }

    return {
      id: r['.id'],
      protocol: r.protocol ?? '',
      srcAddress: src.ip,
      srcPort: src.port,
      dstAddress: dst.ip,
      dstPort: dst.port,
      srcName: this.nameForIp(src.ip, false),
      dstName: this.nameForIp(dst.ip, true),
      nat,
      tcpState: r['tcp-state'] || undefined,
      timeoutSec: parseDuration(r.timeout),
      txBytes,
      rxBytes,
      txBps,
      rxBps,
      fasttrack: bool(r.fasttrack),
      firstSeen: prev?.row.firstSeen ?? now
    }
  }

  private nameForIp(ip: string, useDns: boolean): string | undefined {
    if (!ip) return undefined
    if (this.routerIps.has(ip)) return this.system?.identity ? `${this.system.identity} (router)` : 'Router'
    const lease = this.leaseByIp.get(ip)
    if (lease) return lease.comment || lease.hostName || undefined
    return useDns ? this.dnsByIp.get(ip) : undefined
  }

  private async pollLeases(c: RouterOSClient): Promise<void> {
    let recs: ApiRecord[]
    try {
      recs = await c.print('/ip/dhcp-server/lease')
      this.leaseError = undefined
    } catch (err) {
      if (!(err instanceof RouterOSError && err.kind === 'trap')) throw err
      this.leaseError = err.message
      recs = []
    }
    const byIp = new Map<string, LeaseRow>()
    this.leases = recs.map((r) => {
      const row: LeaseRow = {
        id: r['.id'],
        address: r['active-address'] || r.address || '',
        mac: r['active-mac-address'] || r['mac-address'] || '',
        hostName: r['host-name'] || undefined,
        comment: r.comment || undefined,
        server: r.server || r['active-server'] || undefined,
        status: r.status || (bool(r.disabled) ? 'disabled' : 'waiting'),
        dynamic: bool(r.dynamic),
        disabled: bool(r.disabled),
        blocked: bool(r.blocked),
        expiresAfterSec: r['expires-after'] ? parseDuration(r['expires-after']) : undefined,
        lastSeenSec: r['last-seen'] && r['last-seen'] !== 'never' ? parseDuration(r['last-seen']) : undefined,
        clientId: r['client-id'] || undefined
      }
      if (row.address && (!byIp.has(row.address) || row.status === 'bound')) byIp.set(row.address, row)
      return row
    })
    this.leaseByIp = byIp
    if (this.focused) this.emitLeases()
  }

  /** Slow lookups: DNS cache (domain names), the router's own IPs, identity, WAN interface and firewall rules. */
  private async pollSlow(c: RouterOSClient): Promise<void> {
    const [dns, addrs, ident, members] = await Promise.all([
      c.print('/ip/dns/cache/all').catch(() => c.print('/ip/dns/cache').catch(() => [] as ApiRecord[])),
      c.print('/ip/address').catch(() => [] as ApiRecord[]),
      c.print('/system/identity').catch(() => [] as ApiRecord[]),
      c.print('/interface/list/member').catch(() => [] as ApiRecord[]),
      this.loadRules(c)
    ])

    // DNS: A records give ip → name. CNAME chains are followed backwards so we show
    // "www.youtube.com" rather than e.g. "youtube-ui.l.google.com".
    const aliasOf = new Map<string, string>()
    const byIp = new Map<string, string>()
    for (const r of dns) {
      const type = (r.type ?? 'A').toUpperCase()
      const data = r.data ?? r.address
      if (!r.name || !data) continue
      if (type === 'CNAME') aliasOf.set(data.replace(/\.$/, ''), r.name)
      else if ((type === 'A' || type === 'AAAA') && !byIp.has(data)) byIp.set(data, r.name)
    }
    for (const [ip, name] of byIp) {
      let n = name
      for (let i = 0; i < 6 && aliasOf.has(n); i++) n = aliasOf.get(n)!
      byIp.set(ip, n)
    }
    this.dnsByIp = byIp

    this.routerIps = new Set(addrs.map((a) => stripPrefix(a.address)).filter(Boolean))

    const identity = ident[0]?.name
    if (identity && this.system && identity !== this.system.identity) {
      this.system.identity = identity
      this.emitSummary()
    }

    let wan = members.filter((m) => m.list?.toUpperCase() === 'WAN' && !bool(m.disabled)).map((m) => m.interface)
    if (!wan.length) {
      const routes = await c.print('/ip/route', {}, ['?dst-address=0.0.0.0/0']).catch(() => [] as ApiRecord[])
      const active = routes.find((r) => bool(r.active)) ?? routes[0]
      // RouterOS 7: immediate-gw="1.2.3.4%ether1". RouterOS 6: gateway-status="1.2.3.4 reachable via ether1".
      const via =
        (active?.['immediate-gw'] ?? active?.['immediate-gateway'])?.split('%')[1] ??
        active?.['gateway-status']?.match(/via\s+(\S+)/)?.[1] ??
        (this.interfaces.some((i) => i.name === active?.gateway) ? active?.gateway : undefined)
      if (via) wan = [via]
    }
    this.wanNames = wan.filter(Boolean)
  }

  /** The firewall rules tell which action and rule a logged packet belongs to. */
  private async loadRules(c: RouterOSClient): Promise<void> {
    const tables = await Promise.all(RULE_TABLES.map((t) => c.print(`/ip/firewall/${t}`, { '.proplist': RULE_PROPLIST }).catch(() => null)))
    if (tables.every((t) => t === null)) return
    this.rules = tables.flatMap((recs, ti) =>
      (recs ?? []).map((r, index) => ({
        table: RULE_TABLES[ti],
        id: r['.id'] ?? '',
        index,
        chain: r.chain ?? '',
        action: r.action ?? '',
        prefix: r['log-prefix'] ?? '',
        comment: r.comment || undefined,
        match: describeMatch(r),
        log: bool(r.log),
        disabled: bool(r.disabled),
        dynamic: bool(r.dynamic),
        packets: r.packets !== undefined ? num(r.packets) : undefined
      }))
    )
  }

  /** For Firewall Logging: is the log arriving, and which filter and raw rules log. */
  async firewallStatus(): Promise<FirewallLogStatus> {
    const c = this.client
    const connected = !!c && !c.isClosed && this.status.state === 'connected'
    if (connected) await this.loadRules(c).catch(() => {})
    const feed = this.fwFeed
    return {
      connected,
      feed: feed?.feed,
      since: feed?.since,
      lines: feed?.lines ?? 0,
      unparsed: feed?.unparsed ?? 0,
      lastAt: feed?.lastAt,
      rules: this.rules
        .filter((r): r is FirewallRule & { table: 'filter' | 'raw' } => r.table === 'filter' || r.table === 'raw')
        .map((r) => ({
          id: r.id,
          table: r.table,
          number: r.index,
          chain: r.chain,
          action: r.action,
          comment: r.comment,
          match: r.match,
          log: r.log || r.action === 'log',
          prefix: r.prefix || undefined,
          disabled: r.disabled,
          dynamic: r.dynamic,
          packets: r.packets
        }))
    }
  }

  private wanInterface(): string | undefined {
    const candidates = this.wanNames.length
      ? this.interfaces.filter((i) => this.wanNames.includes(i.name))
      : this.interfaces.filter((i) => i.running && !['bridge', 'vlan', 'loopback'].includes(i.type))
    const ranked = [...candidates].sort((a, b) => Number(b.running) - Number(a.running) || b.rxBytes - a.rxBytes)
    return ranked[0]?.name
  }

  // ---------- Events to the UI ----------

  setFocused(focused: boolean): void {
    this.focused = focused
    if (!focused) return
    this.emitOverview()
    this.emitConnections()
    this.emitLeases()
    this.host.emit({ type: 'interfaces', id: this.id, rows: this.interfaces })
  }

  private emitSummary(): void {
    const last = this.history[this.history.length - 1]
    const summary: RouterSummary = {
      id: this.id,
      identity: this.system?.identity,
      cpuLoad: last?.cpuLoad,
      memPercent: last && last.memTotal ? (last.memUsed / last.memTotal) * 100 : undefined,
      temperature: last?.temperature,
      connections: this.connTotal
    }
    this.host.emit({ type: 'summary', summary })
  }

  private emitOverview(): void {
    const wan = this.wanInterface()
    const data: OverviewData = {
      system: this.system,
      history: this.history,
      health: this.health,
      wan: wan ? { name: wan, history: this.ifHistory.get(wan) ?? [] } : null,
      counts: {
        connections: this.connTotal,
        leasesBound: this.leases.filter((l) => l.status === 'bound').length,
        leasesTotal: this.leases.length,
        interfacesUp: this.interfaces.filter((i) => i.running && !i.disabled).length,
        interfacesTotal: this.interfaces.length
      }
    }
    this.host.emit({ type: 'overview', id: this.id, data })
  }

  private emitConnections(): void {
    if (!this.focused) return
    this.host.emit({ type: 'connections', id: this.id, rows: this.connections, total: this.connTotal, throttled: this.connThrottled })
  }

  private emitLeases(): void {
    this.host.emit({ type: 'leases', id: this.id, rows: this.leases, error: this.leaseError })
  }

  // ---------- Requests from the UI ----------

  /** The router's log as MikroViewer has kept it – the lines after `afterSeq`, oldest first. Works offline too. */
  async routerLog(afterSeq = 0): Promise<RouterLogEntry[]> {
    await this.systemLog.ready
    return this.systemLog.since(afterSeq).map((l) => {
      const packet = l.topics.includes('firewall') ? parseFirewallMessage(l.message) : null
      return { id: l.seq, t: l.t, topics: l.topics, message: l.message, ...(packet ? { firewall: this.firewallRecord(packet, l.message) } : {}) }
    })
  }

  get identity(): string | undefined {
    return this.system?.identity
  }
}

/** One-off connection for "Test connection" in the router dialog. */
export async function testConnection(creds: SessionCredentials): Promise<TestResult & { fingerprint?: string }> {
  let client: RouterOSClient | null = null
  try {
    client = await RouterOSClient.connect({ ...creds, connectTimeoutMs: 6000, commandTimeoutMs: 8000 })
    const [ident, res] = await Promise.all([client.print('/system/identity'), client.print('/system/resource')])
    return {
      ok: true,
      identity: ident[0]?.name,
      version: res[0]?.version,
      board: res[0]?.['board-name'],
      fingerprint: client.fingerprint
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    client?.close()
  }
}
