// Turns RouterOS firewall log lines (rules with log=yes) into log records, and works out which
// rule wrote them so the record gets an action (accept/drop/…) and a rule name.
//
// Examples of what RouterOS writes:
//   DROP-IN input: in:ether1 out:(unknown 0), connection-state:new src-mac 00:0c:42:aa:bb:cc, proto TCP (SYN), 198.51.100.12:58122->203.0.113.17:22, len 60
//   forward: in:bridge out:ether1, connection-state:new,snat src-mac 3c:7c:3f:1a:22:01, proto TCP (SYN), 192.168.88.23:51234->1.2.3.4:443, NAT (192.168.88.23:51234->203.0.113.17:40001)->1.2.3.4:443, len 60
//   input: in:ether1 out:(unknown 0), proto ICMP (type 8, code 0), 1.2.3.4->203.0.113.17, len 84

import type { LogAction, NatInfo } from '../../shared/types'

export interface FirewallPacket {
  prefix?: string
  chain: string
  inInterface?: string
  outInterface?: string
  connState?: string
  srcMac?: string
  protocol: string
  tcpFlags?: string
  icmp?: string
  src: string
  srcPort?: number
  dst: string
  dstPort?: number
  nat?: NatInfo
  length?: number
}

const KNOWN_CHAINS = ['prerouting', 'postrouting', 'forward', 'input', 'output', 'srcnat', 'dstnat']
const PROTOCOL_NUMBERS: Record<string, string> = { '1': 'icmp', '6': 'tcp', '17': 'udp', '47': 'gre', '50': 'ipsec-esp', '51': 'ipsec-ah', '58': 'icmpv6', '112': 'vrrp' }
const ADDR = String.raw`((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\])(?::(\d+))?`

function iface(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.trim()
  return s === '(unknown 0)' || s === '(none)' ? undefined : s
}

function stripBrackets(ip: string): string {
  return ip.startsWith('[') ? ip.slice(1, -1) : ip
}

export function parseFirewallMessage(message: string): FirewallPacket | null {
  const head = message.match(/^(.*?)([^\s:]+): in:(.+?) out:(.+?), (.*)$/)
  if (!head) return null
  let prefix = head[1].trim()
  let chain = head[2]
  // Older RouterOS versions glue the prefix to the chain name ("DROPinput").
  if (!prefix) {
    const glued = KNOWN_CHAINS.find((c) => chain.length > c.length && chain.endsWith(c))
    if (glued) {
      prefix = chain.slice(0, -glued.length)
      chain = glued
    }
  }
  const rest = head[5]

  const proto = rest.match(/proto ([\w-]+)(?: \(([^)]*)\))?/)
  if (!proto) return null
  const protoName = proto[1].toLowerCase()
  const protocol = PROTOCOL_NUMBERS[protoName] ?? protoName
  const addrs = rest.slice(proto.index! + proto[0].length).match(new RegExp(`^,\\s*${ADDR}->${ADDR}`))
  if (!addrs) return null

  const packet: FirewallPacket = {
    prefix: prefix || undefined,
    chain,
    inInterface: iface(head[3]),
    outInterface: iface(head[4]),
    connState: rest.match(/connection-state:([\w,-]+)/)?.[1],
    srcMac: rest.match(/src-mac ([0-9a-fA-F:]{17})/)?.[1]?.toUpperCase(),
    protocol,
    src: stripBrackets(addrs[1]),
    srcPort: addrs[2] ? Number(addrs[2]) : undefined,
    dst: stripBrackets(addrs[3]),
    dstPort: addrs[4] ? Number(addrs[4]) : undefined,
    length: rest.match(/len (\d+)/) ? Number(rest.match(/len (\d+)/)![1]) : undefined
  }
  if (proto[2]) {
    if (protocol === 'tcp') packet.tcpFlags = proto[2]
    else if (protocol === 'icmp' || protocol === 'icmpv6') packet.icmp = proto[2]
  }

  // srcnat: "NAT (orig-src->new-src)->dst"   dstnat: "NAT src->(orig-dst->new-dst)"
  const snat = rest.match(/NAT \(([^)]*?)->([^)]*?)\)->/)
  const dnat = rest.match(/NAT [^,(]*?->\(([^)]*?)->([^)]*?)\)/)
  if (dnat) packet.nat = { kind: 'dstnat', address: dnat[2] }
  else if (snat) packet.nat = { kind: 'srcnat', address: snat[2] }
  return packet
}

