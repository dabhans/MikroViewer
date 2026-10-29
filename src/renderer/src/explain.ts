// Plain-language descriptions of log records and of the router's own log, for people who don't
// read RouterOS log lines.

import type { LeaseRow, LogEntry, RouterLogEntry } from '../../shared/types'
import { isPrivateIp } from './devices'
import { formatBytes, formatDuration } from './format'
import { serviceName } from './services'

type Traffic = Omit<LogEntry, 'id' | 't'>

const isRouter = (name: string | undefined): boolean => !!name && (name === 'Router' || name.endsWith('(router)'))

/** "Office-PC (192.168.88.23)", "142.250.74.46 on the internet", "the router" */
function endpoint(ip: string, name: string | undefined): string {
  if (isRouter(name)) return 'the router'
  if (name) return `${name} (${ip})`
  return isPrivateIp(ip) ? `${ip} on your network` : `${ip} on the internet`
}

/** "HTTPS (TCP port 443)", "TCP port 8443", or nothing for ICMP. */
function serviceText(e: Traffic): string | undefined {
  if (e.dstPort === undefined) return undefined
  const port = `${e.protocol.toUpperCase()} port ${e.dstPort}`
  const name = serviceName(e.protocol, e.dstPort)
  return name ? `${name} (${port})` : port
}

const isPing = (e: Traffic): boolean => e.protocol === 'icmp' && (!e.icmp || e.icmp.startsWith('type 8'))
const withoutPort = (address: string): string => address.replace(/:\d+$/, '')

const FIREWALL_VERB: Record<LogEntry['action'], string> = {
  drop: 'blocked',
  reject: 'refused',
  accept: 'allowed',
  log: 'logged',
  nat: 'translated'
}

/** What a firewall record means, in a few sentences. */
function explainFirewall(e: Traffic): string {
  if (!e.src) return 'MikroViewer couldn’t read the addresses in this firewall line – the router’s log line is shown below.'
  const packet = isPing(e)
    ? 'a ping'
    : e.connState?.includes('invalid')
      ? 'a packet that doesn’t belong to any open connection'
      : e.connState?.includes('new') || e.tcpFlags === 'SYN'
        ? 'a new connection'
        : e.protocol === 'icmp'
          ? `an ICMP message${e.icmp ? ` (${e.icmp})` : ''}`
          : 'a packet'
  const dst = e.chain === 'input' ? 'the router' : endpoint(e.dst, e.dstName)
  const service = serviceText(e)
  const out = [`The router ${FIREWALL_VERB[e.action]} ${packet} from ${endpoint(e.src, e.srcName)} to ${service ? `${service} ${e.chain === 'input' ? 'on' : 'at'} ${dst}` : dst}.`]

  if (e.nat?.kind === 'dstnat') out.push(`It came in through a port forward to ${e.nat.address}.`)
  else if (e.nat?.kind === 'srcnat') out.push(`The internet saw the router’s address, ${withoutPort(e.nat.address)} (NAT).`)
  if (e.connState?.includes('invalid')) out.push('Usually a leftover from a connection that was already closed.')
  if (e.action === 'reject') out.push('The sender was told it was refused.')
  if ((e.action === 'drop' || e.action === 'reject') && !isPrivateIp(e.src)) out.push('Scans like this from the internet are common and harmless when blocked.')
  return out.join(' ')
}

/** How the session ended, continuing "It lasted 2m". */
function ending(e: LogEntry): string {
  switch (e.endReason) {
    case 'fin':
      return 'was closed normally'
    case 'reset':
      return 'was cut off with a reset (TCP RST)'
    case 'aged-out':
      return e.protocol === 'tcp' ? 'timed out without being closed' : `timed out, as ${e.protocol.toUpperCase()} connections do`
    case 'lost':
      return 'ended while MikroViewer was disconnected'
    default:
      return ''
  }
}

/** What a session record means, in a few sentences. */
function explainSession(e: LogEntry): string {
  const src = isRouter(e.srcName) ? 'The router' : endpoint(e.src, e.srcName)
  const service = serviceText(e)
  const out: string[] = []

  if (e.nat?.kind === 'dstnat') {
    const name = serviceName(e.protocol, e.dstPort)
    out.push(`${src} connected through a port forward to ${e.nat.address}${name ? ` (${name})` : ''}.`)
  } else if (serviceName(e.protocol, e.dstPort) === 'DNS') {
    out.push(`${src} looked up a domain name with ${isRouter(e.dstName) ? 'the router’s DNS server' : `the DNS server ${endpoint(e.dst, e.dstName)}`}.`)
  } else if (isPing(e)) {
    out.push(`${src} pinged ${endpoint(e.dst, e.dstName)}.`)
  } else {
    out.push(`${src} connected to ${endpoint(e.dst, e.dstName)}${service ? ` using ${service}` : ''}.`)
  }

  const end = ending(e)
  if (e.durationSec !== undefined && !(e.approx && e.durationSec < 1)) {
    const bytes = e.txBytes !== undefined || e.rxBytes !== undefined ? ` (${formatBytes(e.txBytes)} sent, ${formatBytes(e.rxBytes)} received)` : ''
    out.push(`It lasted ${e.approx ? 'at least ' : ''}${formatDuration(e.durationSec)}${bytes}${end ? ` and ${end}` : ''}.`)
  } else if (end) {
    out.push(`It ${end}.`)
  }
  if (e.startBefore) out.push('It was already open when MikroViewer started watching.')
  if (e.nat?.kind === 'srcnat') out.push(`The internet saw the router’s address, ${withoutPort(e.nat.address)} (NAT).`)
  return out.join(' ')
}

