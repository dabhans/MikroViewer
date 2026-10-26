import type { ConnectionRow, LeaseRow } from '../../shared/types'

export interface DeviceAggregate {
  ip: string
  name?: string
  mac?: string
  connections: number
  rxBps: number
  txBps: number
  bytes: number
  topDestinations: string[]
}

export function isPrivateIp(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4) return /^f[cd]/i.test(ip) || /^fe80/i.test(ip)
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254)
  )
}

/** Groups connections by source IP to show which devices are using the network. */
export function aggregateDevices(rows: ConnectionRow[], leases: LeaseRow[] = []): DeviceAggregate[] {
  const leaseByIp = new Map(leases.map((l) => [l.address, l]))
  const map = new Map<string, DeviceAggregate & { dst: Map<string, number> }>()
  for (const r of rows) {
    let d = map.get(r.srcAddress)
    if (!d) {
      d = {
        ip: r.srcAddress,
        name: r.srcName,
        mac: leaseByIp.get(r.srcAddress)?.mac,
        connections: 0,
        rxBps: 0,
        txBps: 0,
        bytes: 0,
        topDestinations: [],
        dst: new Map()
      }
      map.set(r.srcAddress, d)
    }
    d.connections++
    d.rxBps += r.rxBps
    d.txBps += r.txBps
    d.bytes += r.rxBytes + r.txBytes
    const dn = r.dstName ?? r.dstAddress
    d.dst.set(dn, (d.dst.get(dn) ?? 0) + r.rxBytes + r.txBytes + 1)
  }
  return [...map.values()].map(({ dst, ...d }) => ({
    ...d,
    topDestinations: [...dst.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map((e) => e[0])
  }))
}
