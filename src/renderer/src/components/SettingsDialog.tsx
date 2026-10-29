import { useEffect, useState } from 'react'
import type { AppInfo, Settings, UpdateStatus } from '../../../shared/types'
import { ButtonGroup, Modal } from './Controls'
import { cleanError } from './RouterForm'
import { formatBytes } from '../format'

const RETENTION = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' }
]

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

export function SettingsDialog({ settings, onChange, onClose }: Props) {
  const [storage, setStorage] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStorage = (): void => void window.api.logStorage().then((r) => setStorage(r.bytes))
  useEffect(loadStorage, [])

  const run = (fn: () => Promise<unknown>) => async (): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const deleteLogs = async (): Promise<void> => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    await run(() => window.api.deleteLogs())()
    loadStorage()
  }

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="form settings">
        <div className="section">Appearance</div>
        <span className="lbl">Theme</span>
        <div className="row">
          <ButtonGroup
            value={settings.theme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
            onChange={(theme) => onChange({ theme })}
          />
        </div>

        <div className="section">Logs</div>
        <label className="lbl" htmlFor="set-retention">
          Keep logs for
        </label>
        <div className="row">
          <select
            id="set-retention"
            className="select"
            value={settings.logRetentionDays}
            onChange={(e) => onChange({ logRetentionDays: Number(e.target.value) })}
          >
            {RETENTION.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <span className="lbl">Storage</span>
        <span className="num">{storage === null ? '…' : formatBytes(storage)}</span>
        <div className="row full">
          <button className="btn" onClick={run(() => window.api.openLogFolder())}>
            Open folder
          </button>
          <button className="btn danger" onClick={deleteLogs} onBlur={() => setConfirmDelete(false)} disabled={storage === 0}>
            {confirmDelete ? 'Confirm delete' : 'Delete logs'}
          </button>
        </div>

        {error && <div className="form-result err">{error}</div>}
      </div>
      <div className="form-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

export function AboutDialog({ update, onClose }: { update: UpdateStatus; onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => void window.api.appInfo().then(setInfo), [])

  return (
    <Modal title="About" onClose={onClose} wide>
      <div className="form settings">
        <span className="lbl">Product</span>
        <span>MikroViewer</span>
        <span className="lbl">Version</span>
        <span className="selectable">
          {info?.version ?? ''}
          {info?.portable ? ' (portable)' : ''}
        </span>
        <span className="lbl">Updates</span>
        <UpdateRow status={update} portable={!!info?.portable} onError={setError} />
        {error && <div className="form-result err">{error}</div>}
      </div>
      <div className="form-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

function UpdateRow({ status, portable, onError }: { status: UpdateStatus; portable: boolean; onError: (e: string) => void }) {
  const call = (fn: () => Promise<unknown>) => (): void => {
    fn().catch((err) => onError(cleanError(err)))
  }
  const check = (
    <button className="btn" onClick={call(() => window.api.checkForUpdates())} disabled={status.state === 'checking' || status.state === 'unsupported'}>
      Check for updates
    </button>
  )
  switch (status.state) {
    case 'checking':
      return (
        <div className="row">
          <span className="muted">Checking…</span>
        </div>
      )
    case 'available':
      return (
        <div className="row">
          <span>Version {status.version} is available.</span>
          <button className="btn primary" onClick={call(() => window.api.downloadUpdate())}>
            {portable ? 'Download' : 'Download and install'}
          </button>
        </div>
      )
    case 'downloading':
      return (
        <div className="row">
          <div className="progress">
            <div style={{ width: `${Math.round(status.percent ?? 0)}%` }} />
          </div>
          <span className="num">{Math.round(status.percent ?? 0)} %</span>
        </div>
      )
    case 'ready':
      return (
        <div className="row">
          <span>Version {status.version} is ready.</span>
          <button className="btn primary" onClick={call(() => window.api.installUpdate())}>
            Restart and install
          </button>
        </div>
      )
    case 'none':
      return (
        <div className="row">
          <span>You have the latest version.</span>
          {check}
        </div>
      )
    case 'error':
      return (
        <div className="row">
          <span className="err">{status.error}</span>
          {status.version ? (
            <button className="btn" onClick={call(() => window.api.downloadUpdate())}>
              Try again
            </button>
          ) : (
            check
          )}
        </div>
      )
    case 'unsupported':
      return (
        <div className="row">
          <span className="muted">Updates work in the installed app.</span>
        </div>
      )
    default:
      return <div className="row">{check}</div>
  }
}
