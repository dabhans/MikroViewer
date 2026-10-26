import { useMemo, useState } from 'react'
import type { ConnectionRow } from '../../../shared/types'
import type { RouterData } from '../store'
import { Cell, DataTable, type Column } from '../components/DataTable'
import { ButtonGroup, SearchBox, matchesSearch } from '../components/Controls'
import { aggregateDevices, type DeviceAggregate } from '../devices'
import { formatBps, formatBytes, formatNumber, ipSortKey } from '../format'
import { matchesProtocol, serviceName, tcpStateLabel, type ProtocolFilter } from '../services'

export const PROTOCOL_OPTIONS: { value: ProtocolFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'icmp', label: 'ICMP' },
  { value: 'other', label: 'Other' }
]

export function ProtocolTag({ protocol }: { protocol: string }) {
  const cls = protocol === 'tcp' || protocol === 'udp' || protocol === 'icmp' ? protocol : 'other'
  return <span className={`tag ${cls}`}>{protocol ? protocol.toUpperCase() : '?'}</span>
}

type NatInfo = ConnectionRow['nat']

/** Name (or IP) with the IP after it. Outbound srcnat is almost universal, so it only goes in the tooltip. */
export function SourceCell({ name, ip, nat }: { name?: string; ip: string; nat?: NatInfo }) {
  const title = [name, ip, nat?.kind === 'srcnat' ? `NAT: ${nat.address}` : undefined].filter(Boolean).join('\n')
  return <Cell main={name ?? ip} sub={name ? ip : undefined} title={title} />
}

/** Port forwards (dstnat) are shown inline because they matter. */
export function DestinationCell({ name, ip, nat }: { name?: string; ip: string; nat?: NatInfo }) {
  const fwd = nat?.kind === 'dstnat' ? `→ ${nat.address}` : undefined
  const sub = [name ? ip : undefined, fwd].filter(Boolean).join(' ')
  return <Cell main={name ?? ip} sub={sub} title={[name, ip, fwd && `Forwarded to ${nat!.address}`].filter(Boolean).join('\n')} />
}

export const protocolColumn = <T extends { protocol: string }>(): Column<T> => ({
  key: 'proto',
  header: 'Protocol',
  width: 70,
  render: (r) => <ProtocolTag protocol={r.protocol} />,
  sort: (r) => r.protocol
})

export const portColumns = <T extends { protocol: string; dstPort?: number }>(): Column<T>[] => [
  { key: 'dstPort', header: 'Dst Port', width: 72, align: 'right', render: (r) => <span className="num">{r.dstPort ?? ''}</span>, sort: (r) => r.dstPort ?? -1 },
  { key: 'service', header: 'Service', width: 90, render: (r) => serviceName(r.protocol, r.dstPort) ?? '', sort: (r) => serviceName(r.protocol, r.dstPort) ?? '~' }
]

const listColumns: Column<ConnectionRow>[] = [
  protocolColumn(),
  {
    key: 'src',
    header: 'Source',
    width: 200,
    grow: 1.2,
    render: (r) => <SourceCell name={r.srcName} ip={r.srcAddress} nat={r.nat} />,
    sort: (r) => r.srcName?.toLowerCase() ?? ipSortKey(r.srcAddress)
  },
  {
    key: 'dst',
    header: 'Destination',
    width: 220,
    grow: 1.6,
    render: (r) => <DestinationCell name={r.dstName} ip={r.dstAddress} nat={r.nat} />,
    sort: (r) => r.dstName?.toLowerCase() ?? ipSortKey(r.dstAddress)
  },
  ...portColumns<ConnectionRow>(),
  { key: 'state', header: 'State', width: 96, render: (r) => tcpStateLabel(r.tcpState) ?? '', sort: (r) => r.tcpState ?? '' },
  {
    key: 'rx',
    header: 'Down',
    title: 'Current rate from destination to source',
    width: 88,
    align: 'right',
    render: (r) => <span className="num">{formatBps(r.rxBps)}</span>,
    sort: (r) => r.rxBps,
    sortDesc: true
  },
  {
    key: 'tx',
    header: 'Up',
    title: 'Current rate from source to destination',
    width: 88,
    align: 'right',
    render: (r) => <span className="num">{formatBps(r.txBps)}</span>,
    sort: (r) => r.txBps,
    sortDesc: true
  },
  {
    key: 'bytes',
    header: 'Bytes',
    width: 84,
    align: 'right',
    render: (r) => <span className="num">{formatBytes(r.rxBytes + r.txBytes)}</span>,
    sort: (r) => r.rxBytes + r.txBytes,
    sortDesc: true
  }
]

