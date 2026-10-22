// The few globals the engine and its tests use that every runtime it runs
// in has - browsers, Cloudflare Workers and Node (vitest) - declared here
// instead of pulling in the DOM lib, so anything browser-only stays an error.

declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

declare const performance: { now(): number };

declare function structuredClone<T>(value: T): T;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
