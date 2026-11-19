// public/sw.js itself, run against a pretend server and cache: what's stored
// - and what's left alone - as builds come and go, with and without signal.
import { describe, expect, it } from "vitest";
import code from "../../public/sw.js?raw";

const ORIGIN = "https://app.test";
const SCOPE = "/mjwaits/";
const at = (path: string) => `${ORIGIN}${SCOPE}${path}`;

type Served = { status?: number; type?: string; body: string };

// A build: its page, its list, and its files (named by the build's letter).
function build(tag: string, parts = ["index", "PlayPanel", "ledger"]) {
  const files = parts.map((p) => `assets/${p}-${tag.repeat(8)}.js`);
  const page = `<html><script type="module" crossorigin src="${SCOPE}${files[0]}"></script><link rel="stylesheet" href="${SCOPE}assets/index-${tag.repeat(8)}.css"></html>`;
  const css = `assets/index-${tag.repeat(8)}.css`;
  const engine = "assets/ort-wasm-simd-threaded-ENGINE00.wasm"; // (the same from build to build)
  const list = { core: [...files, css].map((f) => [f, 10]), scanner: { wasm: [[engine, 10]], webgpu: [] }, voices: { files: 0, bytes: 0 } };
  const served = new Map<string, Served>([["", { type: "text/html", body: page }], ["offline.json", { type: "application/json", body: JSON.stringify(list) }]]);
  for (const f of [...files, css, engine]) served.set(f, { type: f.endsWith(".css") ? "text/css" : "text/javascript", body: `/* ${f} */` });
  return { page, files: [...files, css], engine, served };
}

function harness() {
  let online = true;
  let served = new Map<string, Served>();
  const store = new Map<string, { status: number; type: string; body: string }>();
  const key = (r: string | { url: string }) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);
  const cache = {
    match: async (r: string | { url: string }) => {
      const hit = store.get(key(r));
      return hit ? new Response(hit.body, { status: hit.status, headers: { "content-type": hit.type } }) : undefined;
    },
    put: async (r: string | { url: string }, response: Response) => void store.set(key(r), { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text() }),
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (r: string | { url: string }) => store.delete(key(r)),
  };
  const fetchFake = async (input: string | { url: string }) => {
    if (!online) throw new TypeError("offline");
    const url = new URL(key(input));
    const hit = served.get(url.pathname.slice(SCOPE.length) + url.search);
    if (!hit) return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": hit.type ?? "text/plain" } });
  };
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    registration: { scope: `${ORIGIN}${SCOPE}` },
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  new Function("self", "caches", "fetch", code)(self, { open: async () => cache, keys: async () => ["mjwaits-v1"], delete: async () => true }, fetchFake);

  // One request through the worker: its answer, once all it kept the event alive for is done.
  const ask = async (path: string, mode = "cors") => {
    const waits: Promise<unknown>[] = [];
    let answer: Promise<Response> | undefined;
    listeners.fetch({ request: { url: at(path), method: "GET", mode, cache: "default" }, respondWith: (p: Promise<Response>) => (answer = p), waitUntil: (p: Promise<unknown>) => waits.push(p) });
    const response = await answer!;
    for (let i = 0; i < waits.length; i++) await waits[i];
    return response;
  };
  return {
    serve: (b: { served: Map<string, Served> }) => (served = new Map(b.served)),
    server: () => served,
    signal: (on: boolean) => (online = on),
    launch: async () => (await ask("", "navigate")).text(),
    ask,
    has: (path: string) => store.has(at(path)),
    storedPage: () => store.get(at(""))?.body,
  };
}

describe("the service worker", () => {
  it("stores a build whole on the first launch: the page, and every file of its own", async () => {
    const A = build("A");
    const h = harness();
    h.serve(A);
    expect(await h.launch()).toBe(A.page);
    expect(h.storedPage()).toBe(A.page);
    for (const f of A.files) expect(h.has(f), f).toBe(true);
  });

  it("leaves the last build as it was - page and files - when an update is cut short", async () => {
    const [A, B] = [build("A"), build("B")];
    const h = harness();
    h.serve(A);
    await h.launch();
    // B is up, but one of its files can't be had.
    h.serve(B);
    h.server().delete(B.files[1]);
    expect(await h.launch()).toBe(B.page); // (shown, with a signal)
    // The page uses its own script as it goes: stored, and nothing of A's dropped for it.
    await h.ask(B.files[0]);
    expect(h.storedPage()).toBe(A.page);
    for (const f of A.files) expect(h.has(f), f).toBe(true);
    // No signal now: the app that opens is A, whole.
    h.signal(false);
    expect(await h.launch()).toBe(A.page);
    for (const f of A.files) expect((await h.ask(f)).status, f).toBe(200);
  });

  it("takes a new build once it's all there, keeps the last one's files, and drops the one before", async () => {
    const [A, B, C] = [build("A"), build("B"), build("C")];
    const h = harness();
    h.serve(A);
    await h.launch();
    await h.ask(A.engine); // (the scanner's engine, fetched by the page)
    h.serve(B);
    await h.launch();
    expect(h.storedPage()).toBe(B.page);
    for (const f of [...A.files, ...B.files, A.engine]) expect(h.has(f), f).toBe(true);
    h.serve(C);
    await h.launch();
    expect(h.storedPage()).toBe(C.page);
    for (const f of A.files) expect(h.has(f), f).toBe(false);
    for (const f of [...B.files, ...C.files, C.engine]) expect(h.has(f), f).toBe(true);
  });

  it("shows the stored page, not the server's error", async () => {
    const A = build("A");
    const h = harness();
    h.serve(A);
    await h.launch();
    h.server().set("", { status: 503, type: "text/html", body: "<html>down</html>" });
    expect(await h.launch()).toBe(A.page);
    expect(h.storedPage()).toBe(A.page);
  });

  it("never keeps a page that came back in a file's place", async () => {
    const A = build("A");
    const h = harness();
    h.serve(A);
    await h.launch();
    h.server().set("assets/extra-XXXXXXXX.js", { type: "text/html", body: "<html>sign in to Wi-Fi</html>" });
    await h.ask("assets/extra-XXXXXXXX.js");
    expect(h.has("assets/extra-XXXXXXXX.js")).toBe(false);
  });

  it("reads the build's list from the network, and from the stored copy with no signal", async () => {
    const [A, B] = [build("A"), build("B")];
    const h = harness();
    h.serve(A);
    await h.launch();
    await h.ask("offline.json");
    h.serve(B);
    expect(await (await h.ask("offline.json")).text()).toBe(B.served.get("offline.json")!.body);
    h.signal(false);
    expect(await (await h.ask("offline.json")).text()).toBe(B.served.get("offline.json")!.body);
  });
});