const deviceColumns: Column<DeviceAggregate>[] = [
  {
    key: 'device',
    header: 'Source',
    width: 200,
    grow: 1.2,
    render: (d) => <Cell main={d.name ?? d.ip} sub={d.name ? d.ip : undefined} />,
    sort: (d) => d.name?.toLowerCase() ?? ipSortKey(d.ip)
  },
  { key: 'mac', header: 'MAC Address', width: 130, render: (d) => d.mac ?? '', sort: (d) => d.mac ?? '' },
  { key: 'count', header: 'Connections', width: 90, align: 'right', render: (d) => <span className="num">{d.connections}</span>, sort: (d) => d.connections, sortDesc: true },
  { key: 'rx', header: 'Down', width: 88, align: 'right', render: (d) => <span className="num">{formatBps(d.rxBps)}</span>, sort: (d) => d.rxBps, sortDesc: true },
  { key: 'tx', header: 'Up', width: 88, align: 'right', render: (d) => <span className="num">{formatBps(d.txBps)}</span>, sort: (d) => d.txBps, sortDesc: true },
  { key: 'bytes', header: 'Bytes', width: 84, align: 'right', render: (d) => <span className="num">{formatBytes(d.bytes)}</span>, sort: (d) => d.bytes, sortDesc: true },
  {
    key: 'top',
    header: 'Top Destinations',
    width: 220,
    grow: 1.4,
    render: (d) => <Cell main={d.topDestinations.join(', ')} title={d.topDestinations.join('\n')} />
  }
]

interface Props {
  data: RouterData
  search: string
  onSearch: (s: string) => void
}

export function ConnectionsView({ data, search, onSearch }: Props) {
  const [proto, setProto] = useState<ProtocolFilter>('all')
  const [mode, setMode] = useState<'list' | 'source'>('list')
  const [frozen, setFrozen] = useState<ConnectionRow[] | null>(null)

  const live = data.connections?.rows ?? []
  const rows = frozen ?? live

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          matchesProtocol(r.protocol, proto) &&
          matchesSearch(search, r.srcAddress, r.srcName, r.dstAddress, r.dstName, r.dstPort, serviceName(r.protocol, r.dstPort), r.protocol, r.tcpState)
      ),
    [rows, proto, search]
  )
  const devices = useMemo(() => (mode === 'source' ? aggregateDevices(filtered, data.leases?.rows) : []), [mode, filtered, data.leases])

  return (
    <div className="page">
      <div className="toolbar">
        <h1 className="page-title">Connections</h1>
        <SearchBox value={search} onChange={onSearch} />
        <ButtonGroup value={proto} options={PROTOCOL_OPTIONS} onChange={setProto} />
        <ButtonGroup
          value={mode}
          options={[
            { value: 'list', label: 'List' },
            { value: 'source', label: 'By Source' }
          ]}
          onChange={setMode}
        />
        <button className={`btn${frozen ? ' on' : ''}`} onClick={() => setFrozen(frozen ? null : live)}>
          {frozen ? 'Resume' : 'Pause'}
        </button>
        <span className="count">
          {mode === 'source' ? `${formatNumber(devices.length)} sources` : `${formatNumber(filtered.length)} of ${formatNumber(rows.length)}`}
          {frozen && ' (paused)'}
        </span>
      </div>

      {data.connections?.throttled && (
        <div className="notice">Too many connections to list ({formatNumber(data.connections.total)}). Only the count is updated.</div>
      )}

      {mode === 'list' ? (
        <DataTable
          rows={filtered}
          columns={listColumns}
          rowKey={(r) => r.id}
          initialSort={{ key: 'bytes', dir: 'desc' }}
          empty={data.connections ? 'No connections' : 'Loading…'}
        />
      ) : (
        <DataTable
          rows={devices}
          columns={deviceColumns}
          rowKey={(d) => d.ip}
          initialSort={{ key: 'bytes', dir: 'desc' }}
          onRowClick={(d) => {
            setMode('list')
            onSearch(d.ip)
          }}
          empty="No connections"
        />
      )}
    </div>
  )
}
