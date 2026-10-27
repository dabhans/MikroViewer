import { useMemo, useState } from 'react'
import type { InterfaceRow } from '../../../shared/types'
import type { RouterData } from '../store'
import { DataTable, type Column } from '../components/DataTable'
import { MiniTraffic } from '../components/Charts'
import { SearchBox, matchesSearch } from '../components/Controls'
import { formatBps, formatBytes } from '../format'

function status(i: InterfaceRow): { label: string; cls: string } {
  if (i.disabled) return { label: 'Disabled', cls: 'muted' }
  if (i.running) return { label: 'Up', cls: 'ok' }
  return { label: 'Down', cls: 'err' }
}

const columns: Column<InterfaceRow>[] = [
  { key: 'name', header: 'Name', width: 130, render: (i) => (i.isWan ? `${i.name} (WAN)` : i.name), sort: (i) => i.name },
  { key: 'type', header: 'Type', width: 80, render: (i) => i.type, sort: (i) => i.type },
  {
    key: 'status',
    header: 'Status',
    width: 72,
    render: (i) => {
      const s = status(i)
      return <span className={s.cls}>{s.label}</span>
    },
    sort: (i) => (i.disabled ? 2 : i.running ? 0 : 1)
  },
  { key: 'rx', header: 'Rx Rate', width: 90, render: (i) => <span className="num">{formatBps(i.rxBps)}</span>, sort: (i) => i.rxBps, sortDesc: true },
  { key: 'tx', header: 'Tx Rate', width: 90, render: (i) => <span className="num">{formatBps(i.txBps)}</span>, sort: (i) => i.txBps, sortDesc: true },
  { key: 'graph', header: 'Last 3 min', width: 150, render: (i) => <div style={{ width: '100%' }}><MiniTraffic points={i.history} /></div> },
  { key: 'rxBytes', header: 'Rx Total', width: 84, render: (i) => <span className="num">{formatBytes(i.rxBytes)}</span>, sort: (i) => i.rxBytes, sortDesc: true },
  { key: 'txBytes', header: 'Tx Total', width: 84, render: (i) => <span className="num">{formatBytes(i.txBytes)}</span>, sort: (i) => i.txBytes, sortDesc: true },
  { key: 'mac', header: 'MAC Address', width: 130, render: (i) => <span className="selectable">{i.mac ?? ''}</span>, sort: (i) => i.mac ?? '' },
  { key: 'comment', header: 'Comment', width: 120, grow: 1, render: (i) => i.comment ?? '', sort: (i) => i.comment ?? '' }
]

export function InterfacesView({ data }: { data: RouterData }) {
  const [search, setSearch] = useState('')
  const [onlyUp, setOnlyUp] = useState(false)
  const rows = data.interfaces ?? []
  const filtered = useMemo(
    () => rows.filter((i) => (!onlyUp || (i.running && !i.disabled)) && matchesSearch(search, i.name, i.type, i.comment, i.mac)),
    [rows, onlyUp, search]
  )

  return (
    <div className="page">
      <div className="toolbar">
        <h1 className="page-title">Interfaces</h1>
        <SearchBox value={search} onChange={setSearch} />
        <label className="check">
          <input type="checkbox" checked={onlyUp} onChange={(e) => setOnlyUp(e.target.checked)} />
          Up only
        </label>
        <span className="count">
          {rows.filter((i) => i.running && !i.disabled).length} of {rows.length} up
        </span>
      </div>
      <DataTable rows={filtered} columns={columns} rowKey={(i) => i.id} initialSort={{ key: 'status', dir: 'asc' }} empty={data.interfaces ? 'No interfaces' : 'Loading…'} />
    </div>
  )
}
