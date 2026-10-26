// Updates from GitHub Releases. The installed app downloads and installs a new version itself
// (electron-updater); the portable exe can't replace itself, so it only gets a link to the release.

import { app, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

/** Must match `publish` in electron-builder.yml. */
export const RELEASE_REPO = 'dabhans/MikroViewer'
const RELEASE_PAGE = `https://github.com/${RELEASE_REPO}/releases/latest`

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION|ETIMEDOUT/.test(msg)) {
    return 'Could not reach GitHub. Check the internet connection.'
  }
  if (/\b404\b|No published versions|Cannot find latest/i.test(msg)) return 'No release has been published yet.'
  return msg.split('\n')[0].slice(0, 200)
}

function newer(a: string, b: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

export class Updater {
  status: UpdateStatus = { state: 'idle' }
  readonly portable = !!process.env.PORTABLE_EXECUTABLE_DIR
  /** A local feed for testing: MIKROVIEWER_UPDATE_URL=http://127.0.0.1:8090/ */
  private readonly testFeed = process.env.MIKROVIEWER_UPDATE_URL

  constructor(private readonly emit: (status: UpdateStatus) => void) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    if (this.testFeed) {
      autoUpdater.setFeedURL({ provider: 'generic', url: this.testFeed })
      autoUpdater.forceDevUpdateConfig = true
    }
    autoUpdater.on('update-available', (info) => this.set({ state: 'available', version: info.version }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }))
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', version: this.status.version, percent: p.percent }))
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', (err) => this.set({ state: 'error', version: this.status.version, error: friendlyError(err) }))
  }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = status
    this.emit(status)
    return status
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged && !this.testFeed) return this.set({ state: 'unsupported' })
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    this.set({ state: 'checking' })
    try {
      if (this.portable) await this.checkPortable()
      else await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', error: friendlyError(err) })
    }
    return this.status
  }

  /** The portable exe has no updater – ask GitHub for the latest release directly. */
  private async checkPortable(): Promise<void> {
    const res = await net.fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (res.status === 404) throw new Error('404')
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const release = (await res.json()) as { tag_name?: string; html_url?: string }
    const version = (release.tag_name ?? '').replace(/^v/, '')
    if (version && newer(version, app.getVersion())) this.set({ state: 'available', version, url: release.html_url ?? RELEASE_PAGE })
    else this.set({ state: 'none' })
  }

  async download(): Promise<void> {
    if (this.portable) {
      await shell.openExternal(this.status.url ?? RELEASE_PAGE)
      return
    }
    // After a failed download the found version can be retried.
    if (this.status.state !== 'available' && !(this.status.state === 'error' && this.status.version)) return
    const version = this.status.version
    this.set({ state: 'downloading', version, percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.set({ state: 'error', version, error: friendlyError(err) })
    }
  }

  install(): void {
    // Silent install keeps the chosen folder and starts the new version afterwards.
    if (this.status.state === 'ready') autoUpdater.quitAndInstall(true, true)
  }
}