/** A log record from Logs, explained for someone who doesn't know firewall terms. */
export function explainRecord(e: LogEntry): string {
  return e.type === 'session' ? explainSession(e) : explainFirewall(e)
}

// ---------- The router's own log (System Log) ----------

export type LogLevel = 'error' | 'warning' | 'info' | 'debug'

export interface ReadableLogEntry {
  level: LogLevel
  category: string
  text: string
}

const LEVEL_TOPICS = new Set(['critical', 'error', 'warning', 'info', 'debug', 'packet', 'raw'])

const CATEGORY: Record<string, string> = {
  account: 'Login',
  system: 'System',
  dhcp: 'DHCP',
  interface: 'Interface',
  wireless: 'Wi-Fi',
  wifi: 'Wi-Fi',
  wifiwave2: 'Wi-Fi',
  caps: 'Wi-Fi',
  firewall: 'Firewall',
  dns: 'DNS',
  ntp: 'Time',
  script: 'Script',
  ppp: 'PPP',
  pppoe: 'PPP',
  l2tp: 'VPN',
  sstp: 'VPN',
  ovpn: 'VPN',
  pptp: 'VPN',
  ipsec: 'VPN',
  wireguard: 'VPN',
  certificate: 'Certificate',
  health: 'Health',
  route: 'Routing',
  ospf: 'Routing',
  bgp: 'Routing',
  bridge: 'Bridge',
  stp: 'Bridge',
  lte: 'LTE',
  ups: 'UPS',
  'e-mail': 'E-mail',
  hotspot: 'Hotspot',
  'web-proxy': 'Proxy',
  container: 'Container',
  backup: 'Backup'
}

const METHOD: Record<string, string> = {
  winbox: 'Winbox',
  ssh: 'SSH',
  telnet: 'Telnet',
  web: 'WebFig',
  www: 'WebFig',
  'www-ssl': 'WebFig',
  api: 'the API',
  'api-ssl': 'the API',
  ftp: 'FTP',
  local: 'the console',
  'mac-telnet': 'MAC-Telnet',
  'mac-winbox': 'Winbox (MAC)'
}

function logLevel(topics: string[]): LogLevel {
  if (topics.includes('critical') || topics.includes('error')) return 'error'
  if (topics.includes('warning')) return 'warning'
  if (topics.includes('debug')) return 'debug'
  return 'info'
}

