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

export interface ConnectionRow {
  id: string
  protocol: string
  srcAddress: string
  srcPort?: number
  dstAddress: string
  dstPort?: number
  srcName?: string
  dstName?: string
  /** srcnat: the public address used outbound. dstnat: the internal target (port forward). */
  nat?: { kind: 'srcnat' | 'dstnat'; address: string }
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

export interface ConnectionLogEntry {
  seq: number
  t: number
  event: 'open' | 'close'
  protocol: string
  srcAddress: string
  srcPort?: number
  dstAddress: string
  dstPort?: number
  srcName?: string
  dstName?: string
  nat?: { kind: 'srcnat' | 'dstnat'; address: string }
  tcpState?: string
  txBytes?: number
  rxBytes?: number
  durationSec?: number
  /** The connection already existed when MikroViewer connected – the duration is a minimum. */
  durationApprox?: boolean
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

export interface RouterLogEntry {
  id: string
  time: string
  topics: string[]
  message: string
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'summary'; summary: RouterSummary }
  | { type: 'profiles'; profiles: RouterProfile[] }
  | { type: 'overview'; id: string; data: OverviewData }
  | { type: 'connections'; id: string; rows: ConnectionRow[]; total: number; throttled: boolean }
  | { type: 'connlog'; id: string; entries: ConnectionLogEntry[]; reset: boolean }
  | { type: 'leases'; id: string; rows: LeaseRow[]; error?: string }
  | { type: 'interfaces'; id: string; rows: InterfaceRow[] }

export interface MikroApi {
  platform: string
  listProfiles(): Promise<RouterProfile[]>
  saveProfile(input: ProfileInput): Promise<RouterProfile>
  deleteProfile(id: string): Promise<void>
  testProfile(input: ProfileInput): Promise<TestResult>
  getStatuses(): Promise<SessionStatus[]>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  focus(id: string | null): void
  routerLog(id: string): Promise<RouterLogEntry[]>
  clearConnectionLog(id: string): Promise<void>
  exportConnectionLog(id: string): Promise<{ saved: boolean; path?: string }>
  onEvent(cb: (event: SessionEvent) => void): () => void
}
