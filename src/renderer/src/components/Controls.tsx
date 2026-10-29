import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      className="input search"
      type="search"
      value={value}
      placeholder="Search"
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
  )
}

/** Row of toggle buttons where exactly one is selected. */
export function ButtonGroup<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="group">
      {options.map((o) => (
        <button key={o.value} className={`btn${o.value === value ? ' on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** The × in a dialog or panel head. Drawn rather than typed, so it sits in the middle of the button. */
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="modal-close" onClick={onClick} title="Close" aria-label="Close">
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 1 9 9M9 1 1 9" />
      </svg>
    </button>
  )
}

export function Modal({ title, onClose, children, wide, width }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} style={width ? { width: `min(${width}px, calc(100vw - 40px))` } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          {title}
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  )
}

export function Panel({
  title,
  aside,
  children,
  className,
  bodyClass,
  style
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  style?: React.CSSProperties
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`} style={style}>
      <div className="panel-head">
        {title}
        {aside !== undefined && <span className="aside">{aside}</span>}
      </div>
      <div className={bodyClass ?? 'panel-body'}>{children}</div>
    </section>
  )
}

export type MenuItem = { label: string; onClick: () => void; disabled?: boolean } | 'separator'

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** Right-click menu at the mouse position. Closes on click outside, Escape or scrolling. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 4), top: Math.min(menu.y, window.innerHeight - r.height - 4) })
  }, [menu])

  useEffect(() => {
    const close = (e: Event): void => {
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
      onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  return (
    <div className="menu" ref={ref} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            title={item.label}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

/** Matches text across several fields. A full IPv4 address must match a field exactly. */
export function matchesSearch(query: string, ...fields: (string | number | undefined)[]): boolean {
  if (!query) return true
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const values = fields.filter((f) => f !== undefined && f !== '').map((f) => String(f).toLowerCase())
  const hay = values.join(' ')
  return terms.every((t) => (/^\d+\.\d+\.\d+\.\d+$/.test(t) ? values.includes(t) : hay.includes(t)))
}
