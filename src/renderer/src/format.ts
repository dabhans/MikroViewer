// Number formatting follows the operating system's locale.
const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

export function formatNumber(n: number): string {
  return nf0.format(n)
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${(i === 0 || v >= 100 ? nf0 : nf1).format(v)} ${units[i]}`
}

export function formatBps(bps: number | undefined): string {
  if (!bps || bps < 1 || !Number.isFinite(bps)) return '0 bps'
  const units = ['bps', 'kbps', 'Mbps', 'Gbps']
  let v = bps
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${(i === 0 || v >= 100 ? nf0 : nf1).format(v)} ${units[i]}`
}

/** Short duration: "3d 4h 12m", "4h 12m", "12m 5s", "5s". */
export function formatDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return ''
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (d) return `${d}d ${h}h ${m}m`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${r}s`
  return `${r}s`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 24-hour HH:MM:SS, like log views in network equipment. */
export function formatTime(t: number): string {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** YYYY-MM-DD HH:MM:SS */
export function formatDateTime(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(t)}`
}

export function formatSensor(value: number | string, unit: string): string {
  if (typeof value === 'string') return value
  const v = unit === 'RPM' ? nf0.format(value) : nf1.format(value)
  return unit ? `${v} ${unit}` : v
}

/** Sorts IPv4 addresses numerically so 10.0.0.9 comes before 10.0.0.10. */
export function ipSortKey(ip: string): string {
  const parts = ip.split('.')
  if (parts.length !== 4) return ip
  return parts.map((p) => p.padStart(3, '0')).join('.')
}
