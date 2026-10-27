import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ProfileStore } from './profiles'
import { SettingsStore } from './settings'
import { Updater } from './updater'
import { LogStore, logStorageBytes, pruneAll } from './logs/store'
import { RouterSession, testConnection, type SessionCredentials, type SessionHost } from './routeros/session'
import { compileQuery } from '../shared/logquery'
import { serviceName } from '../shared/services'
import type { FirewallLogStatus, LogEntry, LogExportRequest, LogQuery, ProfileInput, SessionEvent, Settings, Theme } from '../shared/types'

// Allows running with a separate data folder (e.g. for testing or a portable install).
if (process.env.MIKROVIEWER_USER_DATA) app.setPath('userData', path.resolve(process.env.MIKROVIEWER_USER_DATA))

const isMac = process.platform === 'darwin'
/** Header and background colours per theme – they match styles.css. */
const THEME_COLORS: Record<Theme, { header: string; symbols: string; background: string }> = {
  light: { header: '#1c2531', symbols: '#dfe5ec', background: '#eceff2' },
  dark: { header: '#0f1620', symbols: '#d6dee8', background: '#131b25' }
}
const MAX_RESULTS = 20000
const PRUNE_INTERVAL = 3600_000

let win: BrowserWindow | null = null
let store: ProfileStore
let settings: SettingsStore
let updater: Updater
let logsRoot: string
const sessions = new Map<string, RouterSession>()
const logStores = new Map<string, LogStore>()
let focusedId: string | null = null

function send(event: SessionEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('mv:event', event)
}

const host: SessionHost = {
  async getCredentials(id): Promise<SessionCredentials | null> {
    const p = store.get(id)
    if (!p) return null
    return {
      host: p.host,
      port: p.port,
      tls: p.useTls,
      username: p.username,
      password: await store.getPassword(id),
      expectedFingerprint: p.tlsFingerprint
    }
  },
  onFingerprint(id, fingerprint) {
    store.setFingerprint(id, fingerprint)
    send({ type: 'profiles', profiles: store.list() })
  },
  onIdentity(id, identity) {
    if (store.nameIfEmpty(id, identity)) send({ type: 'profiles', profiles: store.list() })
  },
  emit: send
}

function logFor(id: string): LogStore {
  let s = logStores.get(id)
  if (!s) {
    s = new LogStore(path.join(logsRoot, id), (added) => {
      // Only the router on screen gets live updates; the others are written to disk only.
      if (focusedId === id) send({ type: 'log', id, added })
    })
    logStores.set(id, s)
  }
  return s
}

function getSession(id: string): RouterSession {
  let s = sessions.get(id)
  if (!s) {
    s = new RouterSession(id, host, logFor(id))
    sessions.set(id, s)
  }
  return s
}

function assertProfileInput(input: ProfileInput): ProfileInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid data')
  const hostName = String(input.host ?? '').trim()
  if (!hostName) throw new Error('Enter the router address')
  if (/\s/.test(hostName)) throw new Error('The address cannot contain spaces')
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a number between 1 and 65535')
  if (!String(input.username ?? '').trim()) throw new Error('Enter a username')
  return {
    id: input.id ? String(input.id) : undefined,
    name: String(input.name ?? ''),
    host: hostName,
    port,
    username: String(input.username),
    password: input.password === undefined ? undefined : String(input.password),
    useTls: Boolean(input.useTls),
    autoConnect: Boolean(input.autoConnect),
    resetFingerprint: Boolean(input.resetFingerprint)
  }
}

function assertLogRequest<T extends LogExportRequest>(raw: T): T {
  if (!raw || typeof raw.routerId !== 'string' || !store.get(raw.routerId)) throw new Error('Unknown router')
  if (typeof raw.query !== 'string' || raw.query.length > 4000) throw new Error('Invalid query')
  if (!Number.isFinite(raw.from) || !Number.isFinite(raw.to)) throw new Error('Invalid time range')
  return raw
}

function applyTheme(theme: Theme): void {
  if (!win || win.isDestroyed()) return
  const c = THEME_COLORS[theme]
  win.setBackgroundColor(c.background)
  if (!isMac) win.setTitleBarOverlay({ color: c.header, symbolColor: c.symbols, height: 36 })
}

