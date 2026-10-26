import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ProfileStore } from './profiles'
import { RouterSession, testConnection, type SessionCredentials, type SessionHost } from './routeros/session'
import type { ProfileInput, SessionEvent } from '../shared/types'

// Allows running with a separate data folder (e.g. for testing or a portable install).
if (process.env.MIKROVIEWER_USER_DATA) app.setPath('userData', path.resolve(process.env.MIKROVIEWER_USER_DATA))

const isMac = process.platform === 'darwin'
/** Matches the header bar colour in styles.css. */
const HEADER_COLOR = '#1c2531'
let win: BrowserWindow | null = null
let store: ProfileStore
const sessions = new Map<string, RouterSession>()
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

function getSession(id: string): RouterSession {
  let s = sessions.get(id)
  if (!s) {
    s = new RouterSession(id, host)
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

  ipcMain.handle('connlog:clear', (_e, id: string) => {
    sessions.get(id)?.clearLog()
  })

  ipcMain.handle('connlog:export', async (_e, id: string) => {
    const s = sessions.get(id)
    if (!s || !win) return { saved: false }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
    const base = (s.identity || store.get(id)?.name || 'router').replace(/[^\w.-]+/g, '_')
    const res = await dialog.showSaveDialog(win, {
      title: 'Export connection log',
      defaultPath: path.join(app.getPath('documents'), `connection-log-${base}-${stamp}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return { saved: false }
    await fs.writeFile(res.filePath, s.connectionLogCsv(), 'utf8')
    return { saved: true, path: res.filePath }
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    title: 'MikroViewer',
    backgroundColor: '#eceff2',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 11 } } : { titleBarOverlay: { color: HEADER_COLOR, symbolColor: '#dfe5ec', height: 36 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win?.show())
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
    store = new ProfileStore(path.join(app.getPath('userData'), 'routers.json'))
    if (!isMac) Menu.setApplicationMenu(null)
    registerIpc()
    createWindow()

    for (const p of store.list()) if (p.autoConnect) void getSession(p.id).connect({ retryOnFail: true })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    for (const s of sessions.values()) s.dispose()
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}
