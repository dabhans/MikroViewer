// Types shared between the main process (router connections) and the UI.

export interface RouterProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  useTls: boolean
  autoConnect: boolean
  hasPassword: boolean
  tlsFingerprint?: string
}

export interface ProfileInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  /** undefined = keep the stored password */
  password?: string
  useTls: boolean
  autoConnect: boolean
  /** Forget the stored TLS certificate (after the router got a new one). */
  resetFingerprint?: boolean
}

export interface TestResult {
  ok: boolean
  identity?: string
  version?: string
  board?: string
  error?: string
}

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface SessionStatus {
  id: string
  state: SessionState
  error?: string
  connectedAt?: number
  nextRetryAt?: number
}

export interface SystemInfo {
  identity: string
  boardName: string
  model?: string
  serialNumber?: string
  firmware?: string
  version: string
  architecture: string
  cpu: string
  cpuCount: number
  cpuFrequencyMhz: number
}

export interface ResourceSample {
  t: number
  cpuLoad: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  uptimeSec: number
  temperature?: number
}

export interface HealthSensor {
  name: string
  label: string
  value: number | string
  unit: string
}

/** Lightweight summary sent for every connected router (used in the device list). */
export interface RouterSummary {
  id: string
  identity?: string
  cpuLoad?: number
  memPercent?: number
  temperature?: number
  connections?: number
}

/** Traffic in bits per second. rx = into the interface, tx = out of it. */
export interface TrafficPoint {
  t: number
  rx: number
  tx: number
}

export interface InterfaceRow {
  id: string
  name: string
  type: string
  running: boolean
  disabled: boolean
  comment?: string
  mac?: string
  rxBps: number
  txBps: number
  rxBytes: number
  txBytes: number
  isWan: boolean
  history: TrafficPoint[]
}

export interface OverviewData {
  system: SystemInfo | null
  history: ResourceSample[]
  health: HealthSensor[]
  wan: { name: string; history: TrafficPoint[] } | null
  counts: {
    connections: number
    leasesBound: number
    leasesTotal: number
    interfacesUp: number
    interfacesTotal: number
  }
}

export interface NatInfo {
  /** srcnat: the public address used outbound. dstnat: the internal target (port forward). */
  kind: 'srcnat' | 'dstnat'
  address: string
}

export interface ConnectionRow {
  id: string
  protocol: string
  srcAddress: string
  srcPort?: number
  dstAddress: string
  dstPort?: number
  srcName?: string
  dstName?: string
  nat?: NatInfo
  tcpState?: string
  timeoutSec: number
  /** Bytes sent from the source to the destination. */
  txBytes: number
  /** Bytes sent from the destination back to the source. */
  rxBytes: number
  txBps: number
  rxBps: number
  fasttrack: boolean
  firstSeen: number
}

// ---------- Logs ----------

export type LogType = 'session' | 'firewall'
export type LogAction = 'accept' | 'drop' | 'reject' | 'nat' | 'log'

/** How a session ended. "lost": it closed while MikroViewer wasn't connected, some time after `t`. */
export type SessionEndReason = 'fin' | 'reset' | 'aged-out' | 'lost'

/**
 * One log record. Sessions come from the connection table and are written when the connection
 * closes, as a firewall's traffic log does. Firewall records come from rules with logging enabled.
 */
export interface LogEntry {
  id: number
  /** When the session ended, or when the packet was logged (ms). */
  t: number
  type: LogType
  action: LogAction
  protocol: string
  src: string
  srcPort?: number
  srcName?: string
  srcMac?: string
  dst: string
  dstPort?: number
  dstName?: string
  nat?: NatInfo

  // Sessions
  start?: number
  /** The connection already existed when MikroViewer started watching – it began at or before `start`. */
  startBefore?: boolean
  endReason?: SessionEndReason
  durationSec?: number
  /** The duration is a minimum (the start or the end wasn't seen). */
  approx?: boolean
  txBytes?: number
  rxBytes?: number

  // Firewall
  chain?: string
  inInterface?: string
  outInterface?: string
  /** Rule comment, or its log prefix. */
  rule?: string
  prefix?: string
  /** e.g. "filter #5" */
  ruleNumber?: string
  tcpFlags?: string
  connState?: string
  length?: number
  icmp?: string
  message?: string
}

