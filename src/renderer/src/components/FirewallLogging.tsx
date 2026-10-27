import { useCallback, useEffect, useState } from 'react'
import type { FirewallLogStatus, FirewallRuleInfo } from '../../../shared/types'
import { Modal } from './Controls'
import { cleanError } from './RouterForm'
import { formatDateTime, formatNumber, formatTime } from '../format'

const BLOCKING = new Set(['drop', 'reject', 'tarpit'])

/** Drop and reject rules, and every rule that logs – the ones that decide what Logs can show. */
export function relevantRules(status: FirewallLogStatus): FirewallRuleInfo[] {
  return status.rules.filter((r) => BLOCKING.has(r.action) || r.log)
}

/** No enabled rule logs, so no firewall records can arrive. */
export function nothingLogs(status: FirewallLogStatus): boolean {
  return status.connected && status.rules.length > 0 && !status.rules.some((r) => r.log && !r.disabled)
}

/** Turns on logging, with a prefix that tells this rule apart from others in the same chain. */
export function enableLogCommand(r: FirewallRuleInfo): string {
  const prefix = r.prefix || `${r.action}-${r.chain}-${r.number}`.toUpperCase()
  return `/ip firewall ${r.table} set ${r.id} log=yes log-prefix="${prefix}"`
}

export function useFirewallStatus(routerId: string, active: boolean, refreshMs?: number) {
  const [status, setStatus] = useState<FirewallLogStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setStatus(await window.api.firewallStatus(routerId))
      setError(null)
    } catch (err) {
      setError(cleanError(err))
    }
  }, [routerId])
  useEffect(() => {
    if (!active) return
    void load()
    if (!refreshMs) return
    const t = setInterval(() => void load(), refreshMs)
    return () => clearInterval(t)
  }, [active, load, refreshMs])
  return { status, error, reload: load }
}

function FeedStatus({ s }: { s: FirewallLogStatus }) {
  if (!s.connected) return <p>Not connected. Connect to the router to see its firewall rules.</p>
  const how = s.feed === 'poll' ? 'polled every 5 seconds (this router can’t stream it)' : 'streamed as it is written'
  return (
    <p>
      The router’s log is {how}
      {s.since ? `, since ${formatTime(s.since)}` : ''}. Firewall lines received: <b>{formatNumber(s.lines)}</b>
      {s.unparsed > 0 && ` (${formatNumber(s.unparsed)} not understood – shown as Log records with the raw message)`}
      {s.lastAt ? `, the last at ${formatDateTime(s.lastAt)}` : ''}.
    </p>
  )
}

function RuleRow({ r }: { r: FirewallRuleInfo }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(enableLogCommand(r))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <tr className={r.disabled ? 'disabled' : undefined}>
      <td className="num">
        {r.table === 'raw' ? 'raw ' : ''}
        {r.number}
      </td>
      <td>{r.chain}</td>
      <td>{r.action}</td>
      <td className="rule-text">
        {r.comment ?? <span className="muted">{r.match}</span>}
        {r.comment && <div className="muted">{r.match}</div>}
        {r.disabled && <div className="muted">Disabled</div>}
      </td>
      <td className="num">{r.packets !== undefined ? formatNumber(r.packets) : ''}</td>
      <td>{r.log ? <span className="ok">On{r.prefix ? ` (${r.prefix})` : ''}</span> : <span className="muted">Off</span>}</td>
      <td>
        {!r.log && !r.disabled && (
          <button className="btn small" onClick={copy} title={enableLogCommand(r)}>
            {copied ? 'Copied' : 'Copy command'}
          </button>
        )}
      </td>
    </tr>
  )
}

export function FirewallLoggingDialog({ routerId, onClose }: { routerId: string; onClose: () => void }) {
  const { status, error, reload } = useFirewallStatus(routerId, true, 5000)
  const rules = status ? relevantRules(status) : []

  return (
    <Modal title="Firewall Logging" onClose={onClose} width={900}>
      <div className="fw-logging">
        <p>
          Firewall records only come from rules with <b>logging</b> turned on. A blocked connection never gets into the router’s connection table, so it is
          not in the log as a session either: a port scan, or a device trying to reach a network it may not use, only shows up if the rule that blocks it
          logs. <b>Packets</b> counts what each rule has matched since the counters were last reset – a blocking rule whose counter goes up is blocking
          something.
        </p>
        {error && <div className="notice error">{error}</div>}
        {status && <FeedStatus s={status} />}
        {status?.connected && (
          <>
            <table className="rules">
              <thead>
                <tr>
                  <th style={{ width: 52 }}>#</th>
                  <th style={{ width: 90 }}>Chain</th>
                  <th style={{ width: 80 }}>Action</th>
                  <th>Rule</th>
                  <th style={{ width: 90 }}>Packets</th>
                  <th style={{ width: 120 }}>Logging</th>
                  <th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <RuleRow key={`${r.table}${r.id}`} r={r} />
                ))}
                {rules.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No drop or reject rules, and no rules that log.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="muted">
              “Copy command” copies the RouterOS command that turns on logging for the rule, to paste in the router’s terminal (it needs a user with write
              access). Logging a busy rule, such as the one that drops everything from the internet, writes many records.
            </p>
          </>
        )}
      </div>
      <div className="form-foot">
        <button className="btn" onClick={() => void reload()}>
          Refresh
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
