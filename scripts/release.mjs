#!/usr/bin/env node
// Builds the Windows installer and portable exe and publishes them as a GitHub release, which
// the installed app then offers as an update. Uses the GitHub CLI login (gh auth login).
//
//   npm version minor     (or patch – sets the new version number)
//   npm run release
//
// The release is created as a draft first and published at the end: electron-builder uploads
// the installer and the portable exe in parallel, and both would otherwise try to create it.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'

function findGh() {
  for (const gh of ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe']) {
    try {
      execFileSync(gh, ['--version'], { stdio: 'ignore' })
      return gh
    } catch {
      // try the next one
    }
  }
  console.error('GitHub CLI not found. Install it and run "gh auth login".')
  process.exit(1)
}

const gh = findGh()
const ghRun = (args, opts = {}) => execFileSync(gh, args, { encoding: 'utf8', ...opts }).trim()

// The repository is configured in electron-builder.yml (publish: owner/repo).
const builderYml = fs.readFileSync('electron-builder.yml', 'utf8')
const owner = builderYml.match(/^\s+owner:\s*(\S+)/m)?.[1]
const repoName = builderYml.match(/^\s+repo:\s*(\S+)/m)?.[1]
if (!owner || !repoName) {
  console.error('No publish owner/repo in electron-builder.yml')
  process.exit(1)
}
const repo = `${owner}/${repoName}`
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const tag = `v${version}`

let token = process.env.GH_TOKEN
if (!token) {
  try {
    token = ghRun(['auth', 'token'])
  } catch {
    console.error('No GitHub login found. Run "gh auth login" first (or set GH_TOKEN).')
    process.exit(1)
  }
}

let existing = null
try {
  existing = JSON.parse(ghRun(['release', 'view', tag, '--repo', repo, '--json', 'isDraft'], { stdio: ['ignore', 'pipe', 'ignore'] }))
} catch {
  // not created yet
}
if (existing && !existing.isDraft) {
  console.error(`${tag} is already published in ${repo}. Set a new version first: npm version patch`)
  process.exit(1)
}
if (!existing) ghRun(['release', 'create', tag, '--repo', repo, '--draft', '--title', `MikroViewer ${version}`, '--notes', ''])
console.log(`Publishing MikroViewer ${version} to ${repo}…`)

const run = (args, env = {}) => {
  const r = spawnSync('npx', args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run(['electron-vite', 'build'])
run(['electron-builder', '--win', '--publish', 'always'], { GH_TOKEN: token })

ghRun(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
console.log(`Done – https://github.com/${repo}/releases/tag/${tag}`)
