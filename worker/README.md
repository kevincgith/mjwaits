# MJWaits multiplayer server

The server behind the Scores tab's **線上 Online** table: a Cloudflare Worker with one Durable
Object per table, each keeping its table in its own SQLite storage. Every phone at the table
holds a WebSocket to it, so an entry made on one phone shows on all of them at once.

It runs on the Workers **free plan**: SQLite-backed Durable Objects, and the WebSocket
Hibernation API so a quiet table costs nothing while it waits.

```
shared/                @mjwaits/shared - imported by the web app and this Worker alike
  engine/              the rules engine: tiles, tai scoring, the hand engine, score keeping (ledger.ts)
  protocol/            the messages (client.ts, server.ts), limits.ts, and their validation
worker/                this Worker
  src/index.ts         routes: make a room, look one up, open its WebSocket; the Origin check
  src/room.ts          Room, the Durable Object: players, seats, the scoreboard, undo, expiry
  test/                tests run inside the Workers runtime against the real Durable Object
src/lib/online.ts      the web app's connection: rooms over HTTP, the live socket, reconnecting
src/scores/online.tsx  the 線上 panel
```

The scores are the shared ledger's (`shared/engine/ledger.ts`), the same code as the Scores
tab: the room stores each hand as a Scores-tab entry and replays them for the board, so 拉/踢,
反雪, 連莊 and the round come out exactly as on 戰況.

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
real `Room` Durable Object and its SQLite storage, with real WebSockets: joining, seats,
reconnecting, the Origin check and limits, expiry, payouts checked against the ledger, undo with
approval, the summary, and a room evicted from memory mid-game carrying on. The protocol's
validation is tested in `shared/protocol/protocol.test.ts`; the app's connection in
`src/lib/online.test.ts`.

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
3. **Deploy:**

   ```bash
   npm run deploy --workspace worker
   ```

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
  small fraction of one (Cloudflare bills WebSocket messages at 20:1). A table of four is a few
  hundred messages an evening.
- **Duration.** A room is only billed while awake. With the Hibernation API it sleeps between
  messages, open sockets and all.
- **Storage.** A room is a few kilobytes. Rows written: one per entry plus a couple of
  bookkeeping rows per change.
- **CPU.** Each message is replaying the ledger (microseconds) - the costly part, tai scoring,
  isn't done on the server in phase 1.

### Limits and clean-up

All in `room.ts` and `shared/protocol/limits.ts`:

| What | Limit |
|---|---|
| Message size | 8 KB |
| Messages per connection | bursts of 20, then 5 a second; closed after 10 refusals in a row |
| Connections per room | 16 |
| Nicknames per room | 12; up to 12 characters, no markup or invisible characters, unique ignoring case and width |
| A room no one joined | removed after 1 hour |
| Any other room | removed 2 days after its last change, never while anyone is connected |

Clean-up is one Durable Object alarm per room, set when it's made and moved only when it fires.

## Protocol

JSON over the WebSocket at `wss://mj-api.kevinlhc.com/rooms/<CODE>/ws`. Everything is defined
once in `shared/protocol/`: `client.ts` (what a phone sends, with the schema the server checks),
`server.ts` (what the room sends), `limits.ts`. Bump `PROTOCOL_VERSION` when a message changes
shape; a page speaking another version is told to reload.

### HTTP

| Request | Answer |
|---|---|
| `POST /rooms` | `201 {"code":"3AC9X"}` - a new room |
| `GET /rooms/<CODE>` | `200 {"code","phase","seated"}`, or `404` |
| `GET /rooms/<CODE>/ws` | the WebSocket (`Upgrade: websocket`); `404` for no such room, `503` when it's full |
| `GET /health` | `ok` |

The room routes need an allowed `Origin` (else `403`). Codes are 5 characters from
`34679ACDEFGHJKMNPQRTUVWXY` - nothing that reads like something else - in any case.

### Phone → room

Every message is checked by `parseClientMessage` before anything else: text, at most 8 KB,
JSON, a known `t`, exactly the listed fields with the right types, and the rules between fields.
Each may carry `rid` (up to 16 characters), echoed on any `error` it causes.

| `t` | Fields | Who, when |
|---|---|---|
| `hello` | `v`, `name`, `token?` | first, on every connection; `token` takes back a seat |
| `sit` | `seat` (0-3) | anyone joined, in the lobby |
| `stand` | | in the lobby |
| `setup` | `settings` | the host, in the lobby |
| `start` | | the host, with four seated |
| `win` | `winners: [{seat, tai}]` (1-3), `from` (seat, or null for 自摸), `jackpot?` | a seated player, during the game |
| `draw` | | 流局 - a seated player |
| `bonus` | `seat`, `kind` (獎 / 罰), `amount`, `other?` | 特別獎罰 - a seated player |
| `undo` | | ask to take back the last entry - a seated player |
| `undoVote` | `approve` | another seated player answers; the asker can withdraw (`false`) |
| `end` | | the host: the session is over |
| `ping` | | answered with `pong` |

`settings`: `startChips`, `base` (底), `dealerTai` (莊), `streakTai` (連莊), `multiWin`
(`"first"` 截胡 / `"all"` 一炮多響), `hostCanUndo`, `firstDealer`.

Rules a shape can't say: a 自摸 has one winner; the discarder isn't a winner; no seat twice; two
or three winners only at a `multiWin: "all"` table; only a single winner takes the Jackpot. While
an undo waits for an answer, nothing new is recorded.

### Room → phone

| `t` | Fields |
|---|---|
| `welcome` | `v`, `token`, `name`, `host`, `seat` - keep `token` to come back to this seat |
| `room` | `room`: the whole public room (below), after every change |
| `error` | `code`, `message`, `rid?` |
| `pong` | `rid?` |

`room` carries `code`, `version` (one higher each change - drop anything older), `phase`
(`lobby` / `playing` / `ended`), `seats` (each `{name, connected, host}` or null), `watching`,
`settings`, `game` (the Scores tab's own game record: seats as nicknames, and every entry),
`board` (`chips`, `net`, `dealer`, `streak`, `roundWind`, `label`, `hands`, `lahs`, `pot`),
`pendingUndo` (`{by, entry}` or null) and, once ended, `summary` (`hands`, `net`, `chips`,
`settle` - the fewest payments, in seats - `pot` left in the Jackpot, `endedAt`).

Error codes: `badMessage`, `tooLarge`, `rateLimited`, `version`, `notJoined`, `badToken`,
`nameTaken`, `seatTaken`, `notSeated`, `notHost`, `started`, `notStarted`, `ended`,
`seatsNotFull`, `multiWinOff`, `undoPending`, `nothingToUndo`, `noUndoPending`, `ownUndo`.

### Reconnecting

The room keeps each player's reconnect token as a SHA-256 hash. The app keeps the token itself
in `localStorage` (`mjwaits.online`, per room, for a week), sends it with `hello` after any drop
or reload, and gets the same seat back. It retries with growing waits (½ s up to 8 s) and at once
when the page comes back to the front or the network returns. When a connection fails before it
opens, the app asks `GET /rooms/<CODE>`: a `404` means the table has expired, so it stops and says
so instead of retrying. (A room that answers `badToken` - it doesn't know this player - is joined
afresh.)
