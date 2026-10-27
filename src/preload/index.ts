import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { MikroApi, SessionEvent } from '../shared/types'

const themeArg = process.argv.find((a) => a.startsWith('--mv-theme='))

const api: MikroApi = {
  platform: process.platform,
  initialTheme: themeArg?.endsWith('=dark') ? 'dark' : 'light',
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (input) => ipcRenderer.invoke('profiles:save', input),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  testProfile: (input) => ipcRenderer.invoke('profiles:test', input),
  getStatuses: () => ipcRenderer.invoke('session:statuses'),
  connect: (id) => ipcRenderer.invoke('session:connect', id),
  disconnect: (id) => ipcRenderer.invoke('session:disconnect', id),
  focus: (id) => ipcRenderer.send('session:focus', id),
  routerLog: (id) => ipcRenderer.invoke('session:routerLog', id),
  firewallStatus: (id) => ipcRenderer.invoke('session:firewallStatus', id),
  queryLogs: (q) => ipcRenderer.invoke('logs:query', q),
  exportLogs: (req) => ipcRenderer.invoke('logs:export', req),
  logStorage: () => ipcRenderer.invoke('logs:storage'),
  deleteLogs: () => ipcRenderer.invoke('logs:delete'),
  openLogFolder: () => ipcRenderer.invoke('logs:openFolder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  appInfo: () => ipcRenderer.invoke('app:info'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, event: SessionEvent): void => cb(event)
    ipcRenderer.on('mv:event', handler)
    return () => {
      ipcRenderer.removeListener('mv:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
