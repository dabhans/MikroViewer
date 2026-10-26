// Converts RouterOS text values into numbers and structures.

import type { ApiRecord } from './client'
import type { HealthSensor } from '../../shared/types'

export function num(v: string | undefined, fallback = 0): number {
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function bool(v: string | undefined): boolean {
  return v === 'true' || v === 'yes'
}

const UNIT_SECONDS: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001, us: 1e-6, ns: 1e-9 }

/** "1w2d3h4m5s", "3m10s250ms", "1d02:03:04" and "00:00:10" → seconds. */
export function parseDuration(s: string | undefined): number {
  if (!s) return 0
  let rest = s.trim()
  let total = 0
  const clock = rest.match(/(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/)
  if (clock) {
    total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
    rest = rest.slice(0, clock.index)
  }
  for (const m of rest.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|w|d|h|m|s)/g)) {
    total += Number(m[1]) * UNIT_SECONDS[m[2]]
  }
  return total
}

/** "192.168.88.10:51234" → { ip, port }. IPv4 without a port (e.g. ICMP) is returned without port. */
export function splitHostPort(s: string | undefined): { ip: string; port?: number } {
  if (!s) return { ip: '' }
  const i = s.lastIndexOf(':')
  if (i > 0 && s.indexOf(':') === i) {
    const port = Number(s.slice(i + 1))
    return Number.isFinite(port) ? { ip: s.slice(0, i), port } : { ip: s }
  }
  return { ip: s }
}

/** Strips the prefix length from an address such as "192.168.88.1/24". */
export function stripPrefix(addr: string | undefined): string {
  if (!addr) return ''
  const i = addr.indexOf('/')
  return i === -1 ? addr : addr.slice(0, i)
}

const SENSOR_LABELS: Record<string, string> = {
  'cpu-temperature': 'CPU temperature',
  temperature: 'Temperature',
  'board-temperature1': 'Board temperature',
  'board-temperature2': 'Board temperature 2',
  'switch-temperature': 'Switch temperature',
  'sfp-temperature': 'SFP temperature',
  'phy-temperature': 'PHY temperature',
  voltage: 'Voltage',
  current: 'Current',
  'power-consumption': 'Power consumption',
  'psu1-voltage': 'PSU 1 voltage',
  'psu2-voltage': 'PSU 2 voltage',
  'psu1-current': 'PSU 1 current',
  'psu2-current': 'PSU 2 current',
  'psu1-state': 'PSU 1',
  'psu2-state': 'PSU 2',
  'fan-state': 'Fan'
}

function sensorLabel(name: string): string {
  if (SENSOR_LABELS[name]) return SENSOR_LABELS[name]
  const fan = name.match(/^fan(\d+)-speed$/)
  if (fan) return `Fan ${fan[1]}`
  const s = name.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function unitFor(name: string, type?: string): string {
  if (type) return type === 'C' ? '°C' : type
  if (name.includes('temperature')) return '°C'
  if (name.includes('voltage')) return 'V'
  if (name.includes('current')) return 'A'
  if (name.includes('power')) return 'W'
  if (name.includes('speed')) return 'RPM'
  return ''
}

const IGNORED_V6_KEYS = new Set(['.id', 'state-after-reboot', 'use-fan', 'active-fan', 'fan-mode', 'fan-switch', 'fan-on-threshold'])

/**
 * RouterOS 7 returns one record per sensor (name/value/type).
 * RouterOS 6 returns a single record with every sensor as an attribute.
 */
export function parseHealth(records: ApiRecord[]): HealthSensor[] {
  const out: HealthSensor[] = []
  if (records.length && 'name' in records[0] && 'value' in records[0]) {
    for (const r of records) {
      const n = Number(r.value)
      out.push({ name: r.name, label: sensorLabel(r.name), value: Number.isFinite(n) ? n : r.value, unit: unitFor(r.name, r.type) })
    }
    return out
  }
  for (const r of records) {
    for (const [key, value] of Object.entries(r)) {
      if (IGNORED_V6_KEYS.has(key)) continue
      const n = Number(value)
      out.push({ name: key, label: sensorLabel(key), value: Number.isFinite(n) ? n : value, unit: unitFor(key) })
    }
  }
  return out
}

/** Picks the most relevant temperature for the dashboard. */
export function primaryTemperature(sensors: HealthSensor[]): number | undefined {
  const temps = sensors.filter((s) => s.name.includes('temperature') && typeof s.value === 'number')
  const pick =
    temps.find((s) => s.name === 'cpu-temperature') ?? temps.find((s) => s.name === 'temperature') ?? temps[0]
  return pick ? (pick.value as number) : undefined
}
