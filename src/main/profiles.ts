// Stores router profiles locally in the user's app data folder.
// Passwords are encrypted with Electron's safeStorage (DPAPI on Windows, Keychain on macOS).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { safeStorage } from 'electron'
import type { ProfileInput, RouterProfile } from '../shared/types'

interface StoredRouter {
  id: string
  name: string
  host: string
  port: number
  username: string
  useTls: boolean
  autoConnect: boolean
  tlsFingerprint?: string
  /** Base64 of the safeStorage-encrypted password. */
  password?: string
}

interface StoreFile {
  version: 1
  routers: StoredRouter[]
}

export class ProfileStore {
  private routers: StoredRouter[] = []
  /** Used when the OS offers no encryption – the password is then only kept in memory. */
  private memoryPasswords = new Map<string, string>()

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreFile
      this.routers = Array.isArray(data.routers) ? data.routers : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not read router profiles:', err)
      this.routers = []
    }
  }

  private persist(): void {
    const data: StoreFile = { version: 1, routers: this.routers }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  private toProfile(r: StoredRouter): RouterProfile {
    return {
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      username: r.username,
      useTls: r.useTls,
      autoConnect: r.autoConnect,
      tlsFingerprint: r.tlsFingerprint,
      hasPassword: r.password !== undefined || this.memoryPasswords.has(r.id)
    }
  }

  list(): RouterProfile[] {
    return this.routers.map((r) => this.toProfile(r))
  }

  get(id: string): StoredRouter | undefined {
    return this.routers.find((r) => r.id === id)
  }

  async getPassword(id: string): Promise<string> {
    const r = this.get(id)
    if (r?.password !== undefined && (await safeStorage.isAsyncEncryptionAvailable())) {
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(r.password, 'base64'))
        if (shouldReEncrypt) {
          r.password = (await safeStorage.encryptStringAsync(result)).toString('base64')
          this.persist()
        }
        return result
      } catch (err) {
        console.error('Could not decrypt password:', err)
      }
    }
    return this.memoryPasswords.get(id) ?? ''
  }

  async save(input: ProfileInput): Promise<RouterProfile> {
    const existing = input.id ? this.get(input.id) : undefined
    const id = existing?.id ?? crypto.randomUUID()
    const hostChanged = existing && (existing.host !== input.host.trim() || existing.port !== input.port || existing.useTls !== input.useTls)
    const router: StoredRouter = {
      id,
      name: input.name.trim(),
      host: input.host.trim(),
      port: input.port,
      username: input.username.trim(),
      useTls: input.useTls,
      autoConnect: input.autoConnect,
      // New address = new certificate; otherwise keep the known fingerprint.
      tlsFingerprint: hostChanged || input.resetFingerprint ? undefined : existing?.tlsFingerprint,
      password: existing?.password
    }
    if (input.password !== undefined) {
      if (await safeStorage.isAsyncEncryptionAvailable()) {
        router.password = (await safeStorage.encryptStringAsync(input.password)).toString('base64')
      } else {
        router.password = undefined
        this.memoryPasswords.set(id, input.password)
      }
    }
    // Look up again after the awaits – the list may have changed meanwhile.
    const index = this.routers.findIndex((r) => r.id === id)
    if (index !== -1) this.routers[index] = router
    else this.routers.push(router)
    this.persist()
    return this.toProfile(router)
  }

  /** Gives an unnamed profile the router's identity as its name. Returns true if it changed. */
  nameIfEmpty(id: string, name: string): boolean {
    const r = this.get(id)
    if (!r || r.name || !name) return false
    r.name = name
    this.persist()
    return true
  }

  setFingerprint(id: string, fingerprint: string | undefined): void {
    const r = this.get(id)
    if (!r) return
    r.tlsFingerprint = fingerprint
    this.persist()
  }

  delete(id: string): void {
    this.routers = this.routers.filter((r) => r.id !== id)
    this.memoryPasswords.delete(id)
    this.persist()
  }
}
