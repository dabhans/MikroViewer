// Query language for the log view, modelled on firewall log consoles:
//
//   src:192.168.88.23   dst:*.google.com   port:443   action:drop   type:firewall
//   src:192.168.88.0/24 AND NOT service:dns
//   (port:80 OR port:443) bytes:>10M
//
// Terms next to each other must all match (AND). OR, NOT, "-term" and parentheses work as usual.
// "field:a,b" matches either value. A term without a field searches every field.

import type { LogEntry } from './types'
import { serviceName } from './services'

export type LogPredicate = (e: LogEntry) => boolean
export type CompileResult = { ok: true; predicate: LogPredicate; empty: boolean } | { ok: false; error: string }

class QueryError extends Error {}

type Op = '=' | '>' | '>=' | '<' | '<='
type Token = { kind: 'lp' | 'rp' | 'and' | 'or' | 'not' } | { kind: 'term'; text: string }

function tokenize(q: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < q.length) {
    const ch = q[i]
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '(' || ch === ')') {
      out.push({ kind: ch === '(' ? 'lp' : 'rp' })
      i++
    } else {
      let text = ''
      let quoted = false
      while (i < q.length) {
        const c = q[i]
        if (c === '"') quoted = !quoted
        else if (!quoted && (/\s/.test(c) || c === '(' || c === ')')) break
        text += c
        i++
      }
      if (quoted) throw new QueryError('Missing closing quote')
      const word = text.toUpperCase()
      if (word === 'AND' || text === '&&') out.push({ kind: 'and' })
      else if (word === 'OR' || text === '||') out.push({ kind: 'or' })
      else if (word === 'NOT') out.push({ kind: 'not' })
      else out.push({ kind: 'term', text })
    }
  }
  return out
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): LogPredicate {
    const p = this.expr()
    if (this.pos < this.tokens.length) throw new QueryError(this.tokens[this.pos].kind === 'rp' ? 'Unmatched )' : 'Unexpected text')
    return p
  }

  private expr(): LogPredicate {
    let left = this.and()
    while (this.tokens[this.pos]?.kind === 'or') {
      this.pos++
      const l = left
      const r = this.and()
      left = (e) => l(e) || r(e)
    }
    return left
  }

  private and(): LogPredicate {
    let left = this.unary()
    for (;;) {
      const t = this.tokens[this.pos]
      if (!t || t.kind === 'or' || t.kind === 'rp') return left
      if (t.kind === 'and') this.pos++
      const l = left
      const r = this.unary()
      left = (e) => l(e) && r(e)
    }
  }

  private unary(): LogPredicate {
    const t = this.tokens[this.pos++]
    if (!t) throw new QueryError('The query ends too early')
    switch (t.kind) {
      case 'not': {
        const p = this.unary()
        return (e) => !p(e)
      }
      case 'lp': {
        const p = this.expr()
        if (this.tokens[this.pos++]?.kind !== 'rp') throw new QueryError('Missing )')
        return p
      }
      case 'term':
        return compileTerm(t.text)
      default:
        throw new QueryError(`Unexpected ${t.kind === 'rp' ? ')' : t.kind.toUpperCase()}`)
    }
  }
}

// ---------- Value matchers ----------

