// App settings (theme, how long logs are kept and how much space they may take) in settings.json
// next to the router profiles.

import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = { theme: 'light', logRetentionDays: 7, logMaxMB: 1024 }
export const RETENTION_CHOICES = [1, 7, 30, 90]
/** MB; 0 is no limit. */
export const SIZE_CHOICES = [100, 250, 500, 1024, 2048, 5120, 0]

export class SettingsStore {
  private data: Settings

  constructor(private readonly file: string) {
    this.data = { ...DEFAULTS }
    try {
      this.data = this.validate({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not read settings:', err)
    }
  }

  get(): Settings {
    return { ...this.data }
  }

  set(patch: Partial<Settings>): Settings {
    this.data = this.validate({ ...this.data, ...patch })
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    return this.get()
  }

  private validate(s: Settings): Settings {
    return {
      theme: s.theme === 'dark' ? 'dark' : 'light',
      logRetentionDays: RETENTION_CHOICES.includes(Number(s.logRetentionDays)) ? Number(s.logRetentionDays) : DEFAULTS.logRetentionDays,
      logMaxMB: SIZE_CHOICES.includes(Number(s.logMaxMB)) ? Number(s.logMaxMB) : DEFAULTS.logMaxMB
    }
  }
}
