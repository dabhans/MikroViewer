import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LogAction, LogEntry, LogQueryResult, SessionEndReason } from '../../../shared/types'
import { FIELDS, addTerm, compileQuery, filterTerm, type LogPredicate } from '../../../shared/logquery'
import { Cell, DataTable, copyItems, type Column } from '../components/DataTable'
import { ContextMenu, Panel, type MenuItem, type MenuState } from '../components/Controls'
import { FirewallLoggingDialog, nothingLogs, useFirewallStatus } from '../components/FirewallLogging'
import { Timeline } from '../components/Timeline'
import { cleanError } from '../components/RouterForm'
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatTime, ipSortKey } from '../format'
import { serviceLabel, serviceName } from '../services'
import { storageGet, storageSet } from '../storage'
import { ProtocolTag } from './Connections'

/** Newest records loaded into the grid; the count and timeline cover everything. */
const LIMIT = 10000

type RangeId = '15m' | '1h' | '24h' | '7d' | '30d' | 'all' | 'custom'
const RANGES: { id: Exclude<RangeId, 'custom'>; label: string; ms: number }[] = [
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 3600_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3600_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 3600_000 },
  { id: 'all', label: 'All', ms: 0 }
]

const QUERIES: { label: string; query: string }[] = [
  { label: 'All records', query: '' },
  { label: 'Sessions', query: 'type:session' },
  { label: 'Firewall', query: 'type:firewall' },
  { label: 'Blocked', query: 'action:drop,reject' },
  { label: 'Port forwards', query: 'nat:dstnat' },
  { label: 'Web', query: 'service:http,https,quic' },
  { label: 'DNS', query: 'service:dns' },
  { label: 'Large transfers', query: 'bytes:>100M' }
]

const ACTION_LABEL: Record<LogAction, string> = { accept: 'Accept', drop: 'Drop', reject: 'Reject', nat: 'NAT', log: 'Log' }

const END_REASON: Record<SessionEndReason, string> = {
  fin: 'Closed (TCP FIN)',
  reset: 'Reset (TCP RST)',
  'aged-out': 'Timed out',
  lost: 'Unknown – MikroViewer was disconnected'
}

function ActionTag({ action }: { action: LogAction }) {
  return (
    <span className={`action ${action}`}>
      <i />
      {ACTION_LABEL[action]}
    </span>
  )
}

const isToday = (t: number): boolean => new Date(t).toDateString() === new Date().toDateString()

/** "≥ 4m" when MikroViewer didn't see the start or the end; unknown when that's all we know. */
function durationText(e: LogEntry): string | undefined {
  if (e.durationSec === undefined || (e.approx && e.durationSec < 1)) return undefined
  return `${e.approx ? '≥ ' : ''}${formatDuration(e.durationSec)}`
}

function Duration({ e }: { e: LogEntry }) {
  if (e.type !== 'session') return null
  const text = durationText(e)
  if (text) return <span className="num">{text}</span>
  return (
    <span className="muted" title="MikroViewer did not see when the session started or ended">
      Unknown
    </span>
  )
}

const withPort = (ip: string, port?: number): string | undefined => (ip && port !== undefined ? `${ip}:${port}` : undefined)

