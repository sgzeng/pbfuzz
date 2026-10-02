#!/usr/bin/env node
// Re-pin the plugins to one DeepSeek Harness release: every `@deepseek-ai/dsh-*` devDependency and
// pnpm override, the peer ranges, the cordis / schemastery pins DSH itself requires, and
// HARNESS_COMMIT. Used by the weekly compat workflow (.github/workflows/dsh-compat.yml) and by hand:
//
//   node scripts/bump-dsh.mjs            # the npm `latest` of @deepseek-ai/dsh
//   node scripts/bump-dsh.mjs 0.2.0-rc.2
//
// It only edits files; run `pnpm install --no-frozen-lockfile` afterwards.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const npm = (...args) => execFileSync('npm', args, { encoding: 'utf8' }).trim()
const npmJson = (...args) => JSON.parse(npm(...args, '--json'))

const version = process.argv[2] ?? npm('view', '@deepseek-ai/dsh', 'dist-tags.latest')
const next = version.replace(/^(\d+)\.(\d+)\..*$/, (_, major, minor) => (major === '0' ? `0.${Number(minor) + 1}.0` : `${Number(major) + 1}.0.0`))
const dshRange = `>=${version} <${next}`

// What DSH itself requires of the two libraries it shares with plugins.
const dshDeps = npmJson('view', `@deepseek-ai/dsh@${version}`, 'dependencies')
const settingsPeers = npmJson('view', `@deepseek-ai/dsh-settings@${version}`, 'peerDependencies')
const newest = range => npm('view', `${range.name}@${range.range}`, 'version').split('\n').pop().split(' ').pop().replace(/['"]/g, '')
const cordis = newest({ name: '@deepseek-ai/cordis', range: dshDeps['@deepseek-ai/cordis'] })
const schemastery = newest({ name: '@deepseek-ai/schemastery', range: settingsPeers['@deepseek-ai/schemastery'] })
const floor = v => v.replace(/^[~^]/, '')

const edit = (path, fn) => {
  const file = join(root, path)
  const before = readFileSync(file, 'utf8')
  const after = fn(before)
  if (after !== before) writeFileSync(file, after)
  return after !== before
}

for (const pkg of ['packages/dsh-pbfuzz/package.json', 'packages/dsh-kanalyzer/package.json']) {
  edit(pkg, text => {
    const json = JSON.parse(text)
    for (const [name, spec] of Object.entries(json.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) json.peerDependencies[name] = dshRange
      else if (name === '@deepseek-ai/cordis') json.peerDependencies[name] = `>=${cordis} <5.0.0`
      else if (name === '@deepseek-ai/schemastery') json.peerDependencies[name] = `>=${floor(schemastery)} <4.0.0`
      void spec
    }
    for (const name of Object.keys(json.devDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) json.devDependencies[name] = version
      else if (name === '@deepseek-ai/cordis') json.devDependencies[name] = cordis
      else if (name === '@deepseek-ai/schemastery') json.devDependencies[name] = schemastery
    }
    if (json.dependencies?.['@deepseek-ai/schemastery']) json.dependencies['@deepseek-ai/schemastery'] = `^${schemastery}`
    return `${JSON.stringify(json, null, 2)}\n`
  })
}

// Transitive DSH packages whose npm `latest` tag lags resolve to stale versions; pin them all.
edit('pnpm-workspace.yaml', text => text.replace(/^(\s+'@deepseek-ai\/dsh-[a-z-]+': )\S+$/gm, `$1${version}`))

edit('HARNESS_COMMIT', text => text
  .replace(/^DSH_VERSION=.*$/m, `DSH_VERSION=${version}`)
  .replace(/^DSH_PEER_RANGE=.*$/m, `DSH_PEER_RANGE=${dshRange}`)
  .replace(/^CORDIS_PEER_RANGE=.*$/m, `CORDIS_PEER_RANGE=>=${cordis} <5.0.0`)
  .replace(/^SCHEMASTERY_RANGE=.*$/m, `SCHEMASTERY_RANGE=^${schemastery}`))

console.log(`pinned to DSH ${version} (peer range "${dshRange}", cordis ${cordis}, schemastery ${schemastery})`)
