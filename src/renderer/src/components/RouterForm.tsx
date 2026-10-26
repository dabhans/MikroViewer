import { useState } from 'react'
import type { ProfileInput, RouterProfile, TestResult } from '../../../shared/types'

const DEFAULT_PORT = 8728
const DEFAULT_TLS_PORT = 8729

interface Props {
  profile?: RouterProfile
  /** Saves the profile. Returns an error message on failure. */
  onSave: (input: ProfileInput) => Promise<string | undefined>
  onCancel: () => void
  onDelete?: () => Promise<void>
}

export function RouterForm({ profile, onSave, onCancel, onDelete }: Props) {
  const [name, setName] = useState(profile?.name ?? '')
  const [host, setHost] = useState(profile?.host ?? '')
  const [port, setPort] = useState(String(profile?.port ?? DEFAULT_PORT))
  const [username, setUsername] = useState(profile?.username ?? 'admin')
  const [password, setPassword] = useState('')
  const [passwordTouched, setPasswordTouched] = useState(!profile)
  const [useTls, setUseTls] = useState(profile?.useTls ?? false)
  const [autoConnect, setAutoConnect] = useState(profile?.autoConnect ?? true)
  const [resetFingerprint, setResetFingerprint] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const input = (): ProfileInput => ({
    id: profile?.id,
    name,
    host,
    port: Number(port),
    username,
    password: passwordTouched ? password : undefined,
    useTls,
    autoConnect,
    resetFingerprint
  })

  const toggleTls = (on: boolean): void => {
    setUseTls(on)
    // Only swap the default port – a custom port is kept.
    if (on && port === String(DEFAULT_PORT)) setPort(String(DEFAULT_TLS_PORT))
    if (!on && port === String(DEFAULT_TLS_PORT)) setPort(String(DEFAULT_PORT))
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setResult(null)
    try {
      const r: TestResult = await window.api.testProfile(input())
      const details = [r.board, r.version && `RouterOS ${r.version}`].filter(Boolean).join(', ')
      setResult(r.ok ? { ok: true, text: `Connected to ${r.identity}${details ? ` (${details})` : ''}` } : { ok: false, text: r.error ?? 'Connection failed' })
    } catch (err) {
      setResult({ ok: false, text: cleanError(err) })
    } finally {
      setBusy(null)
    }
  }

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy('save')
    setResult(null)
    const err = await onSave(input())
    setBusy(null)
    if (err) setResult({ ok: false, text: err })
  }

  const del = async (): Promise<void> => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await onDelete?.()
  }

  return (
    <form onSubmit={save}>
      <div className="form">
        <label className="lbl" htmlFor="rf-name">
          Name
        </label>
        <input id="rf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" autoFocus={!profile} />

        <label className="lbl" htmlFor="rf-host">
          Address
        </label>
        <input id="rf-host" className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.88.1" spellCheck={false} required />

        <label className="lbl" htmlFor="rf-port">
          Port
        </label>
        <input
          id="rf-port"
          className="input"
          style={{ width: 90 }}
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          required
        />

        <label className="lbl" htmlFor="rf-user">
          Username
        </label>
        <input id="rf-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} required />

        <label className="lbl" htmlFor="rf-pass">
          Password
        </label>
        <input
          id="rf-pass"
          className="input"
          type="password"
          value={password}
          placeholder={profile && !passwordTouched ? 'Unchanged' : ''}
          onChange={(e) => {
            setPassword(e.target.value)
            setPasswordTouched(true)
          }}
        />

        <label className="check full">
          <input type="checkbox" checked={useTls} onChange={(e) => toggleTls(e.target.checked)} />
          Use TLS (api-ssl)
        </label>
        <label className="check full">
          <input type="checkbox" checked={autoConnect} onChange={(e) => setAutoConnect(e.target.checked)} />
          Connect at startup
        </label>
        {profile?.tlsFingerprint && useTls && (
          <label className="check full">
            <input type="checkbox" checked={resetFingerprint} onChange={(e) => setResetFingerprint(e.target.checked)} />
            Reset saved certificate
          </label>
        )}

        {result && <div className={`form-result ${result.ok ? 'ok' : 'err'}`}>{result.text}</div>}
      </div>

      <div className="form-foot">
        {onDelete && (
          <button type="button" className="btn danger" onClick={del} onBlur={() => setConfirmDelete(false)}>
            {confirmDelete ? 'Confirm delete' : 'Delete'}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={runTest} disabled={!host || busy !== null}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!host || busy !== null}>
          OK
        </button>
      </div>
    </form>
  )
}

/** Electron wraps errors from the main process as "Error invoking remote method ...: Error: ..." */
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
