import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Stamped at build time (not runtime) so the deployed page shows exactly
// when it was built, regardless of the viewer's own clock/timezone. HKT has
// no DST, so a fixed +8h offset off UTC is always correct.
function buildTimeHKT(): string {
  const hkt = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${hkt.getUTCFullYear()}-${pad(hkt.getUTCMonth() + 1)}-${pad(hkt.getUTCDate())} ${pad(hkt.getUTCHours())}:${pad(hkt.getUTCMinutes())} HKT`
}

// A short hash of each model in public/model, which keeps its name when
// retrained: the page asks for "<file>?v=<hash>", so the service worker can
// keep a copy until the file really changes (see public/sw.js).
function modelVersions(): Record<string, string> {
  const dir = 'public/model'
  if (!existsSync(dir)) return {}
  const out: Record<string, string> = {}
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.onnx')) out[file] = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex').slice(0, 10)
  }
  return out
}

// The voice trial pages and their clips (scripts/voices-minimax.ts) are
// for the dev server only: left out of the build.
const DEV_ONLY = ['voices-test', 'voice-test.html', 'voice-check.html']
function devOnlyFiles(): Plugin {
  let outDir = 'dist'
  return {
    name: 'mjwaits-dev-only-files',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      for (const name of DEV_ONLY) rmSync(join(outDir, name), { recursive: true, force: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/mjwaits/',
  plugins: [react(), devOnlyFiles()],
  define: {
    __BUILD_TIME__: JSON.stringify(buildTimeHKT()),
    __MODEL_VERSIONS__: JSON.stringify(modelVersions()),
  },
  // The dev server also answers on this Mac's Tailscale name (*.ts.net),
  // which stays the same on any network - unlike the LAN IP.
  server: {
    allowedHosts: ['.ts.net'],
  },
  test: {
    // worker/ has its own tests, run inside the Workers runtime (npm test
    // runs both); .claude/ holds other sessions' worktrees, full copies of
    // this repo whose tests aren't ours to run.
    // e2e/ is Playwright's (npm run e2e).
    exclude: [...configDefaults.exclude, 'worker/**', '.claude/**', 'e2e/**'],
  },
})
