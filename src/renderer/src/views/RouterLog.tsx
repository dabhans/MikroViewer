import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RouterLogEntry } from '../../../shared/types'
import { DataTable, type Column } from '../components/DataTable'
import { SearchBox, matchesSearch } from '../components/Controls'
import { cleanError } from '../components/RouterForm'
import { formatNumber } from '../format'

type Row = RouterLogEntry & { idx: number }

function severity(topics: string[]): string {
  if (topics.includes('error') || topics.includes('critical')) return 'err'
  if (topics.includes('warning')) return 'warn'
  return ''
}

const columns: Column<Row>[] = [
  { key: 'time', header: 'Time', width: 130, render: (r) => <span className="num">{r.time}</span>, sort: (r) => r.idx, sortDesc: true },
  { key: 'topics', header: 'Topics', width: 170, render: (r) => <span className={severity(r.topics)}>{r.topics.join(', ')}</span>, sort: (r) => r.topics.join(',') },
  {
    key: 'message',
    header: 'Message',
    width: 400,
    grow: 1,
    render: (r) => (
      <span className={`cell selectable ${severity(r.topics)}`} title={r.message}>
        {r.message}
      </span>
    )
  }
]

const REFRESH_MS = 5000

export function RouterLogView({ routerId }: { routerId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [topic, setTopic] = useState('')
  const [auto, setAuto] = useState(true)

  const load = useCallback(async () => {
    try {
      const entries = await window.api.routerLog(routerId)
      setRows(entries.map((e, idx) => ({ ...e, idx })))
      setError(null)
    } catch (err) {
      setError(cleanError(err))
    }
  }, [routerId])

  useEffect(() => {
    setRows(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(t)
  }, [auto, load])

  const topics = useMemo(() => [...new Set((rows ?? []).flatMap((r) => r.topics))].sort(), [rows])
  const filtered = useMemo(
    () => (rows ?? []).filter((r) => (!topic || r.topics.includes(topic)) && matchesSearch(search, r.message, r.time, ...r.topics)),
    [rows, topic, search]
  )

  return (
    <div className="page">
      <div className="toolbar">
        <h1 className="page-title">System Log</h1>
        <SearchBox value={search} onChange={setSearch} />
        <select className="select" value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="">All topics</option>
          {topics.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto refresh
        </label>
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
        <span className="count">
          {formatNumber(filtered.length)} of {formatNumber(rows?.length ?? 0)}
        </span>
      </div>
      {error && <div className="notice error">{error}</div>}
      <DataTable rows={filtered} columns={columns} rowKey={(r) => r.id} initialSort={{ key: 'time', dir: 'desc' }} empty={rows ? 'No entries' : 'Loading…'} />
    </div>
  )
}
