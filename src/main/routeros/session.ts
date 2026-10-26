// One RouterSession per router profile. It keeps the API connection open, polls data in the
// background, reconnects automatically and builds the connection log by diffing snapshots.

import { RouterOSClient, RouterOSError, type ApiRecord } from './client'
import { bool, num, parseDuration, parseHealth, primaryTemperature, splitHostPort, stripPrefix } from './parse'
import type {
  ConnectionLogEntry,
  ConnectionRow,
  HealthSensor,
  InterfaceRow,
  LeaseRow,
  OverviewData,
  ResourceSample,
  RouterLogEntry,
  RouterSummary,
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
const LOG_MAX = 20000
/** Above this many entries the connection table is no longer fetched (to spare the router's CPU). */
const CONN_ROW_LIMIT = 20000

const CONN_PROPLIST = [
  '.id',
  'protocol',
  'src-address',
  'dst-address',
  'reply-src-address',
  'reply-dst-address',
  'tcp-state',
  'timeout',
  'orig-bytes',
  'repl-bytes',
  'orig-rate',
  'repl-rate',
  'fasttrack'
].join(',')

function connectionInterval(total: number): number {
  if (total <= 2000) return 3000
  if (total <= 8000) return 6000
  return 15000
}

function pushCapped<T>(arr: T[], item: T, max: number): void {
  arr.push(item)
  if (arr.length > max) arr.splice(0, arr.length - max)
}

interface PrevConnection {
  row: ConnectionRow
  seenAt: number
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
  private connPrev = new Map<string, PrevConnection>()
  private connBaseline = new Set<string>()
  private connHasBaseline = false
  private noCountOnly = false

  private log: ConnectionLogEntry[] = []
  private logSeq = 0
  private logPending: ConnectionLogEntry[] = []

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
    private readonly host: SessionHost
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
      this.connHasBaseline = false
      this.connPrev.clear()
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
        this.connHasBaseline = false
        this.connPrev.clear()
      }
      this.connTotal = total
      this.connections = []
      this.emitConnections()
      return
    }

    const recs = await c.print(path, { '.proplist': CONN_PROPLIST })
    if (this.connThrottled) {
      this.connThrottled = false
      this.connHasBaseline = false
      this.connPrev.clear()
    }
    const now = Date.now()
    const rows: ConnectionRow[] = []
    const current = new Map<string, PrevConnection>()
    for (const r of recs) {
      const id = r['.id']
      if (!id) continue
      const row = this.toConnectionRow(r, now)
      rows.push(row)
      current.set(id, { row, seenAt: now })
    }

    if (this.connHasBaseline) {
      for (const [id, cur] of current) if (!this.connPrev.has(id)) this.logEvent('open', cur.row, now)
      for (const [id, prev] of this.connPrev) {
        if (current.has(id)) continue
        this.logEvent('close', prev.row, now, {
          durationSec: Math.max(0, (prev.seenAt - prev.row.firstSeen) / 1000),
          durationApprox: this.connBaseline.has(id)
        })
        this.connBaseline.delete(id)
      }
    } else {
      this.connBaseline = new Set(current.keys())
      this.connHasBaseline = true
    }
    this.connPrev = current
    this.connections = rows
    this.connTotal = total ?? rows.length
    this.emitConnections()
  }

  private toConnectionRow(r: ApiRecord, now: number): ConnectionRow {
    const id = r['.id']
    const src = splitHostPort(r['src-address'])
    const dst = splitHostPort(r['dst-address'])
    const replySrc = r['reply-src-address']
    const replyDst = r['reply-dst-address']
    let nat: ConnectionRow['nat']
    if (replySrc && replySrc !== r['dst-address']) nat = { kind: 'dstnat', address: replySrc }
    else if (replyDst && replyDst !== r['src-address']) nat = { kind: 'srcnat', address: replyDst }

    const txBytes = num(r['orig-bytes'])
    const rxBytes = num(r['repl-bytes'])
    const prev = this.connPrev.get(id)
    let txBps = 0
    let rxBps = 0
    if (prev && now > prev.seenAt && (r['orig-bytes'] !== undefined || r['repl-bytes'] !== undefined)) {
      const dt = (now - prev.seenAt) / 1000
      txBps = Math.max(0, ((txBytes - prev.row.txBytes) * 8) / dt)
      rxBps = Math.max(0, ((rxBytes - prev.row.rxBytes) * 8) / dt)
    } else {
      txBps = num(r['orig-rate'])
      rxBps = num(r['repl-rate'])
    }

    return {
      id,
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

  private logEvent(event: 'open' | 'close', row: ConnectionRow, t: number, extra: Partial<ConnectionLogEntry> = {}): void {
    const entry: ConnectionLogEntry = {
      seq: ++this.logSeq,
      t,
      event,
      protocol: row.protocol,
      srcAddress: row.srcAddress,
      srcPort: row.srcPort,
      dstAddress: row.dstAddress,
      dstPort: row.dstPort,
      srcName: row.srcName,
      dstName: row.dstName,
      nat: row.nat,
      tcpState: row.tcpState,
      ...(event === 'close' ? { txBytes: row.txBytes, rxBytes: row.rxBytes } : {}),
      ...extra
    }
    pushCapped(this.log, entry, LOG_MAX)
    if (this.focused) this.logPending.push(entry)
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

  /** Slow lookups: DNS cache (domain names), the router's own IPs, identity and the WAN interface. */
  private async pollSlow(c: RouterOSClient): Promise<void> {
    const [dns, addrs, ident, members] = await Promise.all([
      c.print('/ip/dns/cache/all').catch(() => c.print('/ip/dns/cache').catch(() => [] as ApiRecord[])),
      c.print('/ip/address').catch(() => [] as ApiRecord[]),
      c.print('/system/identity').catch(() => [] as ApiRecord[]),
      c.print('/interface/list/member').catch(() => [] as ApiRecord[])
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
    this.logPending = []
    if (!focused) return
    this.emitOverview()
    this.emitConnections(true)
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

  private emitConnections(fullLog = false): void {
    if (!this.focused) return
    this.host.emit({ type: 'connections', id: this.id, rows: this.connections, total: this.connTotal, throttled: this.connThrottled })
    if (fullLog) {
      this.host.emit({ type: 'connlog', id: this.id, entries: this.log, reset: true })
      this.logPending = []
    } else if (this.logPending.length) {
      this.host.emit({ type: 'connlog', id: this.id, entries: this.logPending, reset: false })
      this.logPending = []
    }
  }

  private emitLeases(): void {
    this.host.emit({ type: 'leases', id: this.id, rows: this.leases, error: this.leaseError })
  }

  // ---------- Requests from the UI ----------

  async routerLog(): Promise<RouterLogEntry[]> {
    const c = this.client
    if (!c || c.isClosed) throw new Error('Not connected to the router')
    const recs = await c.print('/log')
    return recs.map((r, i) => ({
      id: r['.id'] ?? String(i),
      time: r.time ?? '',
      topics: (r.topics ?? '').split(',').filter(Boolean),
      message: r.message ?? ''
    }))
  }

  clearLog(): void {
    this.log = []
    this.logPending = []
    if (this.focused) this.host.emit({ type: 'connlog', id: this.id, entries: [], reset: true })
  }

  get identity(): string | undefined {
    return this.system?.identity
  }

  connectionLogCsv(): string {
    const esc = (v: unknown): string => {
      const s = v === undefined || v === null ? '' : String(v)
      return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = [
      'Time',
      'Event',
      'Protocol',
      'Source',
      'Source name',
      'Destination',
      'Destination name',
      'Destination port',
      'NAT',
      'Sent (bytes)',
      'Received (bytes)',
      'Duration (s)'
    ]
    const lines = [header.join(',')]
    for (const e of this.log) {
      lines.push(
        [
          new Date(e.t).toISOString(),
          e.event,
          e.protocol,
          e.srcAddress,
          e.srcName,
          e.dstAddress,
          e.dstName,
          e.dstPort,
          e.nat ? `${e.nat.kind} ${e.nat.address}` : '',
          e.txBytes,
          e.rxBytes,
          e.durationSec !== undefined ? Math.round(e.durationSec) : ''
        ]
          .map(esc)
          .join(',')
      )
    }
    return '﻿' + lines.join('\r\n')
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
