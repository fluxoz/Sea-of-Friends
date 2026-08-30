/**
 * CI determinism gate: two real peers over a local tracker, artificial input
 * lag to force constant prediction + rollback, broadsides flying — then
 * assert that every overlapping state hash matches and the desync tripwire
 * stayed silent. One careless Math.random() in sim code fails this in CI
 * before it can fail a crew at sea.
 *
 * Self-contained: starts its own WebSocket tracker and Vite dev server.
 */
import { spawn } from 'node:child_process'
import { Server } from 'bittorrent-tracker'
import { chromium } from 'playwright'

const TRACKER_PORT = 8009
const VITE_PORT    = 4519
const RUN_SECS     = 30

const tracker = new Server({ udp: false, http: false, ws: true })
await new Promise(res => tracker.listen(TRACKER_PORT, res))
console.log(`tracker on ws://localhost:${TRACKER_PORT}`)

const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
vite.stderr.on('data', d => process.stderr.write('[vite] ' + d))
// Don't parse the banner — poll the port until it answers
{
  const deadline = Date.now() + 60000
  let up = false
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${VITE_PORT}/`)
      if (r.ok) { up = true; break }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!up) throw new Error('vite did not start within 60s')
}
console.log(`vite on http://localhost:${VITE_PORT}`)

const failures = []
// CHROMIUM_PATH lets NixOS contributors point at a system browser; CI uses
// Playwright's bundled build
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
const room = 'ci-' + Date.now()
const RELAYS = encodeURIComponent(`ws://localhost:${TRACKER_PORT}`)

const mk = async name => {
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 640 } })).newPage()
  page.on('pageerror', e => failures.push(`pageerror[${name}]: ${e.message.slice(0, 200)}`))
  await page.goto(`http://localhost:${VITE_PORT}/?relays=${RELAYS}&lagms=150`)
  await page.waitForSelector('#join-btn', { timeout: 30000 })
  await page.fill('#name-input', name)
  await page.fill('#room-input', room)
  await page.click('#join-btn')
  return page
}

const A = await mk('Alice')
await new Promise(r => setTimeout(r, 9000))
const B = await mk('Bob')
await new Promise(r => setTimeout(r, 9000))

await A.keyboard.down('w'); await B.keyboard.down('w')
for (let i = 0; i < RUN_SECS / 5; i++) {
  await A.keyboard.press('q'); await B.keyboard.press('e')
  await new Promise(r => setTimeout(r, 5000))
}

const probe = page => page.evaluate(() => {
  const g = window.__game, ls = g.lockstep
  return {
    state: ls.state, live: ls._selfLive, confirmed: ls.confirmed,
    rollbacks: ls.rollbacks, players: g.sim.players.size,
    hashes: [...ls._hashes.entries()],
    desync: [...document.querySelectorAll('#chat-messages *')]
      .some(el => el.textContent.includes('DESYNC')),
  }
})
const [a, b] = await Promise.all([probe(A), probe(B)])
console.log('A:', JSON.stringify({ ...a, hashes: a.hashes.length }))
console.log('B:', JSON.stringify({ ...b, hashes: b.hashes.length }))

for (const [peer, r] of [['A', a], ['B', b]]) {
  if (r.state !== 'running' || !r.live) failures.push(`${peer} not running/live`)
  if (r.players !== 2) failures.push(`${peer} sees ${r.players} players, expected 2`)
  if (r.confirmed < 300) failures.push(`${peer} confirmed only ${r.confirmed}`)
  if (r.desync) failures.push(`${peer} reported a DESYNC`)
}
const bh = new Map(b.hashes)
let compared = 0
for (const [t, h] of a.hashes) {
  if (!bh.has(t)) continue
  compared++
  if (h !== bh.get(t)) failures.push(`hash mismatch at tick ${t}: ${h} vs ${bh.get(t)}`)
}
if (compared < 3) failures.push(`only ${compared} overlapping hashes compared`)
console.log(`${compared} overlapping hashes compared`)

await browser.close()
vite.kill()
tracker.close()

if (failures.length) {
  console.error('DETERMINISM GATE FAILED:')
  for (const f of failures) console.error(' -', f)
  process.exit(1)
}
console.log('DETERMINISM GATE PASSED')
process.exit(0)
