#!/usr/bin/env node
// Simulated MikroTik router speaking the RouterOS API protocol – for demoing and testing
// MikroViewer without a real router.
//
//   node scripts/mock-router.mjs                        (port 8728, user admin / password admin)
//   node scripts/mock-router.mjs --port 18728 --name Sommerhus --devices 4 --no-health
//   node scripts/mock-router.mjs --ros6                 (RouterOS 6 format for /system/health)
//   node scripts/mock-router.mjs --tls --cert c.pem --key k.pem --port 8729

import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'

// ---------- Arguments ----------

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? def : args[i + 1]
}
const flag = (name) => args.includes(`--${name}`)

const PORT = Number(opt('port', flag('tls') ? 8729 : 8728))
const IDENTITY = opt('name', 'Hjemme-hAP')
const USER = opt('user', 'admin')
const PASSWORD = opt('password', 'admin')
const DEVICE_COUNT = Number(opt('devices', 14))
const ROS6 = flag('ros6')
const NO_HEALTH = flag('no-health')
let seed = Number(opt('seed', 1))

function rand() {
  // Small deterministic PRNG (mulberry32) so the demo looks the same every time.
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const between = (a, b) => a + rand() * (b - a)

// ---------- Simulated network ----------

const LAN_PREFIX = '192.168.88.'
const ROUTER_LAN = '192.168.88.1'
const PUBLIC_IP = '85.191.20.17'

const DEVICE_TEMPLATES = [
  { host: 'Magnus-PC', mac: '3C:7C:3F:1A:22:01', ip: 23, heavy: 1.2 },
  { host: 'iPhone', mac: 'A4:83:E7:5B:10:9C', ip: 31, heavy: 0.6 },
  { host: 'Galaxy-S24', mac: '5C:E8:83:02:4F:AA', ip: 44, heavy: 0.5 },
  { host: 'LG-webOS-TV', mac: '58:FD:B1:7C:31:0E', ip: 52, heavy: 2.5 },
  { host: 'Sonos-Stue', mac: '48:A6:B8:90:12:7D', ip: 61, heavy: 0.4 },
  { host: 'MacBook-Air', mac: 'F0:18:98:2E:4C:B3', ip: 65, heavy: 0.9 },
  { host: 'iPad', mac: '90:81:2A:6E:01:F2', ip: 70, heavy: 0.7 },
  { host: 'Google-Nest-Mini', mac: '1C:F2:9A:41:88:0B', ip: 74, heavy: 0.1 },
  { host: 'PS5', mac: '00:E4:21:5D:9F:63', ip: 80, heavy: 1.5 },
  { host: 'HP-Printer', mac: '10:E7:C6:33:AA:41', ip: 88, heavy: 0.05 },
  { host: undefined, mac: '7C:2E:BD:11:05:C9', ip: 91, heavy: 0.1 },
  { host: 'Hue-Bridge', mac: '00:17:88:6F:02:1D', ip: 95, heavy: 0.05 },
  { host: 'Ring-Doorbell', mac: '34:3E:A4:9B:C0:07', ip: 99, heavy: 0.3 },
  { host: 'Windows-Laptop', mac: 'B4:8C:9D:62:7A:10', ip: 104, heavy: 0.8 }
]

const devices = DEVICE_TEMPLATES.slice(0, DEVICE_COUNT).map((d) => ({ ...d, address: LAN_PREFIX + d.ip }))
const NAS = { host: 'synology-nas', comment: 'NAS (Synology)', mac: '00:11:32:AB:CD:EF', address: '192.168.88.10', static: true }

const REMOTES = [
  { name: 'www.youtube.com', cname: 'youtube-ui.l.google.com', ip: '142.250.74.46', port: 443, proto: 'tcp', down: [2e6, 18e6], weight: 3 },
  { name: 'rr3---sn-uxaxpu5ap5-jj0e.googlevideo.com', ip: '173.194.182.8', port: 443, proto: 'udp', down: [4e6, 25e6], weight: 3 },
  { name: 'www.netflix.com', cname: 'www.dradis.netflix.com', ip: '54.155.178.5', port: 443, proto: 'tcp', down: [1e5, 6e5], weight: 1 },
  { name: 'ipv4-c012-cph001-ix.1.oca.nflxvideo.net', ip: '45.57.90.130', port: 443, proto: 'tcp', down: [3e6, 16e6], weight: 2 },
  { name: 'audio-ak-spotify-com.akamaized.net', ip: '2.21.66.59', port: 443, proto: 'tcp', down: [1.6e5, 3.2e5], weight: 2 },
  { name: 'www.facebook.com', cname: 'star-mini.c10r.facebook.com', ip: '157.240.201.35', port: 443, proto: 'tcp', down: [2e3, 4e5], weight: 2 },
  { name: 'web.whatsapp.com', ip: '157.240.201.60', port: 5222, proto: 'tcp', down: [100, 4e3], weight: 2 },
  { name: 'www.google.com', ip: '142.250.179.196', port: 443, proto: 'tcp', down: [1e3, 3e5], weight: 3 },
  { name: 'mtalk.google.com', cname: 'mobile-gtalk.l.google.com', ip: '142.250.102.188', port: 5228, proto: 'tcp', down: [50, 800], weight: 2 },
  { name: 'api.push.apple.com', ip: '17.57.146.53', port: 5223, proto: 'tcp', down: [50, 800], weight: 2 },
  { name: 'www.dr.dk', ip: '159.20.6.38', port: 443, proto: 'tcp', down: [1e4, 2e6], weight: 2 },
  { name: 'tv2.dk', ip: '151.101.2.217', port: 443, proto: 'tcp', down: [1e4, 1.5e6], weight: 1 },
  { name: 'login.microsoftonline.com', ip: '20.190.159.3', port: 443, proto: 'tcp', down: [1e3, 5e4], weight: 2 },
  { name: 'dl.delivery.mp.microsoft.com', ip: '23.218.218.72', port: 80, proto: 'tcp', down: [5e6, 40e6], weight: 0.4 },
  { name: 'discord.com', ip: '162.159.135.232', port: 443, proto: 'tcp', down: [1e3, 8e4], weight: 1 },
  { name: 'steamcdn-a.akamaihd.net', ip: '23.62.44.17', port: 443, proto: 'tcp', down: [1e6, 30e6], weight: 0.3 },
  { name: 'one.one.one.one', ip: '1.1.1.1', port: 443, proto: 'tcp', down: [500, 5e3], weight: 1 },
  { name: 'dns.google', ip: '8.8.8.8', port: 53, proto: 'udp', down: [200, 2e3], weight: 1 },
  { name: 'dk.pool.ntp.org', ip: '193.104.228.10', port: 123, proto: 'udp', down: [64, 200], weight: 0.6 },
  { name: 'stun.l.google.com', ip: '74.125.250.129', port: 19302, proto: 'udp', down: [3e5, 2e6], weight: 0.5 },
  { name: undefined, ip: '104.18.32.47', port: 443, proto: 'tcp', down: [1e3, 2e5], weight: 1 },
  { name: undefined, ip: '91.198.174.192', port: 443, proto: 'tcp', down: [1e3, 2e5], weight: 0.5 }
]
const REMOTE_WEIGHT = REMOTES.reduce((s, r) => s + r.weight, 0)
function pickRemote() {
  let x = rand() * REMOTE_WEIGHT
  for (const r of REMOTES) if ((x -= r.weight) <= 0) return r
  return REMOTES[0]
}

const startedAt = Date.now() - (3 * 86400 + 7 * 3600 + 21 * 60) * 1000
let connSeq = 0x1a2b0
let natPort = 40000
const connections = new Map()

function newConnection(now) {
  const d = pick(devices)
  let remote = pickRemote()
  if (rand() < 0.12) {
    // DNS lookup against the router itself
    remote = { name: undefined, ip: ROUTER_LAN, port: 53, proto: 'udp', down: [100, 600], local: true }
  }
  const srcPort = Math.floor(between(49152, 65535))
  const id = `*${(connSeq++).toString(16).toUpperCase()}`
  const heavyFactor = d.heavy * (remote.down[1] > 1e6 ? (rand() < 0.35 ? 1 : 0.02) : 1)
  const downRate = between(remote.down[0], remote.down[1]) * heavyFactor
  const lifetime = remote.proto === 'udp' ? between(2, 40) : remote.down[1] > 1e6 ? between(20, 240) : between(3, 120)
  const pubPort = natPort++ > 64000 ? (natPort = 40000) : natPort
  connections.set(id, {
    id,
    proto: remote.proto,
    src: `${d.address}:${srcPort}`,
    dst: `${remote.ip}:${remote.port}`,
    replySrc: `${remote.ip}:${remote.port}`,
    replyDst: remote.local ? `${d.address}:${srcPort}` : `${PUBLIC_IP}:${pubPort}`,
    created: now,
    end: now + lifetime * 1000,
    down: downRate,
    up: downRate * between(0.02, 0.12),
    origBytes: Math.floor(between(60, 600)),
    replBytes: Math.floor(between(60, 1500)),
    remote
  })
}

function seedConnections(now) {
  for (let i = 0; i < 40 + devices.length * 9; i++) {
    newConnection(now - between(0, 120000))
  }
  // A port forward to the NAS (dstnat).
  connections.set('*F00D1', {
    id: '*F00D1',
    proto: 'tcp',
    src: '203.0.113.50:51544',
    dst: `${PUBLIC_IP}:443`,
    replySrc: `${NAS.address}:443`,
    replyDst: '203.0.113.50:51544',
    created: now - 600000,
    end: now + 3600000,
    down: 2e4,
    up: 6e5,
    origBytes: 1e6,
    replBytes: 4e7,
    remote: { proto: 'tcp' }
  })
}

let lastTick = Date.now()
const ifCounters = {}
function tick() {
  const now = Date.now()
  const dt = (now - lastTick) / 1000
  lastTick = now
  // New traffic arrives in small bursts so the log keeps getting open and close events.
  const target = 40 + devices.length * 9
  const spawn = connections.size < target ? 3 : rand() < 0.6 ? 2 : 1
  for (let i = 0; i < spawn; i++) if (rand() < 0.75) newConnection(now)
  if (rand() < 0.08 && devices.length) {
    const d = pick(devices)
    const id = `*${(connSeq++).toString(16).toUpperCase()}`
    connections.set(id, {
      id,
      proto: 'icmp',
      src: d.address,
      dst: '8.8.8.8',
      replySrc: '8.8.8.8',
      replyDst: PUBLIC_IP,
      created: now,
      end: now + 8000,
      down: 900,
      up: 900,
      origBytes: 84,
      replBytes: 84,
      remote: { proto: 'icmp' }
    })
  }
  let wanRx = 0
  let wanTx = 0
  for (const c of connections.values()) {
    if (now > c.end + (c.proto === 'tcp' ? 10000 : 0)) {
      connections.delete(c.id)
      continue
    }
    if (now > c.end) continue // time-wait – no traffic
    const wobble = between(0.6, 1.4)
    c.replBytes += Math.floor(((c.down * wobble) / 8) * dt)
    c.origBytes += Math.floor(((c.up * wobble) / 8) * dt)
    if (!c.remote.local) {
      wanRx += (c.down * wobble) / 8
      wanTx += (c.up * wobble) / 8
    }
  }
  const add = (name, rx, tx) => {
    const ifc = (ifCounters[name] ??= { rx: Math.floor(between(1e9, 9e10)), tx: Math.floor(between(1e8, 9e9)) })
    ifc.rx += Math.floor(rx * dt)
    ifc.tx += Math.floor(tx * dt)
  }
  const overhead = 1.03
  add('ether1', wanRx * overhead + 2000, wanTx * overhead + 1500)
  add('bridge', wanTx * 0.98, wanRx * 0.98)
  add('ether2', wanTx * 0.25, wanRx * 0.25)
  add('ether3', 3000, 6000)
  add('wifi1', wanTx * 0.55, wanRx * 0.55)
  add('wifi2', wanTx * 0.2, wanRx * 0.2)
  add('wireguard1', between(0, 4000), between(0, 4000))
  add('lo', 800, 800)
  add('ether4', 0, 0)
  add('ether5', 0, 0)
}

const interfaces = [
  { name: 'ether1', type: 'ether', mac: '48:A9:8A:10:00:01', comment: 'Fiber (WAN)', running: true },
  { name: 'ether2', type: 'ether', mac: '48:A9:8A:10:00:02', running: true },
  { name: 'ether3', type: 'ether', mac: '48:A9:8A:10:00:03', comment: 'NAS', running: true },
  { name: 'ether4', type: 'ether', mac: '48:A9:8A:10:00:04', running: false },
  { name: 'ether5', type: 'ether', mac: '48:A9:8A:10:00:05', running: false, disabled: true },
  { name: 'wifi1', type: 'wifi', mac: '48:A9:8A:10:00:06', comment: '5 GHz', running: true },
  { name: 'wifi2', type: 'wifi', mac: '48:A9:8A:10:00:07', comment: '2.4 GHz', running: true },
  { name: 'bridge', type: 'bridge', mac: '48:A9:8A:10:00:02', running: true },
  { name: 'wireguard1', type: 'wg', running: true, comment: 'VPN' },
  { name: 'lo', type: 'loopback', mac: '00:00:00:00:00:00', running: true }
]

let cpu = 6
let temp = 44
let cpuTemp = 51
function resource() {
  // Random walk that is pulled back towards a normal level, with an occasional spike.
  cpu = Math.max(1, Math.min(100, cpu + (10 - cpu) * 0.15 + between(-4, 4)))
  if (rand() < 0.03) cpu = Math.min(100, cpu + 35)
  temp = Math.max(35, Math.min(70, temp + (44 - temp) * 0.05 + between(-0.4, 0.4)))
  cpuTemp = temp + 7 + between(-0.5, 0.5)
  const total = 1073741824
  return {
    uptime: duration((Date.now() - startedAt) / 1000),
    version: ROS6 ? '6.49.17 (long-term)' : '7.19.4 (stable)',
    'build-time': '2025-09-16 10:12:44',
    'factory-software': '7.5',
    'free-memory': String(Math.floor(total * between(0.58, 0.6))),
    'total-memory': String(total),
    cpu: 'ARM64',
    'cpu-count': '4',
    'cpu-frequency': '1800',
    'cpu-load': String(Math.round(cpu)),
    'free-hdd-space': '91684864',
    'total-hdd-space': '134217728',
    'architecture-name': 'arm64',
    'board-name': 'hAP ax^3',
    platform: 'MikroTik'
  }
}

function duration(sec) {
  sec = Math.floor(sec)
  const w = Math.floor(sec / 604800)
  const d = Math.floor((sec % 604800) / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${w ? w + 'w' : ''}${d ? d + 'd' : ''}${h ? h + 'h' : ''}${m ? m + 'm' : ''}${s}s`
}

function connectionRecords(now) {
  return [...connections.values()].map((c) => {
    const closing = now > c.end
    const rec = {
      '.id': c.id,
      protocol: c.proto,
      'src-address': c.src,
      'dst-address': c.dst,
      'reply-src-address': c.replySrc,
      'reply-dst-address': c.replyDst,
      timeout: closing ? duration(Math.max(0, 10 - (now - c.end) / 1000)) : c.proto === 'tcp' ? '23h59m' + Math.floor(between(50, 59)) + 's' : duration(Math.max(1, (c.end - now) / 1000 + 10)),
      'orig-bytes': String(c.origBytes),
      'repl-bytes': String(c.replBytes),
      'orig-packets': String(Math.floor(c.origBytes / 700) + 1),
      'repl-packets': String(Math.floor(c.replBytes / 1200) + 1),
      assured: 'true',
      'seen-reply': 'true',
      srcnat: c.replyDst.startsWith(PUBLIC_IP) ? 'true' : 'false',
      dstnat: c.replySrc !== c.dst ? 'true' : 'false',
      fasttrack: c.down > 4e6 ? 'true' : 'false'
    }
    if (c.proto === 'tcp') rec['tcp-state'] = closing ? 'time-wait' : now - c.created < 800 ? 'syn-sent' : 'established'
    return rec
  })
}

function leaseRecords() {
  const out = devices.map((d, i) => ({
    '.id': `*${(i + 1).toString(16).toUpperCase()}`,
    address: d.address,
    'mac-address': d.mac,
    'client-id': `1:${d.mac.toLowerCase()}`,
    server: 'defconf',
    'dhcp-option': '',
    status: i === devices.length - 1 && devices.length > 6 ? 'waiting' : 'bound',
    'expires-after': duration(between(600, 1800)),
    'last-seen': duration(between(1, 300)),
    'active-address': d.address,
    'active-mac-address': d.mac,
    'active-server': 'defconf',
    ...(d.host ? { 'host-name': d.host } : {}),
    radius: 'false',
    dynamic: 'true',
    blocked: 'false',
    disabled: 'false'
  }))
  out.push({
    '.id': '*30',
    address: NAS.address,
    'mac-address': NAS.mac,
    server: 'defconf',
    status: 'bound',
    'expires-after': duration(between(600, 1800)),
    'last-seen': '12s',
    'active-address': NAS.address,
    'active-mac-address': NAS.mac,
    'host-name': NAS.host,
    comment: NAS.comment,
    dynamic: 'false',
    blocked: 'false',
    disabled: 'false'
  })
  out.push({
    '.id': '*31',
    address: '192.168.88.200',
    'mac-address': 'DE:AD:BE:EF:00:01',
    server: 'defconf',
    status: 'waiting',
    'last-seen': 'never',
    comment: 'Old printer',
    dynamic: 'false',
    blocked: 'false',
    disabled: 'true'
  })
  return out
}

function dnsRecords() {
  const out = []
  for (const r of REMOTES) {
    if (!r.name) continue
    if (r.cname) {
      out.push({ name: r.name, type: 'CNAME', data: r.cname, ttl: '4m' })
      out.push({ name: r.cname, type: 'A', data: r.ip, ttl: '2m' })
    } else {
      out.push({ name: r.name, type: 'A', data: r.ip, ttl: '3m' })
    }
  }
  return out
}

const LOG = []
let logId = 0x100
function log(topics, message) {
  const d = new Date()
  const time = d.toTimeString().slice(0, 8)
  LOG.push({ '.id': `*${(logId++).toString(16).toUpperCase()}`, time, topics, message })
  if (LOG.length > 1000) LOG.shift()
}
function seedLog() {
  log('system,info', 'router rebooted')
  log('interface,info', 'ether1 link up (speed 1G, full duplex)')
  log('interface,info', 'ether2 link up (speed 1G, full duplex)')
  log('interface,info', 'ether3 link up (speed 1G, full duplex)')
  log('dhcp,info', 'dhcp-client on ether1 got IP address ' + PUBLIC_IP)
  log('wireguard,info', 'wireguard1: peer handshake completed')
  for (const d of devices) log('dhcp,info', `defconf assigned ${d.address} for ${d.mac} ${d.host ?? ''}`.trim())
  log('system,error,critical', 'login failure for user admin from 45.148.10.12 via ssh')
  log('wireless,info', '90:81:2A:6E:01:F2@wifi1: connected, signal strength -58')
  log('system,warning', 'NTP server dk.pool.ntp.org not reachable, trying next')
  log('firewall,info', 'input: in:ether1 out:(unknown 0), proto TCP (SYN), 45.148.10.12:58122->85.191.20.17:22, len 60')
}
const LOG_EVENTS = [
  () => {
    const d = pick(devices)
    return ['dhcp,info', `defconf assigned ${d.address} for ${d.mac} ${d.host ?? ''}`.trim()]
  },
  () => {
    const d = pick(devices)
    return ['wireless,info', `${d.mac}@wifi${rand() < 0.5 ? 1 : 2}: connected, signal strength ${Math.round(between(-75, -45))}`]
  },
  () => {
    const d = pick(devices)
    return ['wireless,info', `${d.mac}@wifi1: disconnected, group key timeout`]
  },
  () => ['firewall,info', `input: in:ether1 out:(unknown 0), proto TCP (SYN), 45.148.10.${Math.floor(between(2, 250))}:${Math.floor(between(30000, 60000))}->${PUBLIC_IP}:22, len 60`],
  () => ['system,error,critical', `login failure for user root from 103.77.${Math.floor(between(1, 250))}.${Math.floor(between(1, 250))} via ssh`],
  () => ['wireguard,info', 'wireguard1: peer handshake completed']
]

// ---------- API protocol ----------

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len])
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff])
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff])
  if (len < 0x10000000) return Buffer.from([((len >>> 24) & 0xff) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff])
  const b = Buffer.alloc(5)
  b[0] = 0xf0
  b.writeUInt32BE(len, 1)
  return b
}
function sentence(words) {
  const parts = []
  for (const w of words) {
    const b = Buffer.from(w, 'utf8')
    parts.push(encodeLength(b.length), b)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function readLength(buf, off) {
  if (off >= buf.length) return null
  const b = buf[off]
  if ((b & 0x80) === 0) return [b, 1]
  if ((b & 0xc0) === 0x80) return off + 2 > buf.length ? null : [((b & 0x3f) << 8) | buf[off + 1], 2]
  if ((b & 0xe0) === 0xc0) return off + 3 > buf.length ? null : [((b & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2], 3]
  if ((b & 0xf0) === 0xe0) return off + 4 > buf.length ? null : [(b & 0x0f) * 0x1000000 + ((buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]), 4]
  return off + 5 > buf.length ? null : [buf.readUInt32BE(off + 1), 5]
}

function handleClient(socket) {
  const remote = socket.remoteAddress?.replace('::ffff:', '') ?? '?'
  let buf = Buffer.alloc(0)
  let words = []
  let loggedIn = false
  console.log(`[${IDENTITY}] connection from ${remote}`)

  const send = (w) => socket.write(sentence(w))
  const reply = (tag, records, done = {}) => {
    const t = tag !== undefined ? [`.tag=${tag}`] : []
    for (const r of records) send(['!re', ...Object.entries(r).map(([k, v]) => `=${k}=${v}`), ...t])
    send(['!done', ...Object.entries(done).map(([k, v]) => `=${k}=${v}`), ...t])
  }
  const trap = (tag, message) => {
    const t = tag !== undefined ? [`.tag=${tag}`] : []
    send(['!trap', `=message=${message}`, ...t])
    send(['!done', ...t])
  }

  const onSentence = (ws) => {
    const cmd = ws[0]
    const attrs = {}
    const queries = []
    let tag
    for (const w of ws.slice(1)) {
      if (w.startsWith('.tag=')) tag = w.slice(5)
      else if (w.startsWith('=')) {
        const eq = w.indexOf('=', 1)
        attrs[eq === -1 ? w.slice(1) : w.slice(1, eq)] = eq === -1 ? '' : w.slice(eq + 1)
      } else if (w.startsWith('?')) queries.push(w.slice(1))
    }

    if (cmd === '/login') {
      if (attrs.name === USER && attrs.password === PASSWORD) {
        loggedIn = true
        log('system,info,account', `user ${USER} logged in from ${remote} via api`)
        return reply(tag, [])
      }
      log('system,error,critical', `login failure for user ${attrs.name} from ${remote} via api`)
      return trap(tag, 'invalid user name or password (6)')
    }
    if (cmd === '/quit') {
      send(['!fatal', 'session terminated on request'])
      socket.end()
      return
    }
    if (!loggedIn) return trap(tag, 'not logged in')
    if (cmd === '/cancel') return reply(tag, [])

    const now = Date.now()
    const filterProps = (recs) => {
      if (!attrs['.proplist']) return recs
      const keep = attrs['.proplist'].split(',')
      return recs.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k))))
    }
    const applyQueries = (recs) =>
      recs.filter((r) =>
        queries.every((q) => {
          const eq = q.indexOf('=')
          return eq === -1 ? q in r : r[q.slice(0, eq)] === q.slice(eq + 1)
        })
      )
    const print = (recs) => {
      const matched = applyQueries(recs)
      if ('count-only' in attrs) return reply(tag, [], { ret: String(matched.length) })
      return reply(tag, filterProps(matched))
    }

    switch (cmd) {
      case '/system/identity/print':
        return print([{ name: IDENTITY }])
      case '/system/resource/print':
        return print([resource()])
      case '/system/routerboard/print':
        return print([{ routerboard: 'true', 'board-name': 'hAP ax^3', model: 'C53UiG+5HPaxD2HPaxD', 'serial-number': 'HFE09ABC1234', 'firmware-type': 'ipq6000', 'factory-firmware': '7.5', 'current-firmware': '7.19.4', 'upgrade-firmware': '7.19.4' }])
      case '/system/health/print':
        if (NO_HEALTH) return reply(tag, [])
        if (ROS6) return print([{ voltage: '24.1', temperature: temp.toFixed(0), 'cpu-temperature': cpuTemp.toFixed(0) }])
        return print([
          { '.id': '*D', name: 'cpu-temperature', value: cpuTemp.toFixed(0), type: 'C' },
          { '.id': '*E', name: 'board-temperature1', value: temp.toFixed(0), type: 'C' },
          { '.id': '*F', name: 'voltage', value: '24.1', type: 'V' },
          { '.id': '*10', name: 'fan1-speed', value: String(Math.round(2900 + between(-40, 40))), type: 'RPM' }
        ])
      case '/ip/firewall/connection/print':
        return print(connectionRecords(now))
      case '/ip/dhcp-server/lease/print':
        return print(leaseRecords())
      case '/interface/print':
        return print(
          interfaces.map((i, n) => ({
            '.id': `*${(n + 1).toString(16).toUpperCase()}`,
            name: i.name,
            type: i.type,
            mtu: '1500',
            'actual-mtu': '1500',
            ...(i.mac ? { 'mac-address': i.mac } : {}),
            ...(i.comment ? { comment: i.comment } : {}),
            'rx-byte': String(ifCounters[i.name]?.rx ?? 0),
            'tx-byte': String(ifCounters[i.name]?.tx ?? 0),
            running: String(i.running),
            disabled: String(!!i.disabled)
          }))
        )
      case '/interface/list/member/print':
        return print([
          { '.id': '*1', list: 'LAN', interface: 'bridge', dynamic: 'false', disabled: 'false' },
          { '.id': '*2', list: 'WAN', interface: 'ether1', dynamic: 'false', disabled: 'false' }
        ])
      case '/ip/address/print':
        return print([
          { '.id': '*1', address: `${ROUTER_LAN}/24`, network: '192.168.88.0', interface: 'bridge' },
          { '.id': '*2', address: `${PUBLIC_IP}/24`, network: '85.191.20.0', interface: 'ether1', dynamic: 'true' }
        ])
      case '/ip/route/print':
        return print([{ '.id': '*1', 'dst-address': '0.0.0.0/0', gateway: '85.191.20.1', 'immediate-gateway': '85.191.20.1%ether1', active: 'true' }])
      case '/ip/dns/cache/all/print':
      case '/ip/dns/cache/print':
        return print(dnsRecords())
      case '/log/print':
        return print(LOG)
      default:
        return trap(tag, 'no such command prefix')
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    let off = 0
    for (;;) {
      const h = readLength(buf, off)
      if (!h || buf.length < off + h[1] + h[0]) break
      const start = off + h[1]
      off = start + h[0]
      if (h[0] === 0) {
        if (words.length) onSentence(words)
        words = []
      } else words.push(buf.subarray(start, start + h[0]).toString('utf8'))
    }
    buf = buf.subarray(off)
  })
  socket.on('error', () => {})
  socket.on('close', () => console.log(`[${IDENTITY}] ${remote} disconnected`))
}

// ---------- Start ----------

seedConnections(Date.now())
seedLog()
tick()
setInterval(tick, 1000)
setInterval(() => {
  if (rand() < 0.5) log(...pick(LOG_EVENTS)())
}, 4000)

const server = flag('tls')
  ? tls.createServer({ cert: fs.readFileSync(opt('cert')), key: fs.readFileSync(opt('key')) }, handleClient)
  : net.createServer(handleClient)

server.listen(PORT, opt('host', '127.0.0.1'), () => {
  console.log(`Mock router "${IDENTITY}" listening on ${opt('host', '127.0.0.1')}:${PORT}${flag('tls') ? ' (TLS)' : ''} – user "${USER}", password "${PASSWORD}"`)
})