const pad = (n: number): string => String(n).padStart(2, '0')
function localTime(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function csvLine(values: unknown[]): string {
  return (
    values
      .map((v) => {
        const s = v === undefined || v === null ? '' : String(v)
        return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      })
      .join(',') + '\r\n'
  )
}

const CSV_HEADER = [
  'Time',
  'Start',
  'Type',
  'Action',
  'Protocol',
  'Source',
  'Source name',
  'Source MAC',
  'Destination',
  'Destination name',
  'Destination port',
  'Service',
  'NAT',
  'Chain',
  'In interface',
  'Out interface',
  'Rule',
  'Duration (s)',
  'End reason',
  'Sent (bytes)',
  'Received (bytes)',
  'Message'
]

function csvRow(e: LogEntry): unknown[] {
  return [
    localTime(e.t),
    e.start !== undefined ? localTime(e.start) : '',
    e.type,
    e.action,
    e.protocol,
    e.src,
    e.srcName,
    e.srcMac,
    e.dst,
    e.dstName,
    e.dstPort,
    serviceName(e.protocol, e.dstPort),
    e.nat ? `${e.nat.kind} ${e.nat.address}` : '',
    e.chain,
    e.inInterface,
    e.outInterface,
    e.rule ?? e.ruleNumber,
    e.durationSec !== undefined ? Math.round(e.durationSec) : '',
    e.endReason,
    e.txBytes,
    e.rxBytes,
    e.message
  ]
}

function registerIpc(): void {
  ipcMain.handle('profiles:list', () => store.list())

  ipcMain.handle('profiles:save', async (_e, raw: ProfileInput) => {
    const input = assertProfileInput(raw)
    const profile = await store.save(input)
    send({ type: 'profiles', profiles: store.list() })
    // If the router is connected, reconnect with the new settings.
    const s = sessions.get(profile.id)
    if (s && s.status.state !== 'disconnected' && s.status.state !== 'error') {
      s.disconnect()
      void s.connect()
    }
    return profile
  })

  ipcMain.handle('profiles:delete', (_e, id: string) => {
    sessions.get(id)?.dispose()
    sessions.delete(id)
    if (focusedId === id) focusedId = null
    store.delete(id)
    send({ type: 'profiles', profiles: store.list() })
  })

  ipcMain.handle('profiles:test', async (_e, raw: ProfileInput) => {
    const input = assertProfileInput(raw)
    const existing = input.id ? store.get(input.id) : undefined
    const sameHost = existing && existing.host === input.host && existing.port === input.port && existing.useTls === input.useTls
    const { fingerprint: _fp, ...result } = await testConnection({
      host: input.host,
      port: input.port,
      tls: input.useTls,
      username: input.username,
      password: input.password ?? (existing ? await store.getPassword(existing.id) : ''),
      expectedFingerprint: sameHost && !input.resetFingerprint ? existing.tlsFingerprint : undefined
    })
    return result
  })

  ipcMain.handle('session:statuses', () => [...sessions.values()].map((s) => s.status))

  ipcMain.handle('session:connect', async (_e, id: string) => {
    if (!store.get(id)) throw new Error('Unknown router')
    const s = getSession(id)
    await s.connect()
    if (focusedId === id) s.setFocused(true)
  })

  ipcMain.handle('session:disconnect', (_e, id: string) => {
    sessions.get(id)?.disconnect()
  })

  ipcMain.on('session:focus', (_e, id: string | null) => {
    if (focusedId && focusedId !== id) sessions.get(focusedId)?.setFocused(false)
    focusedId = id && store.get(id) ? id : null
    if (focusedId) getSession(focusedId).setFocused(true)
  })

  ipcMain.handle('session:routerLog', (_e, id: string) => {
    const s = sessions.get(id)
    if (!s) throw new Error('Not connected to the router')
    return s.routerLog()
  })

  ipcMain.handle('session:firewallStatus', (_e, id: string): Promise<FirewallLogStatus> | FirewallLogStatus => {
    const s = sessions.get(id)
    return s ? s.firewallStatus() : { connected: false, lines: 0, unparsed: 0, rules: [] }
  })

  // ---------- Logs ----------

  ipcMain.handle('logs:query', async (_e, raw: LogQuery) => {
    const q = assertLogRequest(raw)
    const compiled = compileQuery(q.query)
    const limit = Math.max(1, Math.min(MAX_RESULTS, Number(q.limit) || 5000))
    if (!compiled.ok) {
      return { entries: [], total: 0, histogram: { from: q.from, bucketMs: 60000, counts: [], blocked: [] }, from: q.from, to: q.to, tookMs: 0, error: compiled.error }
    }
    return logFor(q.routerId).query(compiled.predicate, q.from, q.to, limit)
  })

  ipcMain.handle('logs:export', async (_e, raw: LogExportRequest) => {
    const q = assertLogRequest(raw)
    const compiled = compileQuery(q.query)
    if (!compiled.ok) throw new Error(compiled.error)
    if (!win) return { saved: false }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
    const base = (sessions.get(q.routerId)?.identity || store.get(q.routerId)?.name || 'router').replace(/[^\w.-]+/g, '_')
    const res = await dialog.showSaveDialog(win, {
      title: 'Export logs',
      defaultPath: path.join(app.getPath('documents'), `log-${base}-${stamp}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return { saved: false }
    const out = fs.createWriteStream(res.filePath, 'utf8')
    const write = (s: string): Promise<void> => new Promise((resolve) => (out.write(s) ? resolve() : out.once('drain', () => resolve())))
    await write('﻿' + csvLine(CSV_HEADER))
    await logFor(q.routerId).forEach(compiled.predicate, q.from, q.to, async (batch) => {
      for (const e of batch) await write(csvLine(csvRow(e)))
    })
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    return { saved: true, path: res.filePath }
  })

  ipcMain.handle('logs:storage', async () => ({ bytes: await logStorageBytes(logsRoot) }))

  ipcMain.handle('logs:delete', async () => {
    for (const s of logStores.values()) await s.clear()
    await fsp.rm(logsRoot, { recursive: true, force: true })
  })

  ipcMain.handle('logs:openFolder', async () => {
    await fsp.mkdir(logsRoot, { recursive: true })
    await shell.openPath(logsRoot)
  })

  // ---------- Settings, updates ----------

  ipcMain.handle('settings:get', () => settings.get())

  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const before = settings.get()
    const next = settings.set(patch ?? {})
    if (next.theme !== before.theme) applyTheme(next.theme)
    if (next.logRetentionDays < before.logRetentionDays) void pruneAll(logsRoot, next.logRetentionDays)
    return next
  })

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), portable: updater.portable, packaged: app.isPackaged }))
  ipcMain.handle('update:status', () => updater.status)
  ipcMain.handle('update:check', () => updater.check())
  ipcMain.handle('update:download', () => updater.download())
  ipcMain.handle('update:install', () => updater.install())

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) await shell.openExternal(url)
  })
}

function createWindow(): void {
  const theme = settings.get().theme
  const colors = THEME_COLORS[theme]
  win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    title: 'MikroViewer',
    backgroundColor: colors.background,
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 11 } } : { titleBarOverlay: { color: colors.header, symbolColor: colors.symbols, height: 36 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Lets the page start in the right theme without a flash.
      additionalArguments: [`--mv-theme=${theme}`]
    }
  })

  win.once('ready-to-show', () => win?.show())
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') send({ type: 'navigate', direction: 'back' })
    else if (cmd === 'browser-forward') send({ type: 'navigate', direction: 'forward' })
  })
  win.on('closed', () => {
    win = null
  })

  // The app only shows its own UI – external links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        win?.webContents.toggleDevTools()
      }
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  void app.whenReady().then(() => {
    const userData = app.getPath('userData')
    store = new ProfileStore(path.join(userData, 'routers.json'))
    settings = new SettingsStore(path.join(userData, 'settings.json'))
    logsRoot = path.join(userData, 'logs')
    updater = new Updater((status) => send({ type: 'update', status }))
    if (!isMac) Menu.setApplicationMenu(null)
    registerIpc()
    createWindow()

    for (const p of store.list()) if (p.autoConnect) void getSession(p.id).connect({ retryOnFail: true })

    const prune = (): void => void pruneAll(logsRoot, settings.get().logRetentionDays)
    prune()
    setInterval(prune, PRUNE_INTERVAL)
    if (app.isPackaged) setTimeout(() => void updater.check(), 8000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    for (const s of sessions.values()) s.dispose()
    for (const l of logStores.values()) l.flushSync()
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}
