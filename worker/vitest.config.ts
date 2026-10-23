import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs the tests inside the Workers runtime (workerd, via Miniflare), with
// the real Durable Object and its SQLite storage. Bots move at once (no
// pause), so a whole hand plays in a test; one test puts the pause back.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TABLE_PAUSE_MS: "0" } } })],
});
