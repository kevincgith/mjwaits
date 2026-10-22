// What `env` from "cloudflare:test" holds: this Worker's bindings.
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
