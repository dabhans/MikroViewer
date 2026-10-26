import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { MikroApi, SessionEvent } from '../shared/types'

const api: MikroApi = {
  platform: process.platform,
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (input) => ipcRenderer.invoke('profiles:save', input),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  testProfile: (input) => ipcRenderer.invoke('profiles:test', input),
  getStatuses: () => ipcRenderer.invoke('session:statuses'),
  connect: (id) => ipcRenderer.invoke('session:connect', id),
  disconnect: (id) => ipcRenderer.invoke('session:disconnect', id),
  focus: (id) => ipcRenderer.send('session:focus', id),
  routerLog: (id) => ipcRenderer.invoke('session:routerLog', id),
  clearConnectionLog: (id) => ipcRenderer.invoke('connlog:clear', id),
  exportConnectionLog: (id) => ipcRenderer.invoke('connlog:export', id),
  onEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, event: SessionEvent): void => cb(event)
    ipcRenderer.on('mv:event', handler)
    return () => {
      ipcRenderer.removeListener('mv:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
