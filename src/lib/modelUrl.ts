// A model's address in public/model, with its content hash (worked out at
// build time, see vite.config.ts) - so the service worker can keep it until
// it's retrained, rather than fetching it again on every load.
declare const __MODEL_VERSIONS__: Record<string, string>;

export function modelUrl(file: string): string {
  const v = typeof __MODEL_VERSIONS__ === "undefined" ? undefined : __MODEL_VERSIONS__[file];
  return `${import.meta.env.BASE_URL}model/${file}${v ? `?v=${v}` : ""}`;
}