function unquote(v: string): string {
  return v.replace(/"/g, '')
}

/** Splits "a,b" into values, keeping commas inside quotes. */
function splitList(v: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const c of v) {
    if (c === '"') quoted = !quoted
    else if (c === ',' && !quoted) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map(unquote).filter((s) => s !== '')
}

function wildcard(v: string): RegExp {
  const esc = v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

type TextTest = (s: string | undefined) => boolean

/** Substring match, or a wildcard pattern when the value contains * or ?. */
function textTest(value: string, exact = false): TextTest {
  if (/[*?]/.test(value)) {
    const re = wildcard(value)
    return (s) => s !== undefined && re.test(s)
  }
  const v = value.toLowerCase()
  return exact ? (s) => s !== undefined && s.toLowerCase() === v : (s) => s !== undefined && s.toLowerCase().includes(v)
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipToInt(ip: string): number | null {
  const m = ip.match(IPV4)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

type AddrTest = (ip: string | undefined, name?: string) => boolean

/** IP fields: exact IP, CIDR subnet, wildcard, or part of the IP or host name. */
function addrTest(value: string): AddrTest {
  const cidr = value.match(/^([\d.]+)\/(\d{1,2})$/)
  if (cidr) {
    const base = ipToInt(cidr[1])
    const bits = Number(cidr[2])
    if (base === null || bits > 32) throw new QueryError(`Invalid subnet "${value}"`)
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (ip) => {
      const n = ip ? ipToInt(ip) : null
      return n !== null && (n & mask) >>> 0 === (base & mask) >>> 0
    }
  }
  if (IPV4.test(value)) return (ip) => ip === value
  const t = textTest(value)
  return (ip, name) => t(ip) || t(name)
}

const UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 }
const TIME_UNITS: Record<string, number> = { '': 1, s: 1, m: 60, min: 60, h: 3600, d: 86400 }

function parseAmount(v: string, units: Record<string, number>, field: string): number {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/i)
  const mult = m ? units[m[2].toLowerCase()] : undefined
  if (!m || mult === undefined) throw new QueryError(`"${v}" is not a valid value for ${field}`)
  return Number(m[1]) * mult
}

type NumTest = (n: number | undefined) => boolean

function numTest(op: Op, value: string, field: string, units: Record<string, number> = { '': 1 }): NumTest {
  if (op === '=') {
    const range = value.match(/^(\d[^-]*)-(\d.*)$/)
    if (range) {
      const lo = parseAmount(range[1], units, field)
      const hi = parseAmount(range[2], units, field)
      return (n) => n !== undefined && n >= lo && n <= hi
    }
  }
  const x = parseAmount(value, units, field)
  switch (op) {
    case '=':
      return (n) => n === x
    case '>':
      return (n) => n !== undefined && n > x
    case '>=':
      return (n) => n !== undefined && n >= x
    case '<':
      return (n) => n !== undefined && n < x
    case '<=':
      return (n) => n !== undefined && n <= x
  }
}

function enumValue(value: string, aliases: Record<string, string[]>, field: string): string[] {
  const v = value.toLowerCase()
  for (const [canonical, names] of Object.entries(aliases)) if (canonical === v || names.includes(v)) return [canonical]
  // Some aliases map to several values (e.g. "blocked" = drop or reject).
  const multi = MULTI_ALIASES[field]?.[v]
  if (multi) return multi
  throw new QueryError(`Unknown ${field} "${value}". Use ${Object.keys(aliases).join(', ')}`)
}

const MULTI_ALIASES: Record<string, Record<string, string[]>> = {
  action: { block: ['drop', 'reject'], blocked: ['drop', 'reject'], deny: ['drop', 'reject'], denied: ['drop', 'reject'] }
}

const PROTOCOL_NUMBERS: Record<string, string> = { '1': 'icmp', '6': 'tcp', '17': 'udp', '47': 'gre', '50': 'ipsec-esp', '51': 'ipsec-ah', '58': 'icmpv6' }

// ---------- Fields ----------

interface FieldDef {
  names: string[]
  example: string
  description: string
  /** Numeric fields accept > >= < <= and ranges. */
  numeric?: boolean
  test(op: Op, value: string): LogPredicate
}

const svc = (e: LogEntry): string | undefined => serviceName(e.protocol, e.dstPort)

export const FIELDS: FieldDef[] = [
  {
    names: ['src', 'source'],
    example: 'src:192.168.88.0/24',
    description: 'Source IP, subnet or name',
    test: (_op, v) => {
      const t = addrTest(v)
      const mac = textTest(v)
      return (e) => t(e.src, e.srcName) || (v.includes(':') && mac(e.srcMac))
    }
  },
  {
    names: ['dst', 'destination'],
    example: 'dst:*.netflix.com',
    description: 'Destination IP, subnet or name',
    test: (_op, v) => {
      const t = addrTest(v)
      return (e) => t(e.dst, e.dstName)
    }
  },
  {
    names: ['ip', 'host'],
    example: 'ip:8.8.8.8',
    description: 'Source or destination',
    test: (_op, v) => {
      const t = addrTest(v)
      return (e) => t(e.src, e.srcName) || t(e.dst, e.dstName)
    }
  },
  {
    names: ['port', 'dport', 'dstport'],
    example: 'port:443',
    description: 'Destination port (also 1-1024, >1024)',
    numeric: true,
    test: (op, v) => {
      const t = numTest(op, v, 'port')
      return (e) => t(e.dstPort)
    }
  },
  {
    names: ['sport', 'srcport'],
    example: 'sport:5353',
    description: 'Source port',
    numeric: true,
    test: (op, v) => {
      const t = numTest(op, v, 'sport')
      return (e) => t(e.srcPort)
    }
  },
  {
    names: ['proto', 'protocol'],
    example: 'proto:udp',
    description: 'tcp, udp, icmp …',
    test: (_op, v) => {
      const p = PROTOCOL_NUMBERS[v] ?? v.toLowerCase()
      return (e) => e.protocol === p
    }
  },
  {
    names: ['service', 'svc'],
    example: 'service:https',
    description: 'Service name, or tcp/8443',
    test: (_op, v) => {
      const pp = v.match(/^([a-z]+)\/(\d+)$/i)
      if (pp) return (e) => e.protocol === pp[1].toLowerCase() && e.dstPort === Number(pp[2])
      if (/^\d+$/.test(v)) return (e) => e.dstPort === Number(v)
      const t = textTest(v, true)
      return (e) => t(svc(e))
    }
  },
  {
    names: ['action'],
    example: 'action:drop',
    description: 'accept, drop, reject, nat, log (block = drop or reject)',
    test: (_op, v) => {
      const set = enumValue(v, { accept: ['allow', 'allowed', 'permit', 'accepted'], drop: ['dropped'], reject: ['rejected'], nat: [], log: ['logged'] }, 'action')
      return (e) => set.includes(e.action)
    }
  },
  {
    names: ['type'],
    example: 'type:firewall',
    description: 'session or firewall',
    test: (_op, v) => {
      const [t] = enumValue(v, { session: ['sessions', 'connection', 'connections', 'conn'], firewall: ['fw', 'rule'] }, 'type')
      return (e) => e.type === t
    }
  },
  {
    names: ['rule', 'prefix'],
    example: 'rule:"drop all"',
    description: 'Rule comment, log prefix or number',
    test: (_op, v) => {
      const t = textTest(v)
      return (e) => t(e.rule) || t(e.prefix) || t(e.ruleNumber)
    }
  },
  {
    names: ['chain'],
    example: 'chain:input',
    description: 'Firewall chain',
    test: (_op, v) => {
      const t = textTest(v, true)
      return (e) => t(e.chain)
    }
  },
  {
    names: ['in', 'inif'],
    example: 'in:ether1',
    description: 'Incoming interface',
    test: (_op, v) => {
      const t = textTest(v, true)
      return (e) => t(e.inInterface)
    }
  },
  {
    names: ['out', 'outif'],
    example: 'out:bridge',
    description: 'Outgoing interface',
    test: (_op, v) => {
      const t = textTest(v, true)
      return (e) => t(e.outInterface)
    }
  },
  {
    names: ['iface', 'interface'],
    example: 'iface:wifi1',
    description: 'Incoming or outgoing interface',
    test: (_op, v) => {
      const t = textTest(v, true)
      return (e) => t(e.inInterface) || t(e.outInterface)
    }
  },
  {
    names: ['mac'],
    example: 'mac:3C:7C:*',
    description: 'Source MAC address',
    test: (_op, v) => {
      const t = textTest(v)
      return (e) => t(e.srcMac)
    }
  },
  {
    names: ['nat'],
    example: 'nat:dstnat',
    description: 'srcnat, dstnat, yes, no or the NAT address',
    test: (_op, v) => {
      const lower = v.toLowerCase()
      if (lower === 'srcnat' || lower === 'dstnat') return (e) => e.nat?.kind === lower
      if (lower === 'yes' || lower === 'true') return (e) => !!e.nat
      if (lower === 'no' || lower === 'false') return (e) => !e.nat
      const t = addrTest(v)
      return (e) => !!e.nat && (t(e.nat.address.split(':')[0]) || e.nat.address === v)
    }
  },
  {
    names: ['name'],
    example: 'name:iphone',
    description: 'Source or destination name',
    test: (_op, v) => {
      const t = textTest(v)
      return (e) => t(e.srcName) || t(e.dstName)
    }
  },
  {
    names: ['bytes'],
    example: 'bytes:>10M',
    description: 'Total bytes of a session (K, M, G)',
    numeric: true,
    test: (op, v) => {
      const t = numTest(op, v, 'bytes', UNITS)
      return (e) => t(e.txBytes === undefined && e.rxBytes === undefined ? undefined : (e.txBytes ?? 0) + (e.rxBytes ?? 0))
    }
  },
  {
    names: ['duration'],
    example: 'duration:>5m',
    description: 'Session duration (s, m, h, d)',
    numeric: true,
    test: (op, v) => {
      const t = numTest(op, v, 'duration', TIME_UNITS)
      return (e) => t(e.durationSec)
    }
  },
  {
    names: ['state'],
    example: 'state:new',
    description: 'Connection state of a firewall record',
    test: (_op, v) => {
      const t = textTest(v)
      return (e) => t(e.connState)
    }
  },
  {
    names: ['message', 'msg'],
    example: 'msg:"len 60"',
    description: 'Raw firewall log message',
    test: (_op, v) => {
      const t = textTest(v)
      return (e) => t(e.message)
    }
  }
]

const FIELD_BY_NAME = new Map(FIELDS.flatMap((f) => f.names.map((n) => [n, f] as const)))

function freeText(v: string): LogPredicate {
  const ipPort = v.match(/^([\d.]+):(\d+)$/)
  if (ipPort) {
    const port = Number(ipPort[2])
    return (e) => (e.src === ipPort[1] && e.srcPort === port) || (e.dst === ipPort[1] && e.dstPort === port)
  }
  if (IPV4.test(v) || /^[\d.]+\/\d+$/.test(v)) {
    const t = addrTest(v)
    return (e) => t(e.src) || t(e.dst) || (!!e.nat && t(e.nat.address.split(':')[0]))
  }
  const t = textTest(v)
  const port = /^\d+$/.test(v) ? Number(v) : undefined
  return (e) =>
    (port !== undefined && (e.dstPort === port || e.srcPort === port)) ||
    t(e.src) ||
    t(e.dst) ||
    t(e.srcName) ||
    t(e.dstName) ||
    t(e.srcMac) ||
    t(svc(e)) ||
    t(e.protocol) ||
    t(e.action) ||
    t(e.rule) ||
    t(e.prefix) ||
    t(e.chain) ||
    t(e.inInterface) ||
    t(e.outInterface) ||
    t(e.nat?.address) ||
    t(e.message)
}

function compileTerm(raw: string): LogPredicate {
  let text = raw
  let negate = false
  if (text.length > 1 && (text[0] === '-' || text[0] === '!')) {
    negate = true
    text = text.slice(1)
  }
  let pred: LogPredicate
  // An IPv6 address or MAC address is a value, not "field:value".
  const looksLikeAddress = /^[0-9a-f]*(:[0-9a-f]*){2,}$/i.test(text)
  const m = looksLikeAddress ? null : text.match(/^([a-z][\w-]*)(!=|>=|<=|:|=|>|<)(.*)$/i)
  const field = m ? FIELD_BY_NAME.get(m[1].toLowerCase()) : undefined
  if (m && field) {
    let op = m[2]
    let value = m[3]
    // "port:>1024" is the same as "port>1024".
    const inner = (op === ':' || op === '=') && value.match(/^(!=|>=|<=|>|<)(.*)$/)
    if (inner) {
      op = inner[1]
      value = inner[2]
    }
    if (op === ':') op = '='
    if (op !== '=' && op !== '!=' && !field.numeric) throw new QueryError(`${m[1]} can't be compared with ${op}`)
    if (!unquote(value)) throw new QueryError(`Missing value after "${m[1]}${m[2]}"`)
    const values = op === '=' || op === '!=' ? splitList(value) : [unquote(value)]
    const tests = values.map((v) => field.test(op === '!=' ? '=' : (op as Op), v))
    const any: LogPredicate = tests.length === 1 ? tests[0] : (e) => tests.some((t) => t(e))
    pred = op === '!=' ? (e) => !any(e) : any
  } else if (m && m[2] === ':') {
    throw new QueryError(`Unknown field "${m[1]}"`)
  } else {
    pred = freeText(unquote(text))
  }
  return negate ? (e) => !pred(e) : pred
}

export function compileQuery(query: string): CompileResult {
  try {
    const tokens = tokenize(query)
    if (tokens.length === 0) return { ok: true, predicate: () => true, empty: true }
    return { ok: true, predicate: new Parser(tokens).parse(), empty: false }
  } catch (err) {
    if (err instanceof QueryError) return { ok: false, error: err.message }
    throw err
  }
}

/** A query term for "filter by this value", e.g. src:192.168.88.23 or rule:"Allow NAS". */
export function filterTerm(field: string, value: string | number): string {
  const v = String(value)
  return `${field}:${/[\s(),"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v}`
}

/** Adds a term to a query with AND, wrapping the existing query when it contains OR. */
export function addTerm(query: string, term: string, exclude = false): string {
  const q = query.trim()
  const t = exclude ? `NOT ${term}` : term
  if (!q) return t
  return /\bOR\b|\|\|/i.test(q) ? `(${q}) ${t}` : `${q} ${t}`
}