export interface LogQuery {
  routerId: string
  query: string
  from: number
  to: number
  limit: number
}

export interface LogHistogram {
  from: number
  bucketMs: number
  counts: number[]
  /** Dropped or rejected per bucket (part of counts). */
  blocked: number[]
}

export interface LogQueryResult {
  /** Newest first, at most `limit`. */
  entries: LogEntry[]
  total: number
  histogram: LogHistogram
  from: number
  to: number
  tookMs: number
  error?: string
}

export interface LogExportRequest {
  routerId: string
  query: string
  from: number
  to: number
}

/** A filter or raw rule, for checking which rules log. */
export interface FirewallRuleInfo {
  /** RouterOS internal id, e.g. "*1A". */
  id: string
  table: 'filter' | 'raw'
  /** Position in the table, as RouterOS numbers the rules. */
  number: number
  chain: string
  action: string
  comment?: string
  /** What the rule matches, e.g. "src 10.35.0.0/24, dst 10.255.0.0/24". */
  match: string
  log: boolean
  prefix?: string
  disabled: boolean
  dynamic: boolean
  packets?: number
}

export interface FirewallLogStatus {
  connected: boolean
  /** How the router's log is read: streamed, or polled on routers that can't stream. */
  feed?: 'stream' | 'poll'
  since?: number
  /** Firewall lines received since connecting. */
  lines: number
  unparsed: number
  lastAt?: number
  rules: FirewallRuleInfo[]
}

export interface RouterLogEntry {
  /** Increases with every line MikroViewer keeps. */
  id: number
  /** When the router wrote it (ms). */
  t: number
  topics: string[]
  message: string
  /** A firewall line, read like the firewall records in Logs. */
  firewall?: Omit<LogEntry, 'id' | 't'>
}

export interface LeaseRow {
  id: string
  address: string
  mac: string
  hostName?: string
  comment?: string
  server?: string
  status: string
  dynamic: boolean
  disabled: boolean
  blocked: boolean
  expiresAfterSec?: number
  lastSeenSec?: number
  clientId?: string
}

// ---------- Settings and updates ----------

export type Theme = 'light' | 'dark'

export interface Settings {
  theme: Theme
  logRetentionDays: number
  /** The most the log files may take up, in MB (0: no limit). */
  logMaxMB: number
}

export interface AppInfo {
  version: string
  /** The portable exe can't update itself – it gets a download link instead. */
  portable: boolean
  packaged: boolean
}

export type UpdateState = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  version?: string
  percent?: number
  error?: string
  /** Release page, for the portable version. */
  url?: string
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'summary'; summary: RouterSummary }
  | { type: 'profiles'; profiles: RouterProfile[] }
  | { type: 'overview'; id: string; data: OverviewData }
  | { type: 'connections'; id: string; rows: ConnectionRow[]; total: number; throttled: boolean }
  | { type: 'leases'; id: string; rows: LeaseRow[]; error?: string }
  | { type: 'interfaces'; id: string; rows: InterfaceRow[] }
  | { type: 'log'; id: string; added: LogEntry[] }
  | { type: 'update'; status: UpdateStatus }
  /** The mouse's back/forward buttons (Windows sends them to the window, not the page). */
  | { type: 'navigate'; direction: 'back' | 'forward' }

export interface MikroApi {
  platform: string
  initialTheme: Theme
  listProfiles(): Promise<RouterProfile[]>
  saveProfile(input: ProfileInput): Promise<RouterProfile>
  deleteProfile(id: string): Promise<void>
  testProfile(input: ProfileInput): Promise<TestResult>
  getStatuses(): Promise<SessionStatus[]>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  focus(id: string | null): void
  /** The router's log lines after `afterSeq` (an entry's id). */
  routerLog(id: string, afterSeq?: number): Promise<RouterLogEntry[]>
  firewallStatus(id: string): Promise<FirewallLogStatus>
  queryLogs(q: LogQuery): Promise<LogQueryResult>
  exportLogs(req: LogExportRequest): Promise<{ saved: boolean; path?: string }>
  logStorage(): Promise<{ bytes: number }>
  deleteLogs(): Promise<void>
  openLogFolder(): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  appInfo(): Promise<AppInfo>
  updateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  openExternal(url: string): Promise<void>
  onEvent(cb: (event: SessionEvent) => void): () => void
}
