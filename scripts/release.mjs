#!/usr/bin/env node
// Builds the Windows installer and portable exe and publishes them as a GitHub release, which
// the installed app then offers as an update. Uses the GitHub CLI login (gh auth login).
//
//   npm version minor     (or patch – sets the new version number, commits and tags it)
//   npm run release
//
// The version's commit and tag are pushed first, so the release points at the code it was built
// from. The release is created as a draft and published at the end: electron-builder uploads the
// installer and the portable exe in parallel, and both would otherwise try to create it.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'

// Versions up to 0.2.1 look for updates in this repository. Each release is copied there as well,
// so they can update; archive the repository on GitHub when that is no longer needed.
const LEGACY_REPO = 'dabhans/MikroViewer-releases'

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

const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

const gh = findGh()
const ghRun = (args, opts = {}) => execFileSync(gh, args, { encoding: 'utf8', ...opts }).trim()
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

// The repository is configured in electron-builder.yml (publish: owner/repo).
const builderYml = fs.readFileSync('electron-builder.yml', 'utf8')
const owner = builderYml.match(/^\s+owner:\s*(\S+)/m)?.[1]
const repoName = builderYml.match(/^\s+repo:\s*(\S+)/m)?.[1]
if (!owner || !repoName) fail('No publish owner/repo in electron-builder.yml')
const repo = `${owner}/${repoName}`
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const tag = `v${version}`

let token = process.env.GH_TOKEN
if (!token) {
  try {
    token = ghRun(['auth', 'token'])
  } catch {
    fail('No GitHub login found. Run "gh auth login" first (or set GH_TOKEN).')
  }
}

if (git(['status', '--porcelain'])) fail('There are uncommitted changes. Commit them first.')
let tagCommit = ''
try {
  tagCommit = git(['rev-parse', `${tag}^{commit}`])
} catch {
  fail(`No tag ${tag}. Set the version with "npm version patch" (it creates the tag).`)
}
if (tagCommit !== git(['rev-parse', 'HEAD'])) fail(`${tag} is not the current commit. Check out ${tag} or set a new version.`)

const releaseState = (r) => {
  try {
    return JSON.parse(ghRun(['release', 'view', tag, '--repo', r, '--json', 'isDraft'], { stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null // not created yet
  }
}
const existing = releaseState(repo)
if (existing && !existing.isDraft) fail(`${tag} is already published in ${repo}. Set a new version first: npm version patch`)

// Push with the GitHub CLI login, without changing the git configuration.
const helper = `!"${gh.replaceAll('\\', '/')}" auth git-credential`
execFileSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'push', 'origin', 'HEAD', `refs/tags/${tag}`], { stdio: 'inherit' })

if (!existing) ghRun(['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--title', `MikroViewer ${version}`, '--generate-notes'])
console.log(`Publishing MikroViewer ${version} to ${repo}…`)

const run = (args, env = {}) => {
  const r = spawnSync(`npx ${args.join(' ')}`, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run(['electron-vite', 'build'])
run(['electron-builder', '--win', '--publish', 'always'], { GH_TOKEN: token })

ghRun(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
console.log(`Done – https://github.com/${repo}/releases/tag/${tag}`)

let legacyArchived = true
try {
  legacyArchived = JSON.parse(ghRun(['repo', 'view', LEGACY_REPO, '--json', 'isArchived'], { stdio: ['ignore', 'pipe', 'ignore'] })).isArchived
} catch {
  // deleted
}
if (!legacyArchived && !releaseState(LEGACY_REPO)) {
  const files = [`MikroViewer-Setup-${version}.exe`, `MikroViewer-Setup-${version}.exe.blockmap`, `MikroViewer-${version}-portable.exe`, 'latest.yml']
  console.log(`Copying the release to ${LEGACY_REPO} for older versions…`)
  ghRun(['release', 'create', tag, '--repo', LEGACY_REPO, '--title', `MikroViewer ${version}`, '--latest',
    '--notes', `See the release notes in [${repo}](https://github.com/${repo}/releases/tag/${tag}).`,
    ...files.map((f) => `dist/${f}`)], { stdio: ['ignore', 'pipe', 'inherit'] })
}
