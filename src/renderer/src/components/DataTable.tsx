import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ContextMenu, type MenuItem, type MenuState } from './Controls'

export interface Column<T> {
  key: string
  header: string
  /** Minimum width in px. Wider windows widen every column by the same factor. */
  width: number
  /** Takes this many times its share of extra space (default 1). */
  grow?: number
  render: (row: T) => ReactNode
  sort?: (row: T) => number | string
  /** First click sorts descending (handy for numbers such as traffic). */
  sortDesc?: boolean
  /** The values "Copy" offers for a cell, first one used for "Copy row". Default: the cell's text. */
  copy?: (row: T) => (string | number | undefined)[]
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
  selectedKey?: string | null
  /** Replaces the default right-click menu (Copy). */
  onCellContextMenu?: (row: T, columnKey: string, e: React.MouseEvent) => void
  /** Called when the view reaches or leaves the top row. */
  onTopChange?: (atTop: boolean) => void
}

const OVERSCAN = 10

function cellValues<T>(c: Column<T>, row: T, el: HTMLElement | null): string[] {
  const raw = c.copy ? c.copy(row) : [el?.innerText]
  return [...new Set(raw.filter((v) => v !== undefined && v !== '').map((v) => String(v).trim()))].filter(Boolean)
}

/** "Copy" menu items for a cell, and "Copy row" (tab separated, pastes into a spreadsheet). */
export function copyItems<T>(columns: Column<T>[], row: T, columnKey: string, cellEl: HTMLElement): MenuItem[] {
  const rowEl = cellEl.parentElement
  const col = columns.find((c) => c.key === columnKey)
  const items: MenuItem[] = (col ? cellValues(col, row, cellEl) : []).map((v) => ({
    label: `Copy "${v.length > 48 ? v.slice(0, 47) + '…' : v}"`,
    onClick: () => void navigator.clipboard.writeText(v)
  }))
  const line = columns.map((c, i) => cellValues(c, row, (rowEl?.children[i] as HTMLElement) ?? null)[0] ?? '').join('\t')
  if (items.length) items.push('separator')
  items.push({ label: 'Copy row', onClick: () => void navigator.clipboard.writeText(line) })
  return items
}

/** Virtualised grid – only visible rows are rendered, so thousands of connections are fine. */
export function DataTable<T>({ rows, columns, rowKey, rowHeight = 25, initialSort, empty, onRowClick, selectedKey, onCellContextMenu, onTopChange }: Props<T>) {
  const [sort, setSort] = useState<SortState | undefined>(initialSort)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const atTop = viewport.top < rowHeight

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => setViewport({ top: el.scrollTop, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => onTopChange?.(atTop), [atTop, onTopChange])

  const sortFn = columns.find((c) => c.key === sort?.key)?.sort
  const sorted = useMemo(() => {
    if (!sort || !sortFn) return rows
    const keyed = rows.map((r) => [sortFn(r), r] as const)
    const dir = sort.dir === 'asc' ? 1 : -1
    keyed.sort((a, b) => (a[0] < b[0] ? -dir : a[0] > b[0] ? dir : 0))
    return keyed.map((k) => k[1])
    // sortFn changes identity on every render; the key and the rows are what matter.
  }, [rows, sort?.key, sort?.dir])

  // Every column grows in proportion to its width, so extra space is shared out evenly.
  const template = columns.map((c) => `minmax(${c.width}px, ${c.width * (c.grow ?? 1)}fr)`).join(' ')
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

  const onContextMenu = (row: T, key: string, e: React.MouseEvent<HTMLDivElement>): void => {
    if (onCellContextMenu) return onCellContextMenu(row, key, e)
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items: copyItems(columns, row, key, e.currentTarget) })
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
              className={`th${c.sort ? ' sortable' : ''}`}
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
            {visible.map((row, i) => {
              const key = rowKey(row)
              return (
                <div
                  key={key}
                  className={`tr${(start + i) % 2 ? ' alt' : ''}${onRowClick ? ' clickable' : ''}${key === selectedKey ? ' selected' : ''}`}
                  style={{ top: (start + i) * rowHeight, height: rowHeight, gridTemplateColumns: template }}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => (
                    <div key={c.key} className="td" onContextMenu={(e) => onContextMenu(row, c.key, e)}>
                      {c.render(row)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
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
