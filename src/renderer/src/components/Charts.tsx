import { useRef, useState } from 'react'
import type { TrafficPoint } from '../../../shared/types'
import { formatTime } from '../format'

function linePath(values: number[], max: number, w: number, h: number): string {
  if (values.length === 0) return ''
  const step = values.length > 1 ? w / (values.length - 1) : 0
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(h - (Math.min(v, max) / max) * h).toFixed(2)}`)
    .join('')
}

function areaPath(values: number[], max: number, w: number, h: number): string {
  if (values.length < 2) return ''
  return `${linePath(values, max, w, h)}L${w},${h}L0,${h}Z`
}

/** Rounds the chart ceiling up to a nice number (1, 2, 2.5, 5 × 10^n). */
function niceCeil(v: number): number {
  if (v <= 0) return 1000
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp
  return 10 * exp
}

export interface Series {
  label: string
  color: string
  values: number[]
}

interface LineChartProps {
  times: number[]
  series: Series[]
  format: (v: number) => string
  /** Fixed ceiling (e.g. 100 for %). Omitted = scale to the data. */
  yMax?: number
  height?: number
}

const AXIS_W = 58
const X_LABEL_H = 18
const GRID_STEPS = [0, 0.25, 0.5, 0.75, 1]

/** Line chart with a grid, y-axis labels and a hover readout. */
export function LineChart({ times, series, format, yMax, height = 180 }: LineChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = 1000
  const H = 300
  const plotH = height - X_LABEL_H
  const max = yMax ?? niceCeil(Math.max(0, ...series.flatMap((s) => s.values)) * 1.1)
  const n = times.length
  const spanSec = n > 1 ? Math.round((times[n - 1] - times[0]) / 1000) : 0

  const onMove = (e: React.MouseEvent): void => {
    const el = ref.current
    if (!el || n < 2) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left - AXIS_W
    if (x < 0) return setHover(null)
    setHover(Math.max(0, Math.min(n - 1, Math.round((x / (rect.width - AXIS_W)) * (n - 1)))))
  }
  const pct = hover !== null && n > 1 ? hover / (n - 1) : 0

  return (
    <div className="chart" style={{ height }} ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {GRID_STEPS.map((f) => (
        <div key={f}>
          <div className="grid-line" style={{ top: (1 - f) * plotH }} />
          <div className="y-label" style={{ top: (1 - f) * plotH }}>
            {format(max * f)}
          </div>
        </div>
      ))}
      {n < 2 ? (
        <div className="chart-empty" style={{ position: 'absolute', top: 0, left: AXIS_W, right: 0, height: plotH }}>
          Collecting data…
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: plotH }}>
          {series.map((s, i) => (
            <g key={s.label}>
              {i === 0 && <path d={areaPath(s.values, max, W, H)} fill={s.color} fillOpacity="0.12" />}
              <path d={linePath(s.values, max, W, H)} fill="none" stroke={s.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </svg>
      )}
      <div className="x-labels">
        <span>{spanSec > 0 ? `-${Math.max(1, Math.round(spanSec / 60))} min` : ''}</span>
        <span>now</span>
      </div>
      {hover !== null && n > 1 && (
        <>
          <div className="hover-line" style={{ left: `calc(${AXIS_W}px + (100% - ${AXIS_W}px) * ${pct})`, height: plotH }} />
          <div
            className="tip"
            style={pct > 0.6 ? { right: `calc((100% - ${AXIS_W}px) * ${1 - pct} + 10px)` } : { left: `calc(${AXIS_W}px + (100% - ${AXIS_W}px) * ${pct} + 10px)` }}
          >
            <div className="muted">{formatTime(times[hover])}</div>
            {series.map((s) => (
              <div key={s.label}>
                <span style={{ color: s.color }}>■</span> {s.label}: <b>{format(s.values[hover])}</b>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Small two-line traffic graph for table rows. */
export function MiniTraffic({ points, height = 18 }: { points: TrafficPoint[]; height?: number }) {
  const W = 200
  const max = Math.max(1, ...points.map((p) => Math.max(p.rx, p.tx)))
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height} style={{ display: 'block' }}>
      <path d={linePath(points.map((p) => p.rx), max, W, height)} fill="none" stroke="var(--rx)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <path d={linePath(points.map((p) => p.tx), max, W, height)} fill="none" stroke="var(--tx)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
