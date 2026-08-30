import { defineConfig } from 'vite'
import fs from 'node:fs'

// Dev-only diagnostic collector: the game POSTs camera/scene telemetry to
// /__diag while a camera bug is being chased. Appends JSON lines to a file.
// Remove together with game.js's _spawnDiagnostic once the hunt is over.
const diagCollector = {
  name: 'diag-collector',
  configureServer(server) {
    server.middlewares.use('/__diag', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; return res.end() }
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          fs.appendFileSync('/tmp/sea-of-friends-diag.jsonl', body.slice(0, 20000) + '\n')
        } catch { /* diagnostics must never break the dev server */ }
        res.statusCode = 204
        res.end()
      })
    })
  },
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  server: {
    port: 3000,
    open: false,
  },
  plugins: [diagCollector],
})
