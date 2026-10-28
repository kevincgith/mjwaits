import { defineConfig } from 'vite'
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

// https://vite.dev/config/
export default defineConfig({
  base: '/mjwaits/',
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(buildTimeHKT()),
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
