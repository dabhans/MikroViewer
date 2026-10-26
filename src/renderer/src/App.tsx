import { useCallback, useEffect, useReducer, useState } from 'react'
import type { ProfileInput, RouterProfile, RouterSummary, SessionStatus, Settings, UpdateStatus } from '../../shared/types'
import { displayName, initialState, reducer } from './store'
import { TABS, isTab, type Tab } from './tabs'
import { storageGet, storageSet } from './storage'
import { ContextMenu, Modal, Panel, type MenuState } from './components/Controls'
import { RouterForm, cleanError } from './components/RouterForm'
import { AboutDialog, SettingsDialog } from './components/SettingsDialog'
import { OverviewView } from './views/Overview'
import { ConnectionsView } from './views/Connections'
import { LogsView } from './views/Logs'
import { DhcpView } from './views/Dhcp'
import { InterfacesView } from './views/Interfaces'
import { RouterLogView } from './views/RouterLog'

function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, active])
  return now
}

export const STATE_LABEL: Record<SessionStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  error: 'Error'
}

/** Pages that work from stored data, without a connection. */
const OFFLINE_TABS: Tab[] = ['logs']

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = storageGet('mv.tab')
    return isTab(saved) ? saved : 'overview'
  })
  const [connSearch, setConnSearch] = useState('')
  const [editing, setEditing] = useState<RouterProfile | 'new' | null>(null)
  const [settings, setSettings] = useState<Settings>({ theme: window.api.initialTheme, logRetentionDays: 7 })
  const [dialog, setDialog] = useState<'settings' | 'about' | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    const off = window.api.onEvent((event) => {
      if (event.type === 'update') setUpdate(event.status)
      else dispatch({ type: 'event', event })
    })
    void Promise.all([window.api.listProfiles(), window.api.getStatuses()]).then(([profiles, statuses]) => {
      const saved = storageGet('mv.selected')
      const selectedId = profiles.find((p) => p.id === saved)?.id ?? profiles[0]?.id ?? null
      dispatch({ type: 'init', profiles, statuses, selectedId })
    })
    void window.api.getSettings().then(setSettings)
    void window.api.updateStatus().then(setUpdate)
    return off
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

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

  const changeSettings = (patch: Partial<Settings>): void => {
    setSettings((s) => ({ ...s, ...patch }))
    void window.api.setSettings(patch).then(setSettings)
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

  const routerMenu = (p: RouterProfile, e: React.MouseEvent): void => {
    e.preventDefault()
    const st = state.statuses[p.id]?.state ?? 'disconnected'
    const busy = st === 'connected' || st === 'connecting' || st === 'reconnecting'
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        busy ? { label: 'Disconnect', onClick: () => void window.api.disconnect(p.id) } : { label: 'Connect', onClick: () => void window.api.connect(p.id) },
        { label: 'Edit…', onClick: () => setEditing(p) }
      ]
    })
  }

  const profile = state.profiles.find((p) => p.id === state.selectedId)
  const status: SessionStatus | undefined = profile ? (state.statuses[profile.id] ?? { id: profile.id, state: 'disconnected' }) : undefined
  const live = !!status && (status.state === 'connected' || (status.state === 'reconnecting' && !!state.data.overview))
  const showConnections = useCallback((ip: string) => setTab('connections', ip), [setTab])
  const updateReady = update.state === 'available' || update.state === 'ready'

  return (
    <div className="app">
      <header className="header">
        <span className="product">MikroViewer</span>
      </header>

      <nav className="nav">
        <div className="nav-scroll">
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
                onContextMenu={(e) => routerMenu(p, e)}
                title={`${p.host}:${p.port} – ${STATE_LABEL[st]}`}
              >
                <span className={`dot ${st}`} />
                <span className="label">{displayName(p, sum)}</span>
                {st === 'connected' && sum?.cpuLoad !== undefined && <span className="aside">{Math.round(sum.cpuLoad)} %</span>}
              </button>
            )
          })}

          <div className="nav-section">Monitor</div>
          {TABS.map((t) => {
            const enabled = live || (!!profile && OFFLINE_TABS.includes(t.id))
            return (
              <button key={t.id} className={`nav-item${tab === t.id && enabled ? ' active' : ''}`} onClick={() => setTab(t.id)} disabled={!enabled}>
                <span className="label">{t.label}</span>
              </button>
            )
          })}
        </div>

        <div className="nav-foot">
          <button className="nav-item" onClick={() => setDialog('settings')}>
            <span className="label">Settings</span>
          </button>
          <button className="nav-item" onClick={() => setDialog('about')}>
            <span className="label">About</span>
            {updateReady && <span className="badge">Update</span>}
          </button>
        </div>
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
        ) : tab === 'logs' ? (
          <LogsView key={profile.id} routerId={profile.id} />
        ) : live ? (
          <>
            {status.state === 'reconnecting' && <ReconnectNotice status={status} profileId={profile.id} />}
            {tab === 'overview' && <OverviewView data={state.data} profile={profile} status={status} onNavigate={setTab} onEdit={() => setEditing(profile)} />}
            {tab === 'connections' && <ConnectionsView data={state.data} search={connSearch} onSearch={setConnSearch} />}
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

      {dialog === 'settings' && <SettingsDialog settings={settings} onChange={changeSettings} onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog update={update} onClose={() => setDialog(null)} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
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
