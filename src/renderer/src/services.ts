export { serviceLabel, serviceName } from '../../shared/services'

export type ProtocolFilter = 'all' | 'tcp' | 'udp' | 'icmp' | 'other'

export function matchesProtocol(p: string, filter: ProtocolFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'other') return p !== 'tcp' && p !== 'udp' && p !== 'icmp'
  return p === filter
}

const TCP_STATES: Record<string, string> = {
  established: 'Established',
  'syn-sent': 'SYN sent',
  'syn-received': 'SYN received',
  'fin-wait': 'FIN wait',
  'close-wait': 'Close wait',
  'last-ack': 'Last ACK',
  'time-wait': 'Time wait',
  close: 'Closed'
}

export function tcpStateLabel(state: string | undefined): string | undefined {
  if (!state) return undefined
  return TCP_STATES[state] ?? state
}