const columns: Column<LogEntry>[] = [
  {
    key: 'time',
    header: 'Time',
    title: 'When the session ended, or when the router logged the packet',
    width: 100,
    render: (e) => (
      <span className="num" title={formatDateTime(e.t)}>
        {isToday(e.t) ? formatTime(e.t) : formatDateTime(e.t).slice(5)}
      </span>
    ),
    sort: (e) => e.t,
    sortDesc: true
  },
  { key: 'action', header: 'Action', width: 72, render: (e) => <ActionTag action={e.action} />, sort: (e) => e.action },
  { key: 'type', header: 'Type', width: 66, render: (e) => (e.type === 'session' ? 'Session' : 'Firewall'), sort: (e) => e.type },
  {
    key: 'src',
    header: 'Source',
    width: 170,
    copy: (e) => [e.src, e.srcName, withPort(e.src, e.srcPort), e.srcMac],
    render: (e) => <Cell main={e.srcName ?? e.src} sub={e.srcName ? e.src : undefined} title={[e.srcName, e.src, e.srcMac].filter(Boolean).join('\n')} />,
    sort: (e) => e.srcName?.toLowerCase() ?? ipSortKey(e.src)
  },
  {
    key: 'dst',
    header: 'Destination',
    width: 190,
    copy: (e) => [e.dst, e.dstName, withPort(e.dst, e.dstPort), e.nat?.address],
    render: (e) => {
      const fwd = e.nat?.kind === 'dstnat' ? `→ ${e.nat.address}` : undefined
      return <Cell main={e.dstName ?? e.dst} sub={[e.dstName ? e.dst : undefined, fwd].filter(Boolean).join(' ')} title={[e.dstName, e.dst, fwd].filter(Boolean).join('\n')} />
    },
    sort: (e) => e.dstName?.toLowerCase() ?? ipSortKey(e.dst)
  },
  { key: 'proto', header: 'Protocol', width: 64, render: (e) => (e.protocol ? <ProtocolTag protocol={e.protocol} /> : null), sort: (e) => e.protocol },
  { key: 'dstPort', header: 'Dst Port', width: 62, render: (e) => <span className="num">{e.dstPort ?? ''}</span>, sort: (e) => e.dstPort ?? -1 },
  { key: 'service', header: 'Service', width: 76, render: (e) => serviceName(e.protocol, e.dstPort) ?? '', sort: (e) => serviceName(e.protocol, e.dstPort) ?? '~' },
  {
    key: 'rule',
    header: 'Rule',
    width: 140,
    render: (e) => {
      const main = e.rule ?? e.ruleNumber
      return <Cell main={main ?? e.chain ?? ''} sub={main ? e.chain : undefined} title={[e.rule, e.ruleNumber, e.chain && `chain ${e.chain}`].filter(Boolean).join('\n')} />
    },
    sort: (e) => (e.rule ?? e.chain ?? '~').toLowerCase(),
    copy: (e) => [e.rule, e.ruleNumber, e.chain, e.prefix]
  },
  { key: 'duration', header: 'Duration', width: 72, render: (e) => <Duration e={e} />, sort: (e) => e.durationSec ?? -1, sortDesc: true },
  {
    key: 'bytes',
    header: 'Bytes',
    width: 72,
    render: (e) =>
      e.txBytes !== undefined || e.rxBytes !== undefined ? (
        <span className="num" title={`Received ${formatBytes(e.rxBytes)} / Sent ${formatBytes(e.txBytes)}`}>
          {formatBytes((e.rxBytes ?? 0) + (e.txBytes ?? 0))}
        </span>
      ) : null,
    sort: (e) => (e.rxBytes ?? 0) + (e.txBytes ?? 0),
    sortDesc: true
  }
]

/** The query term a grid cell stands for, used by "Filter" and "Exclude" in the right-click menu. */
function filterFor(e: LogEntry, key: string): { label: string; term: string; value: string } | null {
  switch (key) {
    case 'action':
      return { label: `Action is ${ACTION_LABEL[e.action]}`, term: filterTerm('action', e.action), value: e.action }
    case 'type':
      return { label: `Type is ${e.type}`, term: filterTerm('type', e.type), value: e.type }
    case 'src':
      return e.src ? { label: `Source is ${e.src}`, term: filterTerm('src', e.src), value: e.src } : null
    case 'dst':
      return e.dst ? { label: `Destination is ${e.dst}`, term: filterTerm('dst', e.dst), value: e.dst } : null
    case 'proto':
      return e.protocol ? { label: `Protocol is ${e.protocol.toUpperCase()}`, term: filterTerm('proto', e.protocol), value: e.protocol } : null
    case 'dstPort':
      return e.dstPort !== undefined ? { label: `Destination port is ${e.dstPort}`, term: filterTerm('port', e.dstPort), value: String(e.dstPort) } : null
    case 'service': {
      const s = serviceName(e.protocol, e.dstPort)
      return s ? { label: `Service is ${s}`, term: filterTerm('service', s.toLowerCase()), value: s } : null
    }
    case 'rule':
      if (e.rule) return { label: `Rule is ${e.rule}`, term: filterTerm('rule', e.rule), value: e.rule }
      return e.chain ? { label: `Chain is ${e.chain}`, term: filterTerm('chain', e.chain), value: e.chain } : null
    default:
      return null
  }
}