// ---------- Rules ----------

export type RuleTable = 'filter' | 'raw' | 'nat' | 'mangle'

export interface FirewallRule {
  table: RuleTable
  /** RouterOS internal id, e.g. "*1A". */
  id: string
  /** Position in the table, as RouterOS numbers them. */
  index: number
  chain: string
  action: string
  prefix: string
  comment?: string
  /** What the rule matches, for rules without a comment. */
  match: string
  log: boolean
  disabled: boolean
  dynamic: boolean
  packets?: number
}

/** The properties `describeMatch` reads, for the API's .proplist. */
export const MATCH_PROPS = [
  'protocol',
  'src-address',
  'src-address-list',
  'src-port',
  'dst-address',
  'dst-address-list',
  'dst-port',
  'in-interface',
  'in-interface-list',
  'out-interface',
  'out-interface-list',
  'connection-state',
  'connection-nat-state'
]

const MATCH_LABELS: Record<string, string> = {
  protocol: 'proto',
  'src-address': 'src',
  'src-address-list': 'src list',
  'src-port': 'src port',
  'dst-address': 'dst',
  'dst-address-list': 'dst list',
  'dst-port': 'dst port',
  'in-interface': 'in',
  'in-interface-list': 'in list',
  'out-interface': 'out',
  'out-interface-list': 'out list',
  'connection-state': 'state',
  'connection-nat-state': 'nat state'
}

/** "proto tcp, dst port 22, in list !LAN" – or "all traffic" for a rule without matchers. */
export function describeMatch(r: Record<string, string | undefined>): string {
  const parts = MATCH_PROPS.filter((k) => r[k]).map((k) => `${MATCH_LABELS[k]} ${r[k]}`)
  return parts.length ? parts.join(', ') : 'all traffic'
}

export interface RuleMatch {
  action: LogAction
  rule?: string
  ruleNumber?: string
}

function mapAction(action: string): LogAction {
  switch (action) {
    case 'accept':
    case 'fasttrack-connection':
      return 'accept'
    case 'drop':
    case 'tarpit':
      return 'drop'
    case 'reject':
      return 'reject'
    case 'dst-nat':
    case 'src-nat':
    case 'masquerade':
    case 'netmap':
    case 'redirect':
    case 'same':
    case 'endpoint-independent-nat':
      return 'nat'
    default:
      return 'log'
  }
}

/** When the rules are unknown (not loaded yet, or no access), the prefix often says it all. */
function guessFromPrefix(prefix: string | undefined): LogAction {
  const p = (prefix ?? '').toLowerCase()
  if (/reject/.test(p)) return 'reject'
  if (/drop|block|deny|denied/.test(p)) return 'drop'
  if (/accept|allow|permit/.test(p)) return 'accept'
  return 'log'
}

export function matchRule(rules: FirewallRule[], chain: string, prefix: string | undefined): RuleMatch {
  const want = (prefix ?? '').trim()
  // Rules with action=log always log; other rules only with log=yes.
  const candidates = rules.filter((r) => (r.log || r.action === 'log') && !r.disabled && r.chain === chain && r.prefix.trim() === want)
  if (candidates.length === 0) return { action: guessFromPrefix(prefix), rule: prefix }
  const actions = new Set(candidates.map((r) => mapAction(r.action)))
  const action = actions.size === 1 ? [...actions][0] : 'log'
  if (candidates.length === 1) {
    const r = candidates[0]
    return { action, rule: r.comment || r.prefix || undefined, ruleNumber: `${r.table} #${r.index}` }
  }
  return { action, rule: prefix }
}
