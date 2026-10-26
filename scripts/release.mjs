#!/usr/bin/env node
// Builds the Windows installer and portable exe and publishes them as a GitHub release, which
// the installed app then offers as an update. Uses the GitHub CLI login (gh auth login).
//
//   npm version minor     (or patch – sets the new version number)
//   npm run release

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'

function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  const candidates = ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe']
  for (const gh of candidates) {
    try {
      return execFileSync(gh, ['auth', 'token'], { encoding: 'utf8' }).trim()
    } catch {
      // try the next one
    }
  }
  console.error('No GitHub login found. Run "gh auth login" first (or set GH_TOKEN).')
  process.exit(1)
}

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const token = githubToken()
console.log(`Publishing MikroViewer ${version}…`)

const run = (args, env = {}) => {
  const r = spawnSync('npx', args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run(['electron-vite', 'build'])
run(['electron-builder', '--win', '--publish', 'always'], { GH_TOKEN: token })
console.log(`Done – version ${version} is published.`)
