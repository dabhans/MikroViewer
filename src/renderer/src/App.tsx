import { useCallback, useEffect, useReducer, useState } from 'react'
import type { ProfileInput, RouterProfile, RouterSummary, SessionStatus } from '../../shared/types'
import { displayName, initialState, reducer, type RouterData } from './store'
import { TABS, isTab, type Tab } from './tabs'
import { Modal, Panel } from './components/Controls'
import { RouterForm, cleanError } from './components/RouterForm'
import { OverviewView } from './views/Overview'
import { ConnectionsView } from './views/Connections'
import { ConnectionLogView } from './views/ConnectionLog'
import { DhcpView } from './views/Dhcp'
import { InterfacesView } from './views/Interfaces'
import { RouterLogView } from './views/RouterLog'

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // not critical – only a convenience
  }
}

function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, active])
  return now
}

const STATE_LABEL: Record<SessionStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  error: 'Error'
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = storageGet('mv.tab')
    return isTab(saved) ? saved : 'overview'
  })
  const [connSearch, setConnSearch] = useState('')
  const [editing, setEditing] = useState<RouterProfile | 'new' | null>(null)

  useEffect(() => {
    const off = window.api.onEvent((event) => dispatch({ type: 'event', event }))
    void Promise.all([window.api.listProfiles(), window.api.getStatuses()]).then(([profiles, statuses]) => {
      const saved = storageGet('mv.selected')
      const selectedId = profiles.find((p) => p.id === saved)?.id ?? profiles[0]?.id ?? null
      dispatch({ type: 'init', profiles, statuses, selectedId })
    })
    return off
  }, [])

  useEffect(() => {
    if (!state.loaded) return
    window.api.focus(state.selectedId)
    if (state.selectedId) storageSet('mv.selected', state.selectedId)
  }, [state.selectedId, state.loaded])

  const setTab = useCallback((t: Tab, search?: string) => {
    setTabState(t)
    storageSet('mv.tab', t)
    if (search !== undefined) setConnSearch(search)
  }, [])

  const select = (id: string): void => {
    if (id !== state.selectedId) setConnSearch('')
    dispatch({ type: 'select', id })
  }

  const saveProfile = async (input: ProfileInput): Promise<string | undefined> => {
    try {
      const p = await window.api.saveProfile(input)
      setEditing(null)
      if (!input.id) {
        dispatch({ type: 'select', id: p.id })
        void window.api.connect(p.id)
      }
      return undefined
    } catch (err) {
      return cleanError(err)
    }
  }

  const deleteProfile = async (id: string): Promise<void> => {
    await window.api.deleteProfile(id)
    setEditing(null)
  }

  const profile = state.profiles.find((p) => p.id === state.selectedId)
  const status: SessionStatus | undefined = profile ? (state.statuses[profile.id] ?? { id: profile.id, state: 'disconnected' }) : undefined
  const live = !!status && (status.state === 'connected' || (status.state === 'reconnecting' && !!state.data.overview))
  const showConnections = useCallback((ip: string) => setTab('connections', ip), [setTab])

  return (
    <div className="app">
      <Header profile={profile} status={status} summary={profile && state.summaries[profile.id]} data={state.data} onEdit={() => profile && setEditing(profile)} />

      <nav className="nav">
        <div className="nav-section">
          Routers
          <button className="nav-add" title="Add router" onClick={() => setEditing('new')}>
            +
          </button>
        </div>
        {state.loaded && state.profiles.length === 0 && <div className="nav-empty">None</div>}
        {state.profiles.map((p) => {
          const st = state.statuses[p.id]?.state ?? 'disconnected'
          const sum = state.summaries[p.id]
          return (
            <button
              key={p.id}
              className={`nav-item${p.id === state.selectedId ? ' active' : ''}`}
              onClick={() => select(p.id)}
              onDoubleClick={() => setEditing(p)}
              title={`${p.host}:${p.port} – ${STATE_LABEL[st]}`}
            >
              <span className={`dot ${st}`} />
              <span className="label">{displayName(p, sum)}</span>
              {st === 'connected' && sum?.cpuLoad !== undefined && <span className="aside">{Math.round(sum.cpuLoad)} %</span>}
            </button>
          )
        })}

        <div className="nav-section">Monitor</div>
        {TABS.map((t) => (
          <button key={t.id} className={`nav-item${tab === t.id && live ? ' active' : ''}`} onClick={() => setTab(t.id)} disabled={!live}>
            <span className="label">{t.label}</span>
          </button>
        ))}
      </nav>

      <main className="main">
        {!state.loaded ? null : !profile || !status ? (
          <div className="empty-page">
            <Panel title="No routers configured">
              <button className="btn primary" onClick={() => setEditing('new')}>
                Add Router
              </button>
            </Panel>
          </div>
        ) : live ? (
          <>
            {status.state === 'reconnecting' && <ReconnectNotice status={status} profileId={profile.id} />}
            {tab === 'overview' && <OverviewView data={state.data} onNavigate={setTab} />}
            {tab === 'connections' && <ConnectionsView data={state.data} search={connSearch} onSearch={setConnSearch} />}
            {tab === 'connlog' && <ConnectionLogView data={state.data} />}
            {tab === 'dhcp' && <DhcpView data={state.data} onShowConnections={showConnections} />}
            {tab === 'interfaces' && <InterfacesView data={state.data} />}
            {tab === 'log' && <RouterLogView routerId={profile.id} />}
          </>
        ) : (
          <ConnectPanel profile={profile} status={status} summary={state.summaries[profile.id]} onEdit={() => setEditing(profile)} />
        )}
      </main>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Router' : `Edit Router – ${displayName(editing, state.summaries[editing.id])}`} onClose={() => setEditing(null)}>
          <RouterForm
            key={editing === 'new' ? 'new' : editing.id}
            profile={editing === 'new' ? undefined : editing}
            onSave={saveProfile}
            onCancel={() => setEditing(null)}
            onDelete={editing === 'new' ? undefined : () => deleteProfile(editing.id)}
          />
        </Modal>
      )}
    </div>
  )
}

