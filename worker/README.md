# MJWaits live-scores server

The server behind the Scores tab's **線上** live scores: a Cloudflare Worker with one Durable
Object per shared game, each keeping its game in its own SQLite storage. The host's phone puts
its 戰況 game up and keeps it current; everyone following holds a WebSocket to the room and sees
each change the moment it's made; whoever the host allows can record into it too.

It runs on the Workers **free plan**: SQLite-backed Durable Objects, and the WebSocket
Hibernation API so a quiet room costs nothing while it waits.

```
shared/                  @mjwaits/shared - imported by the web app and this Worker alike
  engine/                the rules engine: tiles, tai scoring, the hand engine, score keeping (ledger.ts)
  protocol/              the messages (client.ts, server.ts), a game's full check (game.ts), limits.ts
worker/                  this Worker
  src/index.ts           routes: make a room, look one up, open its WebSocket; the Origin check
  src/room.ts            Room, the Durable Object: people, who records, the game, conflicts, expiry
  test/                  tests run inside the Workers runtime against the real Durable Object
src/lib/online.ts        the web app's side: rooms over HTTP, the live socket (RoomClient), and
                         keeping a phone's copy of the game in step with the room's (GameSync)
src/scores/live.tsx      the host's side: Go live, who records, stop sharing
src/scores/online.tsx    everyone else's: join, watch, record
```

The room keeps the game exactly as the Scores tab does - a `ScoreGame` from
`shared/engine/ledger.ts` - so every 戰況 feature (換人, 投降, 詐胡, fixing an older hand, 設定…)
works the same live, and every phone works the scores out with the same ledger.

## Local development

Needs Node 22 or newer. From the repo root:

```bash
npm install
```

Run the Worker and the app side by side, each in its own terminal:

```bash
npm run dev --workspace worker
```

```bash
npm run dev
```

The Worker listens on <http://localhost:8787>; the app (<http://localhost:5173/mjwaits/>)
talks to it there in development, and to `https://mj-api.kevinlhc.com` in a production build.
`VITE_MP_URL` overrides both, e.g. `VITE_MP_URL=https://mj-api.kevinlhc.com npm run dev` to try
the local app against the deployed server.

Rooms made under `wrangler dev` live in `worker/.wrangler/` and survive restarts; delete that
folder for a clean slate.

**Phones on your Wi-Fi.** Start the app with `npm run dev -- --host` and the Worker with
`npm run dev --workspace worker -- --ip 0.0.0.0`, then open `http://<your Mac's IP>:5173/mjwaits/`
on the phone. That page's origin isn't localhost, so allow it in `worker/.dev.vars` (git-ignored):

```
ALLOWED_ORIGINS="https://app.kevinlhc.com,http://192.168.0.141:5173"
```

## Tests

```bash
npm test                          # everything: the app and shared/, then the Worker
npm test --workspace worker       # just the Worker
```

The Worker's tests run inside the Workers runtime (`@cloudflare/vitest-plugin`), against the
real `Room` Durable Object and its SQLite storage, with real WebSockets: joining, reconnecting,
the Origin check and limits, expiry, sharing and following a game, who may record, two changes
at once, stopping, and a room evicted from memory mid-game carrying on. The protocol's
validation - including that the game check has exactly the ledger's fields - is tested in
`shared/protocol/protocol.test.ts`; the app's connection and GameSync in `src/lib/online.test.ts`.

## Deploying

`kevinlhc.com` is already on Cloudflare, so the Worker can be served at
`mj-api.kevinlhc.com` as a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/):
Cloudflare creates the DNS record and the certificate itself. That's set in
`worker/wrangler.jsonc` (`routes`).

1. **Make sure nothing already uses `mj-api.kevinlhc.com`.** In the Cloudflare dashboard,
   kevinlhc.com → DNS → Records: if there's a record for `mj-api`, delete it (a Custom Domain
   can't be added over an existing record).
2. **Log in** - this opens the browser to authorise wrangler with your Cloudflare account (the
   one kevinlhc.com is on):

   ```bash
   cd worker && npx wrangler login
   ```
