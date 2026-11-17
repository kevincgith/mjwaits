import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// What this build is made of, for the page to say how much of it is stored
// for use with no signal (src/lib/offline.ts, the sheet behind the MJWaits
// icon) and to fetch the rest: offline.json - the app's own files, and the
// scanner's (its engine and model, by the engine a phone uses) - and
// offline-voices.json, the bots' voice clips (thousands: read only when
// asked for). Each file with its size in bytes, addressed from the base.
function offlineManifest(): Plugin {
  let outDir = 'dist'
  const walk = (dir: string, under: string): [string, number][] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name), `${under}${e.name}/`) : [[`${under}${e.name}`, statSync(join(dir, e.name)).size] as [string, number]],
        )
  return {
    name: 'mjwaits-offline-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const versions = modelVersions()
      const model = (file: string): [string, number][] =>
        existsSync(join(outDir, 'model', file)) ? [[`model/${file}${versions[file] ? `?v=${versions[file]}` : ''}`, statSync(join(outDir, 'model', file)).size]] : []
      const assets = walk(join(outDir, 'assets'), 'assets/')
      // The scanner's engine (onnxruntime): its GPU build ("webgpu", and the
      // "asyncify" wasm it runs on) or its plain one.
      const engine = (f: string) => /\/ort[-.]/.test(f)
      const gpu = (f: string) => /webgpu|asyncify|jsep/.test(f)
      const manifest = {
        core: assets.filter(([f]) => !engine(f)),
        scanner: {
          wasm: [...assets.filter(([f]) => engine(f) && !gpu(f)), ...model('tile-detector.onnx')],
          webgpu: [...assets.filter(([f]) => engine(f) && gpu(f)), ...model('tile-detector-fp32.onnx')],
        },
        voices: walk(join(outDir, 'voices'), 'voices/').reduce((t, [, b]) => ({ files: t.files + 1, bytes: t.bytes + b }), { files: 0, bytes: 0 }),
      }
      writeFileSync(join(outDir, 'offline.json'), JSON.stringify(manifest))
      writeFileSync(join(outDir, 'offline-voices.json'), JSON.stringify(walk(join(outDir, 'voices'), 'voices/')))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/mjwaits/',
  // (offlineManifest after devOnlyFiles: it lists what's left.)
  plugins: [react(), devOnlyFiles(), offlineManifest()],
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
