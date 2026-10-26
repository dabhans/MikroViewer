import { useEffect, type ReactNode } from 'react'

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

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          {title}
          <button className="modal-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Panel({ title, aside, children, className, bodyClass }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      <div className="panel-head">
        {title}
        {aside !== undefined && <span className="aside">{aside}</span>}
      </div>
      <div className={bodyClass ?? 'panel-body'}>{children}</div>
    </section>
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
