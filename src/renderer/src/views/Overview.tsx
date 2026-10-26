import { useMemo } from 'react'
import type { RouterProfile, SessionStatus } from '../../../shared/types'
import type { RouterData } from '../store'
import type { Tab } from '../tabs'
import { LineChart } from '../components/Charts'
import { Panel } from '../components/Controls'
import { aggregateDevices, isPrivateIp } from '../devices'
import { formatBps, formatBytes, formatDuration, formatNumber, formatSensor } from '../format'

interface Props {
  data: RouterData
  profile: RouterProfile
  status: SessionStatus
  onNavigate: (tab: Tab, search?: string) => void
  onEdit: () => void
}

function barColor(pct: number): string {
  if (pct >= 90) return 'var(--err)'
  if (pct >= 75) return 'var(--warn)'
  return 'var(--accent)'
}

function Usage({ label, pct, value }: { label: string; pct: number; value: string }) {
  return (
    <div className="usage">
      <span>{label}</span>
      <div className="bar">
        <div style={{ width: `${Math.min(100, pct)}%`, background: barColor(pct) }} />
      </div>
      <span className="value num">{value}</span>
    </div>
  )
}

const pctFormat = (v: number): string => `${Math.round(v)} %`

export function OverviewView({ data, profile, status, onNavigate, onEdit }: Props) {
  const o = data.overview
  const topSources = useMemo(
    () =>
      aggregateDevices(data.connections?.rows ?? [], data.leases?.rows)
        .filter((d) => isPrivateIp(d.ip) && !d.name?.endsWith('(router)'))
        .sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps) || b.connections - a.connections)
        .slice(0, 8),
    [data.connections, data.leases]
  )

  if (!o || o.history.length === 0) return <div className="page muted">Loading…</div>

  const last = o.history[o.history.length - 1]
  const memPct = last.memTotal ? (last.memUsed / last.memTotal) * 100 : 0
  const diskPct = last.diskTotal ? (last.diskUsed / last.diskTotal) * 100 : 0
  const sys = o.system
  const wanPoints = o.wan?.history ?? []
  const wanLast = wanPoints[wanPoints.length - 1]

  return (
    <div className="page scroll">
      <div className="toolbar">
        <h1 className="page-title">Overview</h1>
        <span className="spacer" />
        <button className="btn" onClick={onEdit}>
          Edit Router
        </button>
        <button className="btn" onClick={() => void window.api.disconnect(profile.id)}>
          Disconnect
        </button>
      </div>
      <div className="dash">
        <Panel title="System Information">
          <table className="props">
            <tbody>
              <tr>
                <td>Hostname</td>
                <td>{sys?.identity}</td>
              </tr>
              <tr>
                <td>Address</td>
                <td>
                  {profile.host}:{profile.port}
                  {profile.useTls ? ' (TLS)' : ''}
                  {status.state === 'reconnecting' ? ' – reconnecting' : ''}
                </td>
              </tr>
              <tr>
                <td>Model</td>
                <td title={sys?.model}>{sys?.boardName || sys?.model}</td>
              </tr>
              <tr>
                <td>Serial Number</td>
                <td>{sys?.serialNumber ?? '-'}</td>
              </tr>
              <tr>
                <td>RouterOS</td>
                <td>{sys?.version}</td>
              </tr>
              <tr>
                <td>Firmware</td>
                <td>{sys?.firmware ?? '-'}</td>
              </tr>
              <tr>
                <td>CPU</td>
                <td>
                  {sys ? `${sys.cpu} × ${sys.cpuCount}` : ''}
                  {sys?.cpuFrequencyMhz ? ` @ ${formatNumber(sys.cpuFrequencyMhz)} MHz` : ''}
                </td>
              </tr>
              <tr>
                <td>Uptime</td>
                <td className="num">{formatDuration(last.uptimeSec)}</td>
              </tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="Resources">
          <Usage label="CPU" pct={last.cpuLoad} value={`${last.cpuLoad} %`} />
          <Usage label="Memory" pct={memPct} value={`${Math.round(memPct)} % of ${formatBytes(last.memTotal)}`} />
          {last.diskTotal > 0 && <Usage label="Disk" pct={diskPct} value={`${Math.round(diskPct)} % of ${formatBytes(last.diskTotal)}`} />}
          <div style={{ marginTop: 8 }}>
            <LineChart
              times={o.history.map((h) => h.t)}
              series={[
                { label: 'CPU', color: 'var(--rx)', values: o.history.map((h) => h.cpuLoad) },
                { label: 'Memory', color: 'var(--tx)', values: o.history.map((h) => (h.memTotal ? (h.memUsed / h.memTotal) * 100 : 0)) }
              ]}
              format={pctFormat}
              yMax={100}
              height={120}
            />
          </div>
        </Panel>

        <Panel title="Status">
          <table className="props">
            <tbody>
              <tr>
                <td>Connections</td>
                <td>
                  <button className="link num" onClick={() => onNavigate('connections')}>
                    {formatNumber(o.counts.connections)}
                  </button>
                </td>
              </tr>
              <tr>
                <td>DHCP Leases</td>
                <td>
                  <button className="link num" onClick={() => onNavigate('dhcp')}>
                    {o.counts.leasesBound} bound / {o.counts.leasesTotal}
                  </button>
                </td>
              </tr>
              <tr>
                <td>Interfaces</td>
                <td>
                  <button className="link num" onClick={() => onNavigate('interfaces')}>
                    {o.counts.interfacesUp} up / {o.counts.interfacesTotal}
                  </button>
                </td>
              </tr>
              {o.health.map((s) => (
                <tr key={s.name}>
                  <td>{s.label}</td>
                  <td className="num">{formatSensor(s.value, s.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel
          className="span-2"
          title={o.wan ? `WAN Traffic (${o.wan.name})` : 'WAN Traffic'}
          aside={
            <span className="legend">
              <span>
                <i style={{ background: 'var(--rx)' }} />
                Rx {formatBps(wanLast?.rx)}
              </span>
              <span>
                <i style={{ background: 'var(--tx)' }} />
                Tx {formatBps(wanLast?.tx)}
              </span>
            </span>
          }
        >
          {o.wan ? (
            <LineChart
              times={wanPoints.map((p) => p.t)}
              series={[
                { label: 'Rx', color: 'var(--rx)', values: wanPoints.map((p) => p.rx) },
                { label: 'Tx', color: 'var(--tx)', values: wanPoints.map((p) => p.tx) }
              ]}
              format={formatBps}
              height={200}
            />
          ) : (
            <div className="chart-empty" style={{ height: 200 }}>
              No WAN interface found
            </div>
          )}
        </Panel>

        <Panel title="Top Sources" bodyClass="">
          <table className="mini">
            <thead>
              <tr>
                <th>Source</th>
                <th className="r">Conns</th>
                <th className="r">Down</th>
                <th className="r">Up</th>
              </tr>
            </thead>
            <tbody>
              {topSources.map((d) => (
                <tr key={d.ip} onClick={() => onNavigate('connections', d.ip)} title={d.ip}>
                  <td>{d.name ?? d.ip}</td>
                  <td className="r num">{d.connections}</td>
                  <td className="r num">{formatBps(d.rxBps)}</td>
                  <td className="r num">{formatBps(d.txBps)}</td>
                </tr>
              ))}
              {topSources.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No active sources
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  )
}
