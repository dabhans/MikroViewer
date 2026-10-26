export type Tab = 'overview' | 'connections' | 'connlog' | 'dhcp' | 'interfaces' | 'log'

export const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Dashboard' },
  { id: 'connections', label: 'Connections' },
  { id: 'connlog', label: 'Connection Log' },
  { id: 'dhcp', label: 'DHCP Leases' },
  { id: 'interfaces', label: 'Interfaces' },
  { id: 'log', label: 'System Log' }
]

export function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v)
}
