import { useMemo, useState } from 'react'
import type { ConnectionLogEntry } from '../../../shared/types'
import type { RouterData } from '../store'
import { DataTable, type Column } from '../components/DataTable'
import { ButtonGroup, SearchBox, matchesSearch } from '../components/Controls'
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatTime, ipSortKey } from '../format'
import { matchesProtocol, serviceName, type ProtocolFilter } from '../services'
import { DestinationCell, PROTOCOL_OPTIONS, SourceCell, portColumns, protocolColumn } from './Connections'

type EventFilter = 'all' | 'open' | 'close'

function isToday(t: number): boolean {
  return new Date(t).toDateString() === new Date().toDateString()
}

const columns: Column<ConnectionLogEntry>[] = [
  {
    key: 'time',
    header: 'Time',
    width: 76,
    render: (e) => <span className="num" title={formatDateTime(e.t)}>{isToday(e.t) ? formatTime(e.t) : formatDateTime(e.t)}</span>,
    sort: (e) => e.seq,
    sortDesc: true
  },
  {
    key: 'event',
    header: 'Event',
    width: 64,
    render: (e) => (e.event === 'open' ? <span className="ok">Open</span> : <span className="muted">Close</span>),
    sort: (e) => e.event
  },
  protocolColumn(),
  {
    key: 'src',
    header: 'Source',
    width: 190,
    grow: 1.2,
    render: (e) => <SourceCell name={e.srcName} ip={e.srcAddress} nat={e.nat} />,
    sort: (e) => e.srcName?.toLowerCase() ?? ipSortKey(e.srcAddress)
  },
  {
    key: 'dst',
    header: 'Destination',
    width: 220,
    grow: 1.6,
    render: (e) => <DestinationCell name={e.dstName} ip={e.dstAddress} nat={e.nat} />,
    sort: (e) => e.dstName?.toLowerCase() ?? ipSortKey(e.dstAddress)
  },
  ...portColumns<ConnectionLogEntry>(),
  {
    key: 'duration',
    header: 'Duration',
    title: '≥ means the connection already existed when MikroViewer connected',
    width: 80,
    align: 'right',
    render: (e) => (
      <span className="num">
        {e.durationSec !== undefined && (e.durationApprox ? '≥ ' : '')}
        {formatDuration(e.durationSec)}
      </span>
    ),
    sort: (e) => e.durationSec ?? -1,
    sortDesc: true
  },
  {
    key: 'bytes',
    header: 'Bytes',
    width: 84,
    align: 'right',
    render: (e) =>
      e.event === 'close' ? (
        <span className="num" title={`Down ${formatBytes(e.rxBytes)} / Up ${formatBytes(e.txBytes)}`}>
          {formatBytes((e.rxBytes ?? 0) + (e.txBytes ?? 0))}
        </span>
      ) : null,
    sort: (e) => (e.rxBytes ?? 0) + (e.txBytes ?? 0),
    sortDesc: true
  }
]

export function ConnectionLogView({ data }: { data: RouterData }) {
  const [search, setSearch] = useState('')
  const [event, setEvent] = useState<EventFilter>('all')
  const [proto, setProto] = useState<ProtocolFilter>('all')
  const [frozen, setFrozen] = useState<ConnectionLogEntry[] | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const entries = frozen ?? data.connlog
  const filtered = useMemo(
    () =>
      entries.filter(
        (e) =>
          (event === 'all' || e.event === event) &&
          matchesProtocol(e.protocol, proto) &&
          matchesSearch(search, e.srcAddress, e.srcName, e.dstAddress, e.dstName, e.dstPort, serviceName(e.protocol, e.dstPort), e.protocol)
      ),
    [entries, event, proto, search]
  )

  const clear = async (): Promise<void> => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    setFrozen(null)
    if (data.id) await window.api.clearConnectionLog(data.id)
  }

  const exportCsv = async (): Promise<void> => {
    if (!data.id) return
    const res = await window.api.exportConnectionLog(data.id)
    if (res.saved) {
      setNotice(`Saved to ${res.path}`)
      setTimeout(() => setNotice(null), 6000)
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1 className="page-title">Connection Log</h1>
        <SearchBox value={search} onChange={setSearch} />
        <ButtonGroup
          value={event}
          options={[
            { value: 'all', label: 'All' },
            { value: 'open', label: 'Open' },
            { value: 'close', label: 'Close' }
          ]}
          onChange={setEvent}
        />
        <ButtonGroup value={proto} options={PROTOCOL_OPTIONS} onChange={setProto} />
        <button className={`btn${frozen ? ' on' : ''}`} onClick={() => setFrozen(frozen ? null : data.connlog)}>
          {frozen ? 'Resume' : 'Pause'}
        </button>
        <button className="btn" onClick={clear} onBlur={() => setConfirmClear(false)}>
          {confirmClear ? 'Confirm clear' : 'Clear'}
        </button>
        <button className="btn" onClick={exportCsv} disabled={data.connlog.length === 0}>
          Export CSV
        </button>
        <span className="count">
          {notice ?? `${formatNumber(filtered.length)} of ${formatNumber(entries.length)}${frozen ? ' (paused)' : ''}`}
        </span>
      </div>
      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(e) => String(e.seq)}
        initialSort={{ key: 'time', dir: 'desc' }}
        empty={entries.length ? 'No matching entries' : 'Waiting for connections to open or close…'}
      />
    </div>
  )
}