3. **Deploy** (still in `worker/`):

   ```bash
   npm run deploy
   ```

   From the repo root it's `npm run deploy --workspace worker`.

   The first deploy also creates the `Room` Durable Object class (the `v1` migration) and
   attaches `mj-api.kevinlhc.com`. The certificate can take a few minutes to be issued.
4. **Check it:**

   ```bash
   curl https://mj-api.kevinlhc.com/health
   ```

   It answers `ok`. Making a room from anywhere but the app is refused, as it should be:

   ```bash
   curl -i -X POST https://mj-api.kevinlhc.com/rooms -H "Origin: https://app.kevinlhc.com"
   ```

   That one (claiming the app's origin) answers `201` with a code - a throwaway room, gone in an
   hour; without the header, `403`.
5. **Point the app at it.** Nothing to do: a production build already uses
   `https://mj-api.kevinlhc.com`. Merging to `main` deploys the app to GitHub Pages as before
   (the workflow builds with Node 22 and runs the Worker's tests too). To use another address,
   set `VITE_MP_URL` for the build step in `.github/workflows/deploy.yml`.
6. **Watch it live** when something looks wrong:

   ```bash
   npx wrangler tail mjwaits-mp
   ```

Later deploys are just step 3. The Worker deploys separately from the app: deploy the Worker
first when a change touches both, so the server understands any new message before the app
sends it.

**Which pages may connect.** `ALLOWED_ORIGINS` in `wrangler.jsonc` lists them, comma-separated
(localhost is always allowed, for development). It's an ordinary variable, not a secret: there
are no secrets yet. One added later goes in with `npx wrangler secret put NAME` (and
`worker/.dev.vars` locally), never in `wrangler.jsonc` or the app.

**Changing the stored data.** Each room creates its tables when it starts (`migrate()` in
`room.ts`), so a new table or column is added there with `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE`. A new Durable Object *class*, or renaming one, needs a new entry in
`migrations` in `wrangler.jsonc`.

### Free plan

What the Workers free plan allows is on Cloudflare's
[pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/). What
counts here:

- **Requests.** Making or looking up a room is one; each WebSocket message to a room counts as a
  small fraction of one (Cloudflare bills WebSocket messages at 20:1). An evening's game is a few
  hundred messages.
- **Duration.** A room is only billed while awake. With the Hibernation API it sleeps between
  messages, open sockets and all.
- **Storage.** A room is its game - tens of kilobytes for a long evening - and a few rows of
  bookkeeping. Each change rewrites the game: a handful of rows written.
- **CPU.** Each change is checked by replaying the game with the ledger: a millisecond or so for
  a long game. Tai scoring isn't done on the server at all.

### Limits and clean-up

All in `room.ts` and `shared/protocol/limits.ts`:

| What | Limit |
|---|---|
| Message size | 512 KB (a game of up to 3,000 entries) |
| Messages per connection | bursts of 20, then 5 a second; closed after 10 refusals in a row |
| Connections per room | 16 |
| People per room | 12; names up to 12 characters, no markup or invisible characters, unique ignoring case and width |
| A room no one joined | removed after 1 hour |
| Any other room | removed 2 days after its last change, never while anyone is connected |

Clean-up is one Durable Object alarm per room, set when it's made and moved only when it fires.

## Protocol

JSON over the WebSocket at `wss://mj-api.kevinlhc.com/rooms/<CODE>/ws`. Everything is defined
once in `shared/protocol/`: `client.ts` (what a phone sends, with the schema the server checks),
`game.ts` (a whole game, checked field by field and then replayed by the ledger), `server.ts`
(what the room sends), `limits.ts`. Bump `PROTOCOL_VERSION` when a message changes shape; a page
speaking another version is told to reload. (Version 1 was the earlier seat-and-lobby
scoreboard; rooms left from it are cleared when they wake.)

### HTTP

| Request | Answer |
|---|---|
| `POST /rooms` | `201 {"code":"3AC9X"}` - a new, empty room |
| `GET /rooms/<CODE>` | `200 {"code","phase","players"}`, or `404` |
| `GET /rooms/<CODE>/ws` | the WebSocket (`Upgrade: websocket`); `404` for no such room, `503` when it's full |
| `GET /health` | `ok` |

The room routes need an allowed `Origin` (else `403`). Codes are 5 characters from
`34679ACDEFGHJKMNPQRTUVWXY` - nothing that reads like something else - in any case.

### Phone → room

Every message is checked by `parseClientMessage` before anything else: text, at most 512 KB,
JSON, a known `t`, exactly the listed fields with the right types. Each may carry `rid` (up to 16
characters), echoed on any `error` it causes.

| `t` | Fields | Who |
|---|---|---|
| `hello` | `v`, `name`, `token?` | first, on every connection; `token` comes back as the same person. The first person in a room is its host. |
| `update` | `base`, `game`, `colors?` | the host - the first update puts the game up - and anyone the host lets record |
| `setRecorder` | `person` (an id from `people`), `allow` | the host |
| `stop` | | the host: stop sharing; the game stays, read-only |
| `ping` | | answered with `pong` |

`update` sends the whole game as it now stands, the way the Scores tab saves it. The room
checks it in full (`checkGame`: every field and bound, four different names, and that the ledger
can replay it), refuses a different game than the one being shared, and takes it only if `base`
is the room's current `gameVersion` - otherwise someone else's change landed first, and the
answer is `conflict`. Fields it doesn't know (from an older app version's saved game) are
dropped, not refused. `colors` (player → colour) is only taken from the host.

### Room → phone

| `t` | Fields |
|---|---|
| `welcome` | `v`, `token`, `id`, `name`, `host` - keep `token` to come back as the same person |
| `room` | `room`: the whole public room (below), after every change |
| `error` | `code`, `message`, `rid?` |
| `pong` | `rid?` |

`room` carries `code`, `version` (one higher each send - drop anything older), `phase`
(`waiting` for the game / `live` / `ended`), `people` (each `{id, name, connected, host,
canRecord}`), `game` (the `ScoreGame`, or null), `gameVersion` (one higher each accepted
update), `colors`, and the audit trail: `authors` (for each entry in the game, who put it in and
who last changed it) and `changes` (the latest 50 changes, newest last).

### The audit trail

Each accepted `update` is logged with who sent it (`shared/protocol/audit.ts`). The room
compares the new game with the one before (`diffGames`): entries added, removed or replaced, and
where - so an undo, a redo, deleting or fixing an older hand all come out as what they are; the
first update is the host sharing the game. The whole log is kept in the room's storage;
`entryAuthors` replays it to say who entered each entry now in the game.

Error codes: `badMessage`, `tooLarge`, `rateLimited`, `version`, `notJoined`, `badToken`,
`nameTaken`, `notHost`, `notAllowed`, `conflict`, `badGame`, `ended`, `noSuchPerson`.

### Keeping in step

`GameSync` (`src/lib/online.ts`) keeps a phone's copy of the game in step with the room's. It
sends the copy when it differs from the last game the room confirmed - one update at a time, each
made on that confirmed `gameVersion` - and adopts every change made elsewhere. When a change here
and one elsewhere collide, the room's wins and the phone says the change wasn't saved, to be
entered again: two people's entries are never merged behind their backs. After a reconnect, a
copy changed offline goes up if nothing changed in the room meanwhile (it's the newer); otherwise
the room's is taken. Games are compared as the server keeps them (`gameKey`: through the same
schema, keys sorted), so a game from an older app version doesn't bounce back and forth.

### Reconnecting

The room keeps each person's reconnect token as a SHA-256 hash. The app keeps the token itself
in `localStorage` (`mjwaits.online`, per room, for a week) - the host's phone also notes which
game it's sharing where - sends it with `hello` after any drop or reload, and is the same person
again (the host stays host). It retries with growing waits (½ s up to 8 s) and at once when the
page comes back to the front or the network returns. When a connection fails before it opens,
the app asks `GET /rooms/<CODE>`: a `404` means the game has closed, so it stops and says so
instead of retrying.
