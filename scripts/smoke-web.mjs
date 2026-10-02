#!/usr/bin/env node
// Browser smoke test: boot `dsh web` with the plugins installed and check that the UI starts and the
// plugins' settings pages render. The Host half can be perfect and the web UI still blank: DSH 0.2
// dropped `settingsScope`, which silently stopped BOTH client bundles from activating ("web boot:
// 2 entries did not activate") and no unit test could see it.
//
//   node scripts/smoke-web.mjs                       # DSH_HOME / PROFILE (default `web`) as installed
//   DSH_HOME=/tmp/h PROFILE=web node scripts/smoke-web.mjs --kanalyzer
//
// Needs `dsh` (or npx), Chromium and the `playwright` package (global or local). Exits non-zero with
// the page's console errors on failure.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const withKanalyzer = process.argv.includes('--kanalyzer')
const profile = process.env.PROFILE ?? 'web'
const port = process.env.PORT ?? String(3100 + Math.floor(Math.random() * 500))

function loadPlaywright() {
  const roots = [import.meta.url, `file://${execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()}/`]
  for (const root of roots) {
    try { return createRequire(root)('playwright') } catch { /* try the next location */ }
  }
  throw new Error('playwright not found: npm i -g playwright && npx playwright install chromium')
}
const { chromium } = loadPlaywright()

const workspace = mkdtempSync(join(tmpdir(), 'pbfuzz-smoke-'))
const dsh = spawn(process.env.DSH_BIN ?? 'dsh', ['--profile', profile, '--port', port, '--no-open'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
dsh.stdout.on('data', chunk => { log += chunk })
dsh.stderr.on('data', chunk => { log += chunk })

const failures = []
const fail = message => { failures.push(message); console.error(`FAIL: ${message}`) }
const ok = message => { console.log(`ok:   ${message}`) }

let browser
try {
  const url = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`dsh web did not print its URL in 90s:\n${log}`)), 90_000)
    const tick = setInterval(() => {
      const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)
      if (match) { clearTimeout(deadline); clearInterval(tick); resolve(match[0]) }
    }, 250)
    dsh.on('exit', code => { clearTimeout(deadline); clearInterval(tick); reject(new Error(`dsh exited (${code}) before serving:\n${log}`)) })
  })

  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } })
  const errors = []
  page.on('pageerror', error => { errors.push(`pageerror: ${error.message}`) })
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 300)}`) })

  const openPlugins = async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.getByText('Plugins', { exact: true }).first().waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => { /* preview notice, shown until accepted */ })
    await page.getByText('Plugins', { exact: true }).first().click()
  }
  await openPlugins()
  ok('web UI booted')

  // One bundle at a time: bundle page -> the row's Configure -> the plugin's own form.
  const check = async (bundle, row, expectText) => {
    await openPlugins()
    await page.getByText(bundle, { exact: true }).first().click({ timeout: 20_000 })
    await page.getByRole('button', { name: `Configure ${bundle}` }).click({ timeout: 20_000 })
    try {
      await page.getByText(expectText).first().waitFor({ timeout: 15_000 })
      ok(`${bundle}: settings page rendered ("${expectText}")`)
    } catch {
      fail(`${bundle}: settings page did not render "${expectText}" (row ${row})`)
    }
  }
  await check('@pbfuzz/dsh-pbfuzz', 'pbfuzz', 'Auxiliary analysis tools')
  if (withKanalyzer) await check('@pbfuzz/dsh-kanalyzer', 'kanalyzer', 'Install / build')

  const bad = errors.filter(line => /did not activate|slot entry crashed|Minified React error|pageerror/.test(line))
  if (bad.length > 0) fail(`browser errors:\n  ${bad.join('\n  ')}`)
  else ok('no activation / slot / React errors in the console')
  if (/did not activate/.test(log)) fail('dsh reported entries that did not activate')
} catch (error) {
  fail(String(error instanceof Error ? error.message : error))
} finally {
  await browser?.close().catch(() => {})
  dsh.kill('SIGTERM')
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed`)
  process.exit(1)
}
console.log('\nweb smoke passed')
