// Client for MikroTik's classic API protocol (port 8728, or 8729 with TLS).
// Protocol: https://help.mikrotik.com/docs/display/ROS/API
//
// Every command is sent as a "sentence" of length-prefixed words, terminated by an empty word.
// All commands get a .tag so several can run concurrently on the same connection.

import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

export type ApiRecord = Record<string, string>

export interface CommandResult {
  re: ApiRecord[]
  done: ApiRecord
}

export type ErrorKind = 'trap' | 'fatal' | 'network' | 'timeout' | 'auth' | 'tls'

export class RouterOSError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind = 'trap',
    readonly code?: string
  ) {
    super(message)
    this.name = 'RouterOSError'
  }
}

export interface ClientOptions {
  host: string
  port: number
  tls: boolean
  username: string
  password: string
  connectTimeoutMs?: number
  commandTimeoutMs?: number
  /** SHA-256 fingerprint of the router's certificate from an earlier connection (trust on first use). */
  expectedFingerprint?: string
}

interface Pending {
  re: ApiRecord[]
  trap?: RouterOSError
  resolve: (r: CommandResult) => void
  reject: (e: Error) => void
  timer?: NodeJS.Timeout
  trapTimer?: NodeJS.Timeout
  /** Streaming commands (e.g. print with follow-only) hand each !re over instead of collecting them. */
  onRecord?: (r: ApiRecord) => void
  cancelled?: boolean
}

export interface Stream {
  /** Resolves when the router ends the stream or it is cancelled. */
  done: Promise<void>
  cancel(): void
}

export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff])
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff])
  if (len < 0x10000000) {
    return Buffer.from([((len >>> 24) & 0xff) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff])
  }
  const b = Buffer.alloc(5)
  b[0] = 0xf0
  b.writeUInt32BE(len, 1)
  return b
}

export function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = []
  for (const w of words) {
    const data = Buffer.from(w, 'utf8')
    parts.push(encodeLength(data.length), data)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

/** RouterOS stores text as raw bytes – usually UTF-8, but older clients write latin1. */
function decodeWord(buf: Buffer): string {
  const s = buf.toString('utf8')
  return s.includes('�') ? buf.toString('latin1') : s
}

/** Incremental parser: fed raw bytes, returns complete sentences. */
export class SentenceParser {
  private buf: Buffer = Buffer.alloc(0)
  private words: string[] = []

  push(chunk: Buffer): string[][] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: string[][] = []
    let off = 0
    for (;;) {
      const header = readLength(this.buf, off)
      if (!header) break
      const [len, hlen] = header
      if (this.buf.length < off + hlen + len) break
      const start = off + hlen
      off = start + len
      if (len === 0) {
        if (this.words.length) out.push(this.words)
        this.words = []
      } else {
        this.words.push(decodeWord(this.buf.subarray(start, start + len)))
      }
    }
    this.buf = off === this.buf.length ? Buffer.alloc(0) : this.buf.subarray(off)
    return out
  }
}