function logCategory(topics: string[]): string {
  if (topics.includes('account')) return CATEGORY.account
  const t = topics.find((x) => !LEVEL_TOPICS.has(x))
  if (!t) return 'System'
  return CATEGORY[t] ?? t.charAt(0).toUpperCase() + t.slice(1)
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const IP = String.raw`((?:\d{1,3}\.){3}\d{1,3})`
const MAC = String.raw`([0-9a-f]{2}(?::[0-9a-f]{2}){5})`

/** Names for the devices in the router's log, from the DHCP leases. */
interface Names {
  device(mac: string, hostName?: string): string
  host(ip: string): string
}

function namesFrom(leases: LeaseRow[]): Names {
  const byMac = new Map(leases.map((l) => [l.mac.toUpperCase(), l]))
  const byIp = new Map(leases.map((l) => [l.address, l]))
  const leaseName = (l: LeaseRow | undefined): string | undefined => l?.comment || l?.hostName
  return {
    device: (mac, hostName) => leaseName(byMac.get(mac.toUpperCase())) ?? hostName ?? mac.toUpperCase(),
    host: (ip) => {
      const name = leaseName(byIp.get(ip))
      return name ? `${name} (${ip})` : ip
    }
  }
}

const method = (via: string): string => METHOD[via.toLowerCase()] ?? via

/** "admin via Winbox from Office-PC (192.168.88.23)" from e.g. "winbox-3.41/tcp-msg(winbox):admin@192.168.88.23/action:52". */
function changedBy(who: string, n: Names): string {
  const at = who.match(/([^\s:()/]+)@([0-9a-f.:]+?)(?:\/|$|\s)/i)
  const via = who.match(/\((winbox|ssh|telnet|web|www|www-ssl|api|api-ssl|ftp|local)\)/i)?.[1] ?? who.match(/^(winbox|ssh|telnet|api|ftp)\b/i)?.[1]
  const user = at?.[1] ?? who.split(/[\s(/]/)[0]
  return [user, via && `via ${method(via)}`, at && `from ${n.host(at[2])}`].filter(Boolean).join(' ')
}

/** "1G" → "1 Gbps" */
const speed = (s: string): string => s.replace(/^([\d.]+)([KMG])$/i, (_, v: string, u: string) => `${v} ${u.toUpperCase()}bps`)

type Rule = [RegExp, (m: RegExpMatchArray, n: Names) => string, string?]

/** Known RouterOS log messages and how to say them. The optional third entry overrides the category. */
const RULES: Rule[] = [
  [new RegExp(`^(\\S+) assigned ${IP} (?:for|to) ${MAC}(?: (.+))?$`, 'i'), (m, n) => `${n.device(m[3], m[4])} got the address ${m[2]} (DHCP server ${m[1]})`],
  [new RegExp(`^(\\S+) deassigned ${IP} (?:for|from) ${MAC}(?: (.+))?$`, 'i'), (m, n) => `${n.device(m[3], m[4])} no longer has the address ${m[2]} (DHCP server ${m[1]})`],
  [new RegExp(`^dhcp-client on (\\S+) got IP address ${IP}`), (m) => `${m[1]} got the address ${m[2]} by DHCP`],
  [new RegExp(`^dhcp-client on (\\S+) lost IP address ${IP}`), (m) => `${m[1]} lost the address ${m[2]}`],
  [new RegExp(`^user (\\S+) logged (in|out)(?: from ${IP})? via (\\S+)$`), (m, n) => `${m[1]} logged ${m[2]} via ${method(m[4])}${m[3] ? ` from ${n.host(m[3])}` : ''}`, 'Login'],
  [new RegExp(`^login failure for user (\\S+)(?: from ${IP})? via (\\S+)$`), (m, n) => `Failed login as ${m[1]} via ${method(m[3])}${m[2] ? ` from ${n.host(m[2])}` : ''}`, 'Login'],
  [/^(.+?) (added|changed|removed|moved) by (.+?)(?: \(\/.*\))?$/, (m, n) => `${cap(m[1])} ${m[2]} by ${changedBy(m[3], n)}`, 'Settings'],
  [/^(\S+) link up(?: \(speed ([\d.]+[KMG]), (full|half) duplex\))?/i, (m) => `${m[1]} is connected${m[2] ? ` (${speed(m[2])}, ${m[3]} duplex)` : ''}`],
  [/^(\S+) link down/, (m) => `${m[1]} is disconnected`],
  [
    new RegExp(`^${MAC}@(\\S+?):? (connected|disconnected|roamed)[,:]?\\s*(.*)$`, 'i'),
    (m, n) => {
      const signal = m[4].match(/signal strength (-?\d+)/)?.[1]
      const reason = m[4].replace(/,?\s*signal strength -?\d+/, '').trim()
      const extra = [m[3] === 'disconnected' ? reason : '', signal && `signal ${signal} dBm`].filter(Boolean).join(', ')
      const verb = m[3] === 'connected' ? 'joined' : m[3] === 'disconnected' ? 'left' : 'roamed to'
      return `${n.device(m[1])} ${verb} ${m[2]}${extra ? ` (${extra})` : ''}`
    }
  ],
  [/^router rebooted$/, () => 'The router restarted'],
  [/^router was rebooted without proper shutdown/, () => 'The router restarted without shutting down properly (power cut or crash)'],
  [/^(\S+): (connected|disconnected)$/, (m) => `${m[1]} ${m[2]}`]
]

/** "Blocked SSH (TCP port 22) from 198.51.100.12 to the router – defconf: drop all not coming from LAN" */
function firewallLine(f: Traffic): string {
  const what = isPing(f) ? 'ping' : (serviceText(f) ?? f.protocol.toUpperCase())
  const end = (ip: string, name?: string): string => (isRouter(name) ? 'the router' : (name ?? ip))
  const dst = f.chain === 'input' ? 'the router' : end(f.dst, f.dstName)
  return `${cap(FIREWALL_VERB[f.action])} ${what} from ${end(f.src, f.srcName)} to ${dst}${f.rule ? ` – ${f.rule}` : ''}`
}

/** Reads entries of the router's log; device names come from the router's DHCP leases. */
export function routerLogReader(leases: LeaseRow[] = []): (e: RouterLogEntry) => ReadableLogEntry {
  const names = namesFrom(leases)
  return (e) => {
    const level = logLevel(e.topics)
    if (e.firewall) return { level, category: 'Firewall', text: firewallLine(e.firewall) }
    for (const [re, say, category] of RULES) {
      const m = e.message.match(re)
      if (m) return { level, category: category ?? logCategory(e.topics), text: say(m, names) }
    }
    return { level, category: logCategory(e.topics), text: e.message }
  }
}
