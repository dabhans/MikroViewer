export type Tab = 'overview' | 'connections' | 'logs' | 'dhcp' | 'interfaces' | 'log'

export const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connections', label: 'Connections' },
  { id: 'logs', label: 'Logs' },
  { id: 'dhcp', label: 'DHCP Leases' },
  { id: 'interfaces', label: 'Interfaces' },
  { id: 'log', label: 'System Log' }
]

export function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v)
}
