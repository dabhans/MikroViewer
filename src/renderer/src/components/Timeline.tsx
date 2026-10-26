import { useRef, useState } from 'react'
import type { LogHistogram } from '../../../shared/types'
import { formatNumber } from '../format'

const pad = (n: number): string => String(n).padStart(2, '0')

function label(t: number, spanMs: number): string {
  const d = new Date(t)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (spanMs <= 24 * 3600_000) return time
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`
}

interface Props {
  histogram: LogHistogram
  /** Drag across the bars to zoom in on that time span. */
  onSelect: (from: number, to: number) => void
}

export function Timeline({ histogram, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const { counts, blocked, bucketMs, from } = histogram
  const n = counts.length
  const max = Math.max(1, ...counts)
  const span = n * bucketMs

  const bucketAt = (clientX: number): number => {
    const bars = ref.current?.querySelector('.bars')
    if (!bars || n === 0) return 0
    const r = bars.getBoundingClientRect()
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)))
  }

  const finish = (): void => {
    if (!drag) return
    const lo = Math.min(drag.a, drag.b)
    const hi = Math.max(drag.a, drag.b)
    setDrag(null)
    onSelect(from + lo * bucketMs, from + (hi + 1) * bucketMs)
  }

  const labels = n > 0 ? [0, 0.25, 0.5, 0.75, 1].map((f) => label(from + f * span, span)) : []
  const sel = drag && { left: (Math.min(drag.a, drag.b) / n) * 100, width: ((Math.abs(drag.a - drag.b) + 1) / n) * 100 }

  return (
    <div
      className="timeline"
      ref={ref}
      title="Drag to zoom in"
      onMouseDown={(e) => {
        if (e.button !== 0) return
        const i = bucketAt(e.clientX)
        setDrag({ a: i, b: i })
      }}
      onMouseMove={(e) => {
        const i = bucketAt(e.clientX)
        setHover(i)
        if (drag) setDrag({ ...drag, b: i })
      }}
      onMouseUp={finish}
      onMouseLeave={() => {
        setHover(null)
        finish()
      }}
    >
      <span className="y-max num">{formatNumber(max)}</span>
      <span className="y-zero num">0</span>
      <div className="bars">
        {counts.map((c, i) => (
          <div key={i} className="bucket">
            <div className="allowed" style={{ height: `${((c - blocked[i]) / max) * 100}%` }} />
            <div className="blocked" style={{ height: `${(blocked[i] / max) * 100}%` }} />
          </div>
        ))}
        {sel && <div className="selection" style={{ left: `${sel.left}%`, width: `${sel.width}%` }} />}
      </div>
      <div className="x-labels">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
      {hover !== null && !drag && n > 0 && (
        <div className="tip" style={hover / n > 0.6 ? { right: `${(1 - hover / n) * 100}%` } : { left: `calc(46px + ${(hover / n) * 100}%)` }}>
          <div className="muted">
            {label(from + hover * bucketMs, span)} – {label(from + (hover + 1) * bucketMs, span)}
          </div>
          <div>
            <b>{formatNumber(counts[hover])}</b> records
            {blocked[hover] > 0 && (
              <span className="err">
                {' '}
                · {formatNumber(blocked[hover])} blocked
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