function readLength(buf: Buffer, off: number): [number, number] | null {
  if (off >= buf.length) return null
  const b = buf[off]
  if ((b & 0x80) === 0) return [b, 1]
  if ((b & 0xc0) === 0x80) {
    if (off + 2 > buf.length) return null
    return [((b & 0x3f) << 8) | buf[off + 1], 2]
  }
  if ((b & 0xe0) === 0xc0) {
    if (off + 3 > buf.length) return null
    return [((b & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2], 3]
  }
  if ((b & 0xf0) === 0xe0) {
    if (off + 4 > buf.length) return null
    return [(b & 0x0f) * 0x1000000 + ((buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]), 4]
  }
  if (b === 0xf0) {
    if (off + 5 > buf.length) return null
    return [buf.readUInt32BE(off + 1), 5]
  }
  throw new RouterOSError(`Invalid response from router (control byte 0x${b.toString(16)})`, 'fatal')
}

function parseAttributes(words: string[]): { attrs: ApiRecord; tag?: string } {
  const attrs: ApiRecord = {}
  let tag: string | undefined
  for (const w of words) {
    if (w.startsWith('.tag=')) {
      tag = w.slice(5)
    } else if (w.startsWith('=')) {
      const eq = w.indexOf('=', 1)
      if (eq === -1) attrs[w.slice(1)] = ''
      else attrs[w.slice(1, eq)] = w.slice(eq + 1)
    }
  }
  return { attrs, tag }
}

export class RouterOSClient extends EventEmitter {
  private socket: net.Socket | null = null
  private parser = new SentenceParser()
  private pending = new Map<string, Pending>()
  private tagSeq = 0
  private closed = false
  private commandTimeoutMs: number
  /** Certificate fingerprint when connected over TLS. */
  fingerprint?: string

  private constructor(private readonly opts: ClientOptions) {
    super()
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 20000
  }

  static async connect(opts: ClientOptions): Promise<RouterOSClient> {
    const client = new RouterOSClient(opts)
    await client.open()
    try {
      await client.login()
    } catch (err) {
      client.close()
      throw err
    }
    return client
  }

  get isClosed(): boolean {
    return this.closed
  }

  private open(): Promise<void> {
    const { host, port } = this.opts
    const timeoutMs = this.opts.connectTimeoutMs ?? 8000
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        this.closed = true
        reject(err)
      }
      const timer = setTimeout(() => fail(new RouterOSError(`No response from ${host}:${port}`, 'timeout')), timeoutMs)

      let socket: net.Socket
      if (this.opts.tls) {
        socket = tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          // RouterOS almost always uses self-signed certificates. Instead of CA validation we
          // remember the certificate fingerprint on first connect and reject it if it changes.
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2'
        })
        socket.once('secureConnect', () => {
          const fp = (socket as tls.TLSSocket).getPeerCertificate()?.fingerprint256
          this.fingerprint = fp || undefined
          const expected = this.opts.expectedFingerprint
          if (expected && fp && expected !== fp) {
            fail(
              new RouterOSError(
                "The router's certificate has changed since the last connection. If you replaced it, edit the router and reset the saved certificate.",
                'tls'
              )
            )
            return
          }
          onConnected()
        })
      } else {
        socket = net.connect({ host, port })
        socket.once('connect', () => onConnected())
      }
      this.socket = socket

      const onConnected = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 15000)
        socket.on('data', (chunk: Buffer) => this.onData(chunk))
        socket.on('close', () => this.onClose())
        socket.on('error', (err) => this.onClose(err))
        resolve()
      }

      socket.once('error', (err: NodeJS.ErrnoException) => fail(networkError(err, host, port, this.opts.tls)))
    })
  }

  private async login(): Promise<void> {
    const { username, password } = this.opts
    try {
      const res = await this.command(['/login', `=name=${username}`, `=password=${password}`])
      if (res.done.ret) {
        // RouterOS before 6.43 answers with an MD5 challenge.
        const md5 = crypto
          .createHash('md5')
          .update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), Buffer.from(res.done.ret, 'hex')]))
          .digest('hex')
        await this.command(['/login', `=name=${username}`, `=response=00${md5}`])
      }
    } catch (err) {
      if (err instanceof RouterOSError && (err.kind === 'trap' || err.kind === 'fatal')) {
        const msg = err.message.toLowerCase()
        if (msg.includes('invalid user') || msg.includes('cannot log in') || msg.includes('password')) {
          throw new RouterOSError('Login failed: wrong username or password, or the user lacks the "api" policy.', 'auth')
        }
      }
      throw err
    }
  }

  /** Runs a command and returns all !re replies plus the attributes of !done. */
  command(words: string[], timeoutMs = this.commandTimeoutMs): Promise<CommandResult> {
    if (this.closed || !this.socket) {
      return Promise.reject(new RouterOSError('Connection to the router is closed', 'network'))
    }
    const tag = String(++this.tagSeq)
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tag)
        this.cancelTag(tag)
        reject(new RouterOSError(`Router did not answer ${words[0]} within ${Math.round(timeoutMs / 1000)} s`, 'timeout'))
      }, timeoutMs)
      this.pending.set(tag, { re: [], resolve, reject, timer })
      this.write([...words, `.tag=${tag}`])
    })
  }

  /** Runs a command that keeps sending replies (such as /log/print =follow-only=) until cancelled. */
  stream(words: string[], onRecord: (r: ApiRecord) => void): Stream {
    if (this.closed || !this.socket) {
      return { done: Promise.reject(new RouterOSError('Connection to the router is closed', 'network')), cancel: () => {} }
    }
    const tag = String(++this.tagSeq)
    const done = new Promise<void>((resolve, reject) => {
      this.pending.set(tag, { re: [], resolve: () => resolve(), reject, onRecord })
      this.write([...words, `.tag=${tag}`])
    })
    return {
      done,
      cancel: () => {
        const p = this.pending.get(tag)
        if (!p || p.cancelled) return
        p.cancelled = true
        this.cancelTag(tag)
      }
    }
  }

  /** /cancel gets a tag of its own so its reply can't be mistaken for another command's. */
  private cancelTag(tag: string): void {
    this.command(['/cancel', `=tag=${tag}`], 5000).catch(() => {})
  }

  /** Convenience wrapper for `print`. Arguments like { '.proplist': 'a,b' } become =.proplist=a,b */
  async print(path: string, args: Record<string, string> = {}, queries: string[] = []): Promise<ApiRecord[]> {
    const words = [`${path}/print`, ...Object.entries(args).map(([k, v]) => `=${k}=${v}`), ...queries]
    return (await this.command(words)).re
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket?.end(encodeSentence(['/quit']))
    } catch {
      // ignore – we're closing anyway
    }
    this.socket?.destroy()
    this.failAll(new RouterOSError('Connection closed', 'network'))
  }

  private write(words: string[]): void {
    try {
      this.socket?.write(encodeSentence(words))
    } catch (err) {
      this.onClose(err as Error)
    }
  }

  private onData(chunk: Buffer): void {
    let sentences: string[][]
    try {
      sentences = this.parser.push(chunk)
    } catch (err) {
      this.onClose(err as Error)
      return
    }
    for (const words of sentences) this.onSentence(words)
  }

  private onSentence(words: string[]): void {
    const type = words[0]
    const { attrs, tag } = parseAttributes(words.slice(1))

    if (type === '!fatal') {
      const reason = words.slice(1).find((w) => !w.startsWith('.tag=')) ?? 'unknown reason'
      const err = new RouterOSError(`Router closed the connection: ${reason}`, 'fatal')
      if (tag && this.pending.has(tag)) this.finish(tag, err)
      this.onClose(err)
      return
    }

    // An untagged reply (shouldn't happen) can only be attributed when exactly one command is running.
    const key = tag ?? (this.pending.size === 1 ? this.pending.keys().next().value : undefined)
    if (key === undefined) return
    this.handleReply(key, type, attrs)
  }

  private handleReply(tag: string, type: string, attrs: ApiRecord): void {
    const p = this.pending.get(tag)
    if (!p) return

    switch (type) {
      case '!re':
        if (p.onRecord) p.onRecord(attrs)
        else p.re.push(attrs)
        break
      case '!trap':
        p.trap = new RouterOSError(attrs.message || 'Unknown error from router', 'trap', attrs.category)
        // !trap is normally followed by !done – but don't wait forever.
        p.trapTimer = setTimeout(() => this.finish(tag), 1500)
        break
      case '!done':
        this.finish(tag, undefined, attrs)
        break
      case '!empty':
        break
    }
  }

  private finish(tag: string, err?: Error, done: ApiRecord = {}): void {
    const p = this.pending.get(tag)
    if (!p) return
    this.pending.delete(tag)
    clearTimeout(p.timer)
    if (p.trapTimer) clearTimeout(p.trapTimer)
    // A cancelled stream ends with "interrupted" – that's not an error.
    const error = err ?? (p.cancelled ? undefined : p.trap)
    if (error) p.reject(error)
    else p.resolve({ re: p.re, done })
  }

  private failAll(err: Error): void {
    for (const tag of [...this.pending.keys()]) this.finish(tag, err)
  }

  private onClose(err?: Error): void {
    const wasClosed = this.closed
    this.closed = true
    this.socket?.destroy()
    const error =
      err instanceof RouterOSError ? err : new RouterOSError(err ? `Connection lost: ${err.message}` : 'Connection lost', 'network')
    this.failAll(error)
    if (!wasClosed) this.emit('close', error)
  }
}

function networkError(err: NodeJS.ErrnoException, host: string, port: number, useTls: boolean): RouterOSError {
  switch (err.code) {
    case 'ECONNREFUSED':
      return new RouterOSError(
        `Connection refused on port ${port}. Is the ${useTls ? 'api-ssl' : 'api'} service enabled (IP → Services)?`,
        'network',
        err.code
      )
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new RouterOSError(`Could not resolve "${host}"`, 'network', err.code)
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new RouterOSError(`No route to ${host}`, 'network', err.code)
    case 'ETIMEDOUT':
      return new RouterOSError(`No response from ${host}:${port}`, 'timeout', err.code)
    case 'ECONNRESET':
      return new RouterOSError(
        useTls
          ? 'The router closed the TLS connection. Does the api-ssl service have a certificate?'
          : 'The router closed the connection. Check that your IP is allowed for the api service.',
        'network',
        err.code
      )
  }
  if (useTls && /ssl|tls|handshake|cipher/i.test(err.message)) {
    return new RouterOSError(`TLS error: ${err.message}. Does the api-ssl service have a certificate?`, 'tls', err.code)
  }
  return new RouterOSError(`Network error: ${err.message}`, 'network', err.code)
}
