import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: string
  /** Minimum width in px. */
  width: number
  /** Share of extra space (fr). Omit for fixed columns. */
  grow?: number
  render: (row: T) => ReactNode
  sort?: (row: T) => number | string
  /** First click sorts descending (handy for numbers such as traffic). */
  sortDesc?: boolean
  align?: 'right'
  title?: string
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  rowHeight?: number
  initialSort?: SortState
  empty?: string
  onRowClick?: (row: T) => void
}

const OVERSCAN = 10

/** Virtualised grid – only visible rows are rendered, so thousands of connections are fine. */
export function DataTable<T>({ rows, columns, rowKey, rowHeight = 25, initialSort, empty, onRowClick }: Props<T>) {
  const [sort, setSort] = useState<SortState | undefined>(initialSort)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => setViewport({ top: el.scrollTop, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const sortFn = columns.find((c) => c.key === sort?.key)?.sort
  const sorted = useMemo(() => {
    if (!sort || !sortFn) return rows
    const keyed = rows.map((r) => [sortFn(r), r] as const)
    const dir = sort.dir === 'asc' ? 1 : -1
    keyed.sort((a, b) => (a[0] < b[0] ? -dir : a[0] > b[0] ? dir : 0))
    return keyed.map((k) => k[1])
    // sortFn changes identity on every render; the key and the rows are what matter.
  }, [rows, sort?.key, sort?.dir])

  const template = columns.map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`)).join(' ')
  const minWidth = columns.reduce((s, c) => s + c.width, 0)

  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - OVERSCAN)
  const end = Math.min(sorted.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN)
  const visible = sorted.slice(start, end)

  const onHeader = (c: Column<T>): void => {
    if (!c.sort) return
    setSort((s) =>
      s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.sortDesc ? 'desc' : 'asc' }
    )
  }

  return (
    <div className="table">
      <div
        className="table-scroll"
        ref={scrollRef}
        onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      >
        <div className="table-head" style={{ gridTemplateColumns: template, minWidth }}>
          {columns.map((c) => (
            <button
              key={c.key}
              className={`th${c.sort ? ' sortable' : ''}${c.align === 'right' ? ' right' : ''}`}
              onClick={() => onHeader(c)}
              title={c.title}
              tabIndex={c.sort ? 0 : -1}
            >
              {c.header}
              {sort?.key === c.key && <span className="muted">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
            </button>
          ))}
        </div>
        {sorted.length === 0 ? (
          <div className="table-empty" style={{ minWidth }}>
            {empty ?? 'No entries'}
          </div>
        ) : (
          <div className="table-body" style={{ height: sorted.length * rowHeight, minWidth }}>
            {visible.map((row, i) => (
              <div
                key={rowKey(row)}
                className={`tr${(start + i) % 2 ? ' alt' : ''}${onRowClick ? ' clickable' : ''}`}
                style={{ top: (start + i) * rowHeight, height: rowHeight, gridTemplateColumns: template }}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <div key={c.key} className={`td${c.align === 'right' ? ' right' : ''}`}>
                    {c.render(row)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Single-line cell: main text with optional muted text after it (e.g. a name followed by its IP). */
export function Cell({ main, sub, title }: { main: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <span className="cell" title={title}>
      {main}
      {sub !== undefined && sub !== '' && <span className="sub">{sub}</span>}
    </span>
  )
}
