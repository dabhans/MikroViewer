import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LeaseRow, RouterLogEntry } from '../../../shared/types'
import { DataTable, type Column } from '../components/DataTable'
import { SearchBox, matchesSearch } from '../components/Controls'
import { cleanError } from '../components/RouterForm'
import { routerLogReader, type LogLevel, type ReadableLogEntry } from '../explain'
import { formatNumber } from '../format'
import { storageGet, storageSet } from '../storage'

type Row = RouterLogEntry & ReadableLogEntry & { idx: number }

const LEVEL_LABEL: Record<LogLevel, string> = { error: 'Error', warning: 'Warning', info: 'Info', debug: 'Debug' }
const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warning: 1, info: 2, debug: 3 }

function Level({ level }: { level: LogLevel }) {
  return (
    <span className={`level ${level}`}>
      <i />
      {LEVEL_LABEL[level]}
    </span>
  )
}

function columns(original: boolean): Column<Row>[] {
  return [
    { key: 'time', header: 'Time', width: 130, render: (r) => <span className="num">{r.time}</span>, sort: (r) => r.idx, sortDesc: true },
    { key: 'level', header: 'Level', width: 76, render: (r) => <Level level={r.level} />, sort: (r) => LEVEL_RANK[r.level] },
    {
      key: 'category',
      header: 'Category',
      width: 96,
      render: (r) => <span title={`Topics: ${r.topics.join(', ')}`}>{r.category}</span>,
      sort: (r) => r.category,
      copy: (r) => [r.category, r.topics.join(',')]
    },
    {
      key: 'message',
      header: 'Message',
      width: 400,
      // Extra width goes to the messages rather than the short columns.
      grow: 4,
      render: (r) => {
        const text = original ? r.message : r.text
        return (
          <span className="cell selectable" title={text === r.message ? r.message : `${text}\n\nThe router wrote: ${r.message}`}>
            {text}
          </span>
        )
      },
      copy: (r) => [original ? r.message : r.text, original ? r.text : r.message]
    }
  ]
}

const REFRESH_MS = 5000

export function RouterLogView({ routerId, leases }: { routerId: string; leases?: LeaseRow[] }) {
  const [entries, setEntries] = useState<RouterLogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [original, setOriginal] = useState(() => storageGet('mv.syslog.original') === '1')
  const [auto, setAuto] = useState(true)

  const load = useCallback(async () => {
    try {
      setEntries(await window.api.routerLog(routerId))
      setError(null)
    } catch (err) {
      setError(cleanError(err))
    }
  }, [routerId])

  useEffect(() => {
    setEntries(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(t)
  }, [auto, load])

  // Device names in the messages come from the DHCP leases.
  const rows = useMemo<Row[] | null>(() => {
    if (!entries) return null
    const read = routerLogReader(leases)
    return entries.map((e, idx) => ({ ...e, ...read(e), idx }))
  }, [entries, leases])

  const categories = useMemo(() => [...new Set((rows ?? []).map((r) => r.category))].sort(), [rows])
  const filtered = useMemo(
    () => (rows ?? []).filter((r) => (!category || r.category === category) && matchesSearch(search, r.text, r.message, r.time, r.category, ...r.topics)),
    [rows, category, search]
  )
  const cols = useMemo(() => columns(original), [original])

  return (
    <div className="page">
      <div className="toolbar">
        <h1 className="page-title">System Log</h1>
        <SearchBox value={search} onChange={setSearch} />
        <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="check" title="Show the messages exactly as the router writes them">
          <input
            type="checkbox"
            checked={original}
            onChange={(e) => {
              setOriginal(e.target.checked)
              storageSet('mv.syslog.original', e.target.checked ? '1' : '0')
            }}
          />
          Original messages
        </label>
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
      <DataTable rows={filtered} columns={cols} rowKey={(r) => r.id} initialSort={{ key: 'time', dir: 'desc' }} empty={rows ? 'No entries' : 'Loading…'} />
    </div>
  )
}