interface HeaderProps {
  profile?: RouterProfile
  status?: SessionStatus
  summary?: RouterSummary
  data: RouterData
  onEdit: () => void
}

function Header({ profile, status, summary, data, onEdit }: HeaderProps) {
  const sys = data.overview?.system
  const connected = status?.state === 'connected' || status?.state === 'reconnecting'
  return (
    <header className="header">
      <span className="product">MikroViewer</span>
      {profile && status && (
        <>
          <span className="device">{displayName(profile, summary)}</span>
          <span className="state">
            <span className={`dot ${status.state}`} />
            {STATE_LABEL[status.state]}
          </span>
          <span className="meta">{[`${profile.host}:${profile.port}`, sys?.boardName, sys?.version && `RouterOS ${sys.version}`].filter(Boolean).join('   ·   ')}</span>
          <span className="spacer" />
          <button className="hbtn" onClick={onEdit}>
            Edit
          </button>
          {connected && (
            <button className="hbtn" onClick={() => void window.api.disconnect(profile.id)}>
              Disconnect
            </button>
          )}
        </>
      )}
    </header>
  )
}

function ReconnectNotice({ status, profileId }: { status: SessionStatus; profileId: string }) {
  const now = useNow(1000, !!status.nextRetryAt)
  const secs = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0
  return (
    <div className="notice" style={{ margin: '10px 12px 0' }}>
      <span>
        Connection lost{status.error ? `: ${status.error}` : ''}. {secs > 0 ? `Retrying in ${secs} s.` : 'Reconnecting…'}
      </span>
      <span className="spacer" />
      <button className="btn" onClick={() => void window.api.disconnect(profileId)}>
        Stop
      </button>
    </div>
  )
}

function ConnectPanel({ profile, status, summary, onEdit }: { profile: RouterProfile; status: SessionStatus; summary?: RouterSummary; onEdit: () => void }) {
  const busy = status.state === 'connecting' || status.state === 'reconnecting'
  const now = useNow(1000, status.state === 'reconnecting')
  const secs = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0

  return (
    <div className="empty-page">
      <Panel title={displayName(profile, summary)}>
        <table className="props" style={{ marginBottom: 10 }}>
          <tbody>
            <tr>
              <td>Address</td>
              <td>
                {profile.host}:{profile.port}
                {profile.useTls ? ' (TLS)' : ''}
              </td>
            </tr>
            <tr>
              <td>Status</td>
              <td>{status.state === 'reconnecting' && secs > 0 ? `Retrying in ${secs} s` : STATE_LABEL[status.state]}</td>
            </tr>
          </tbody>
        </table>
        {status.error && (
          <div className="notice error" style={{ marginBottom: 10 }}>
            {status.error}
          </div>
        )}
        <div className="toolbar">
          {busy ? (
            <button className="btn" onClick={() => void window.api.disconnect(profile.id)}>
              Cancel
            </button>
          ) : (
            <button className="btn primary" onClick={() => void window.api.connect(profile.id)}>
              Connect
            </button>
          )}
          <button className="btn" onClick={onEdit}>
            Edit
          </button>
        </div>
      </Panel>
    </div>
  )
}
