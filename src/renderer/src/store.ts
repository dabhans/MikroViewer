import type {
  ConnectionLogEntry,
  ConnectionRow,
  InterfaceRow,
  LeaseRow,
  OverviewData,
  RouterProfile,
  RouterSummary,
  SessionEvent,
  SessionStatus
} from '../../shared/types'

export const LOG_MAX = 20000

/** Data for the router currently shown (the main process only sends heavy data for that one). */
export interface RouterData {
  id: string | null
  overview?: OverviewData
  connections?: { rows: ConnectionRow[]; total: number; throttled: boolean }
  connlog: ConnectionLogEntry[]
  leases?: { rows: LeaseRow[]; error?: string }
  interfaces?: InterfaceRow[]
}

export interface State {
  loaded: boolean
  profiles: RouterProfile[]
  statuses: Record<string, SessionStatus>
  summaries: Record<string, RouterSummary>
  selectedId: string | null
  data: RouterData
}

export type Action =
  | { type: 'init'; profiles: RouterProfile[]; statuses: SessionStatus[]; selectedId: string | null }
  | { type: 'select'; id: string | null }
  | { type: 'event'; event: SessionEvent }

export const initialState: State = {
  loaded: false,
  profiles: [],
  statuses: {},
  summaries: {},
  selectedId: null,
  data: { id: null, connlog: [] }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'init':
      return {
        ...state,
        loaded: true,
        profiles: action.profiles,
        // Statuses already received as events are newer than the ones from the startup call.
        statuses: { ...Object.fromEntries(action.statuses.map((s) => [s.id, s])), ...state.statuses },
        selectedId: action.selectedId,
        data: { id: action.selectedId, connlog: [] }
      }
    case 'select':
      if (action.id === state.selectedId) return state
      return { ...state, selectedId: action.id, data: { id: action.id, connlog: [] } }
    case 'event':
      return applyEvent(state, action.event)
  }
}

function applyEvent(state: State, e: SessionEvent): State {
  switch (e.type) {
    case 'status': {
      const statuses = { ...state.statuses, [e.status.id]: e.status }
      // Clear the shown data when the connection is closed for good, so no stale numbers are shown.
      if (e.status.id === state.data.id && (e.status.state === 'disconnected' || e.status.state === 'error')) {
        return { ...state, statuses, data: { id: state.data.id, connlog: state.data.connlog } }
      }
      return { ...state, statuses }
    }
    case 'summary':
      return { ...state, summaries: { ...state.summaries, [e.summary.id]: e.summary } }
    case 'profiles': {
      const ids = new Set(e.profiles.map((p) => p.id))
      const selectedId = state.selectedId && ids.has(state.selectedId) ? state.selectedId : (e.profiles[0]?.id ?? null)
      const data = selectedId === state.data.id ? state.data : { id: selectedId, connlog: [] }
      return { ...state, profiles: e.profiles, selectedId, data }
    }
  }
  if (e.id !== state.data.id) return state
  const d = state.data
  switch (e.type) {
    case 'overview':
      return { ...state, data: { ...d, overview: e.data } }
    case 'connections':
      return { ...state, data: { ...d, connections: { rows: e.rows, total: e.total, throttled: e.throttled } } }
    case 'connlog': {
      let connlog = e.reset ? [...e.entries] : d.connlog.concat(e.entries)
      if (connlog.length > LOG_MAX) connlog = connlog.slice(connlog.length - LOG_MAX)
      return { ...state, data: { ...d, connlog } }
    }
    case 'leases':
      return { ...state, data: { ...d, leases: { rows: e.rows, error: e.error } } }
    case 'interfaces':
      return { ...state, data: { ...d, interfaces: e.rows } }
  }
}

export function displayName(p: RouterProfile, summary?: RouterSummary): string {
  return p.name || summary?.identity || p.host
}