function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <>
      {items
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => (
          <div className="kv" key={k}>
            <span>{k}</span>
            <span title={typeof v === 'string' ? v : undefined}>{v}</span>
          </div>
        ))}
    </>
  )
}

function Details({ e, onClose, height, onResizeStart }: { e: LogEntry; onClose: () => void; height: number; onResizeStart: (ev: React.MouseEvent) => void }) {
  const start = e.start !== undefined ? `${e.startBefore ? 'At or before ' : ''}${formatDateTime(e.start)}` : undefined
  const end = `${e.endReason === 'lost' ? 'At or after ' : ''}${formatDateTime(e.t)}`
  return (
    <>
      <div className="splitter" onMouseDown={onResizeStart} title="Drag to resize" />
      <Panel
      className="details"
      style={{ height }}
      title={`${e.type === 'session' ? 'Session' : 'Firewall record'} · ${formatDateTime(e.t)}`}
      aside={
        <button className="modal-close" onClick={onClose} title="Close">
          ×
        </button>
      }
    >
      <div>
        <h3>Traffic</h3>
        <KV
          items={[
            ['Action', <ActionTag key="a" action={e.action} />],
            ['Service', e.protocol ? serviceLabel(e.protocol, e.dstPort) : undefined],
            ['Source', e.srcName],
            ['Source IP', e.src],
            ['Source port', e.srcPort],
            ['Source MAC', e.srcMac],
            ['Destination', e.dstName],
            ['Destination IP', e.dst],
            ['Destination port', e.dstPort],
            ['NAT', e.nat ? `${e.nat.kind === 'dstnat' ? 'Forwarded to' : 'Translated to'} ${e.nat.address}` : undefined]
          ]}
        />
      </div>
      {e.type === 'session' ? (
        <div>
          <h3>Session</h3>
          <KV
            items={[
              ['Start', start],
              ['End', end],
              ['Duration', durationText(e) ?? 'Unknown'],
              ['End reason', e.endReason ? END_REASON[e.endReason] : undefined],
              ['Received', e.rxBytes !== undefined ? formatBytes(e.rxBytes) : undefined],
              ['Sent', e.txBytes !== undefined ? formatBytes(e.txBytes) : undefined]
            ]}
          />
        </div>
      ) : (
        <>
          <div>
            <h3>Rule</h3>
            <KV
              items={[
                ['Rule', e.rule],
                ['Rule number', e.ruleNumber],
                ['Log prefix', e.prefix],
                ['Chain', e.chain],
                ['In interface', e.inInterface],
                ['Out interface', e.outInterface],
                ['Connection state', e.connState],
                ['TCP flags', e.tcpFlags],
                ['ICMP', e.icmp],
                ['Packet size', e.length !== undefined ? `${e.length} bytes` : undefined]
              ]}
            />
          </div>
          {e.message && (
            <div>
              <h3>Message</h3>
              <div className="raw">{e.message}</div>
            </div>
          )}
        </>
      )}
      </Panel>
    </>
  )
}

function QueryHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="help" style={{ right: 12, top: 44 }} onMouseLeave={onClose}>
      <p>
        Terms next to each other must all match. Use <code>OR</code>, <code>NOT</code> and parentheses. <code>field:a,b</code> matches either value,{' '}
        <code>*</code> is a wildcard. Right-click a cell to filter by it.
      </p>
      <table>
        <tbody>
          {FIELDS.map((f) => (
            <tr key={f.names[0]}>
              <td>
                <code>{f.names[0]}</code>
              </td>
              <td>{f.description}</td>
              <td>
                <code className="muted">{f.example}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function mergeLive(prev: LogQueryResult, added: LogEntry[], pred: LogPredicate): LogQueryResult {
  const present = new Set(prev.entries.map((e) => e.id))
  const fresh: LogEntry[] = []
  for (const e of added) {
    if (present.has(e.id) || e.t < prev.from || !pred(e)) continue
    present.add(e.id)
    fresh.push(e)
  }
  if (fresh.length === 0) return prev
  // Newest first – a long session that just ended can have ended before a record already shown.
  const entries = fresh
    .sort((a, b) => b.t - a.t || b.id - a.id)
    .concat(prev.entries)
    .slice(0, LIMIT)

  const h = prev.histogram
  const counts = [...h.counts]
  const blocked = [...h.blocked]
  for (const e of fresh) {
    const i = Math.floor((e.t - h.from) / h.bucketMs)
    if (i < 0) continue
    while (counts.length <= i) {
      counts.push(0)
      blocked.push(0)
    }
    counts[i]++
    if (e.action === 'drop' || e.action === 'reject') blocked[i]++
  }
  return { ...prev, entries, total: prev.total + fresh.length, to: Math.max(prev.to, Date.now()), histogram: { ...h, counts, blocked } }
}

const DETAILS_MIN = 120

export function LogsView({ routerId, connected }: { routerId: string; connected: boolean }) {
  const [input, setInput] = useState(() => storageGet('mv.logs.query') ?? '')
  const [query, setQuery] = useState(input)
  const [range, setRange] = useState<RangeId>(() => {
    const saved = storageGet('mv.logs.range')
    return RANGES.some((r) => r.id === saved) ? (saved as RangeId) : '1h'
  })
  const [custom, setCustom] = useState<{ from: number; to: number } | null>(null)
  const [live, setLive] = useState(true)
  const [result, setResult] = useState<LogQueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [help, setHelp] = useState(false)
  const [atTop, setAtTop] = useState(true)
  const [buffered, setBuffered] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [fwDialog, setFwDialog] = useState(false)
  const [detailsHeight, setDetailsHeight] = useState(() => Math.max(DETAILS_MIN, Number(storageGet('mv.logs.details')) || 230))
  const bodyRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0)
  const pending = useRef<LogEntry[]>([])
  // Checked once per visit: a router where no rule logs can't show blocked traffic.
  const fw = useFirewallStatus(routerId, connected)

  const compiled = useMemo(() => compileQuery(query), [query])
  const inputError = useMemo(() => {
    const c = compileQuery(input)
    return c.ok ? null : c.error
  }, [input])
  const isLive = live && range !== 'custom'
  // New records are held back while the user is looking further down or at a record.
  const holdBack = !atTop || selected !== null

  const timeRange = useCallback((): { from: number; to: number } => {
    if (range === 'custom' && custom) return custom
    const to = Date.now()
    const ms = RANGES.find((r) => r.id === range)?.ms ?? 3600_000
    return { from: ms ? to - ms : 0, to }
  }, [range, custom])

  const run = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    const { from, to } = timeRange()
    try {
      const res = await window.api.queryLogs({ routerId, query, from, to, limit: LIMIT })
      if (id !== reqId.current) return
      pending.current = []
      setBuffered(0)
      setResult(res)
      setError(res.error ?? null)
    } catch (err) {
      if (id === reqId.current) setError(cleanError(err))
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [routerId, query, timeRange])

  useEffect(() => {
    void run()
  }, [run])

  const live$ = useRef({ isLive, holdBack, predicate: compiled.ok ? compiled.predicate : null })
  live$.current = { isLive, holdBack, predicate: compiled.ok ? compiled.predicate : null }

  const applyPending = useCallback(() => {
    const pred = live$.current.predicate
    const added = pending.current
    pending.current = []
    setBuffered(0)
    if (!pred || added.length === 0) return
    setResult((prev) => (prev ? mergeLive(prev, added, pred) : prev))
  }, [])

  // Live: ended sessions and logged packets are pushed from the main process.
  useEffect(
    () =>
      window.api.onEvent((ev) => {
        if (ev.type !== 'log' || ev.id !== routerId) return
        const s = live$.current
        if (!s.isLive || !s.predicate) return
        pending.current.push(...ev.added)
        if (s.holdBack) setBuffered(pending.current.filter((e) => s.predicate!(e)).length)
        else applyPending()
      }),
    [routerId, applyPending]
  )

  useEffect(() => {
    if (!holdBack) applyPending()
  }, [holdBack, applyPending])

  // A full refresh now and then keeps a relative range ("last hour") sliding.
  useEffect(() => {
    if (!isLive) return
    const ms = range === '15m' || range === '1h' ? 30_000 : 300_000
    const t = setInterval(() => {
      if (!live$.current.holdBack) void run()
    }, ms)
    return () => clearInterval(t)
  }, [isLive, range, run])

  const apply = (q: string): void => {
    setInput(q)
    storageSet('mv.logs.query', q)
    if (q === query) void run()
    else setQuery(q)
    setSelected(null)
  }

  const chooseRange = (id: RangeId): void => {
    setRange(id)
    setCustom(null)
    if (id !== 'custom') storageSet('mv.logs.range', id)
  }

  const exportCsv = async (): Promise<void> => {
    const { from, to } = timeRange()
    try {
      const res = await window.api.exportLogs({ routerId, query, from, to })
      if (res.saved) {
        setNotice(`Saved to ${res.path}`)
        setTimeout(() => setNotice(null), 6000)
      }
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const onCellMenu = (e: LogEntry, key: string, ev: React.MouseEvent): void => {
    ev.preventDefault()
    setSelected(e)
    const f = filterFor(e, key)
    const items: MenuItem[] = []
    if (f) {
      items.push({ label: `Filter: ${f.label}`, onClick: () => apply(addTerm(query, f.term)) })
      items.push({ label: `Exclude: ${f.label}`, onClick: () => apply(addTerm(query, f.term, true)) })
      items.push('separator')
    }
    items.push(...copyItems(columns, e, key, ev.currentTarget as HTMLElement))
    if (e.message) items.push({ label: 'Copy message', onClick: () => void navigator.clipboard.writeText(e.message!) })
    setMenu({ x: ev.clientX, y: ev.clientY, items })
  }

  // Dragging the bar above the details makes them taller or shorter.
  const startResize = (ev: React.MouseEvent): void => {
    ev.preventDefault()
    const startY = ev.clientY
    const startH = detailsHeight
    const max = Math.max(DETAILS_MIN, (bodyRef.current?.clientHeight ?? 600) - 120)
    let h = startH
    const move = (e: MouseEvent): void => {
      h = Math.round(Math.min(max, Math.max(DETAILS_MIN, startH + startY - e.clientY)))
      setDetailsHeight(h)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
      storageSet('mv.logs.details', String(h))
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const rangeLabel = (r: { from: number; to: number }): string => {
    const f = (t: number): string => (isToday(t) ? formatTime(t).slice(0, 5) : formatDateTime(t).slice(5, 16))
    return `${f(r.from)} – ${f(r.to)}`
  }

  const entries = result?.entries ?? []
  const status = loading
    ? 'Searching…'
    : result
      ? `${formatNumber(result.total)} records${result.total > entries.length ? ` · newest ${formatNumber(entries.length)} shown` : ''} · ${(result.tookMs / 1000).toFixed(2)} s`
      : ''

  return (
    <div className="page" style={{ position: 'relative' }}>
      <div className="toolbar">
        <h1 className="page-title">Logs</h1>
        <select className="select" value={range} onChange={(e) => chooseRange(e.target.value as RangeId)}>
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
          {range === 'custom' && custom && <option value="custom">{rangeLabel(custom)}</option>}
        </select>
        <input
          className={`input query${inputError ? ' invalid' : ''}`}
          value={input}
          placeholder="src:192.168.88.0/24 action:drop"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !inputError) apply(input)
            if (e.key === 'Escape') setInput(query)
          }}
        />
        <button className="btn primary" onClick={() => apply(input)} disabled={!!inputError}>
          Search
        </button>
        <button className={`btn${help ? ' on' : ''}`} onClick={() => setHelp(!help)} title="Query syntax">
          ?
        </button>
        <select
          className="select"
          value=""
          onChange={(e) => {
            const q = QUERIES[Number(e.target.value)]
            if (q) apply(q.query)
          }}
        >
          <option value="" disabled>
            Queries
          </option>
          {QUERIES.map((q, i) => (
            <option key={q.label} value={i}>
              {q.label}
            </option>
          ))}
        </select>
        <button className={`btn${isLive ? ' on' : ''}`} onClick={() => setLive(!live)} disabled={range === 'custom'} title="Show new records as they arrive">
          <span className="live-dot" />
          Live
        </button>
        <button className="btn" onClick={exportCsv} disabled={!result || result.total === 0}>
          Export CSV
        </button>
        <button className="btn" onClick={() => setFwDialog(true)} title="Which firewall rules log, and whether the router's log arrives">
          Firewall Logging
        </button>
      </div>

      {help && <QueryHelp onClose={() => setHelp(false)} />}

      {fw.status && nothingLogs(fw.status) && (
        <div className="notice">
          <span>No firewall rule on this router has logging turned on, so blocked traffic can’t show up here – only sessions that were let through.</span>
          <span className="spacer" />
          <button className="btn small" onClick={() => setFwDialog(true)}>
            Show rules
          </button>
        </div>
      )}

      <div className="toolbar">
        {inputError ? <span className="query-error">{inputError}</span> : error ? <span className="query-error">{error}</span> : null}
        {buffered > 0 && (
          <button
            className="btn small"
            onClick={() => {
              setSelected(null)
              applyPending()
            }}
          >
            {formatNumber(buffered)} new
          </button>
        )}
        <span className="count">{notice ?? status}</span>
      </div>

      <div className="logs-body" ref={bodyRef}>
        {result && result.histogram.counts.length > 0 && (
          <Timeline
            histogram={result.histogram}
            onSelect={(from, to) => {
              setCustom({ from, to: Math.min(to, Date.now()) })
              setRange('custom')
            }}
          />
        )}
        <DataTable
          rows={entries}
          columns={columns}
          rowKey={(e) => String(e.id)}
          initialSort={{ key: 'time', dir: 'desc' }}
          selectedKey={selected ? String(selected.id) : null}
          onRowClick={(e) => setSelected(selected?.id === e.id ? null : e)}
          onCellContextMenu={onCellMenu}
          onTopChange={setAtTop}
          empty={loading ? 'Searching…' : compiled.ok && compiled.empty ? 'No records in this period' : 'No records match the query'}
        />
        {selected && (
          <Details
            e={entries.find((x) => x.id === selected.id) ?? selected}
            onClose={() => setSelected(null)}
            height={detailsHeight}
            onResizeStart={startResize}
          />
        )}
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {fwDialog && (
        <FirewallLoggingDialog
          routerId={routerId}
          onClose={() => {
            setFwDialog(false)
            if (connected) void fw.reload()
          }}
        />
      )}
    </div>
  )
}
