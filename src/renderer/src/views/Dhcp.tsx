import { useMemo, useState } from 'react'
import type { LeaseRow } from '../../../shared/types'
import type { RouterData } from '../store'
import { DataTable, type Column } from '../components/DataTable'
import { ButtonGroup, SearchBox, matchesSearch } from '../components/Controls'
import { formatDuration, formatNumber, ipSortKey } from '../format'

type Filter = 'all' | 'bound' | 'static' | 'dynamic'

function statusOf(l: LeaseRow): { label: string; cls: string } {
  if (l.blocked) return { label: 'Blocked', cls: 'err' }
  if (l.disabled) return { label: 'Disabled', cls: 'muted' }
  switch (l.status) {
    case 'bound':
      return { label: 'Bound', cls: 'ok' }
    case 'waiting':
      return { label: 'Waiting', cls: 'muted' }
    case 'offered':
      return { label: 'Offered', cls: 'warn' }
    default:
      return { label: l.status.charAt(0).toUpperCase() + l.status.slice(1), cls: '' }
  }
}

interface Props {
  data: RouterData
  onShowConnections: (ip: string) => void
}

export function DhcpView({ data, onShowConnections }: Props) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const rows = data.leases?.rows ?? []
  // Counted from the live connection list so it is as fresh as the Connections page.
  const perIp = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of data.connections?.rows ?? []) m.set(c.srcAddress, (m.get(c.srcAddress) ?? 0) + 1)
    return m
  }, [data.connections])

  const filtered = useMemo(
    () =>
      rows.filter((l) => {
        if (filter === 'bound' && l.status !== 'bound') return false
        if (filter === 'static' && l.dynamic) return false
        if (filter === 'dynamic' && !l.dynamic) return false
        return matchesSearch(search, l.address, l.mac, l.hostName, l.comment, l.server)
      }),
    [rows, filter, search]
  )

  const columns = useMemo<Column<LeaseRow>[]>(
    () => [
      { key: 'ip', header: 'IP Address', width: 120, render: (l) => <span className="selectable">{l.address}</span>, sort: (l) => ipSortKey(l.address) },
      { key: 'mac', header: 'MAC Address', width: 130, render: (l) => <span className="selectable">{l.mac}</span>, sort: (l) => l.mac },
      { key: 'host', header: 'Hostname', width: 150, grow: 1, render: (l) => l.hostName ?? '', sort: (l) => (l.hostName ?? '~').toLowerCase() },
      { key: 'comment', header: 'Comment', width: 150, grow: 1, render: (l) => l.comment ?? '', sort: (l) => (l.comment ?? '~').toLowerCase() },
      {
        key: 'status',
        header: 'Status',
        width: 80,
        render: (l) => {
          const s = statusOf(l)
          return <span className={s.cls}>{s.label}</span>
        },
        sort: (l) => statusOf(l).label
      },
      { key: 'type', header: 'Type', width: 72, render: (l) => (l.dynamic ? 'Dynamic' : 'Static'), sort: (l) => Number(l.dynamic) },
      { key: 'server', header: 'Server', width: 90, render: (l) => l.server ?? '', sort: (l) => l.server ?? '' },
      {
        key: 'expires',
        header: 'Expires In',
        width: 84,
        align: 'right',
        render: (l) => <span className="num">{formatDuration(l.expiresAfterSec)}</span>,
        sort: (l) => l.expiresAfterSec ?? Number.MAX_SAFE_INTEGER
      },
      {
        key: 'seen',
        header: 'Last Seen',
        width: 84,
        align: 'right',
        render: (l) => <span className="num">{formatDuration(l.lastSeenSec)}</span>,
        sort: (l) => l.lastSeenSec ?? Number.MAX_SAFE_INTEGER
      },
      {
        key: 'conns',
        header: 'Connections',
        width: 90,
        align: 'right',
        render: (l) => {
          const n = perIp.get(l.address) ?? 0
          return n > 0 ? (
            <button className="link num" onClick={() => onShowConnections(l.address)}>
              {n}
            </button>
          ) : (
            <span className="muted num">0</span>
          )
        },
        sort: (l) => perIp.get(l.address) ?? 0,
        sortDesc: true
      }
    ],
    [onShowConnections, perIp]
  )

  return (
    <div className="page">
      <div className="toolbar">
        <h1 className="page-title">DHCP Leases</h1>
        <SearchBox value={search} onChange={setSearch} />
        <ButtonGroup
          value={filter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'bound', label: 'Bound' },
            { value: 'static', label: 'Static' },
            { value: 'dynamic', label: 'Dynamic' }
          ]}
          onChange={setFilter}
        />
        <span className="count">
          {formatNumber(filtered.length)} of {formatNumber(rows.length)}
        </span>
      </div>
      {data.leases?.error && <div className="notice error">{data.leases.error}</div>}
      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(l) => l.id}
        initialSort={{ key: 'ip', dir: 'asc' }}
        empty={data.leases ? 'No leases' : 'Loading…'}
      />
    </div>
  )
}
