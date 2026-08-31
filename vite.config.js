import { defineConfig } from 'vite'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

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

// version.json rides with every deploy so running clients can notice a newer
// build shipped and prompt a refresh (their protocol version keeps them from
// ever MEETING newer peers — this is how they find out why the sea is quiet).
const versionFile = {
  name: 'version-file',
  configureServer(server) {
    server.middlewares.use('/version.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ version: pkg.version }))
    })
  },
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }),
    })
  },
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  server: {
    port: 3000,
    open: false,
  },
  plugins: [diagCollector, versionFile],
})
