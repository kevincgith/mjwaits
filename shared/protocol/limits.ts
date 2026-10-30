// The fixed rules of the multiplayer connection: protocol version, sizes,
// rates, room codes and nicknames. Both ends import these, so the web app
// can refuse what the server would refuse before sending it.

// Bumped whenever a message changes shape. The server answers a `hello` with
// a different version with an error asking the page to reload.
export const PROTOCOL_VERSION = 3; // 2: the room shares a whole Scores-tab game; 3: tables play 換牌 and 獎池

export const SEATS = 4;

// Largest message either side accepts, in UTF-8 bytes. An update carries the
// whole game: a long evening is tens of kilobytes; a game at the entry caps
// (game.ts MAX_EVENTS, MAX_UNDONE) of the Play table's wins, about 500 bytes
// each with their patterns, some 900. (Cloudflare's own WebSocket limit is
// 1 MiB: the rest is room for what goes around it.)
export const MAX_MESSAGE_BYTES = 960 * 1024;

// Per connection: a burst of RATE_BURST messages, refilled at RATE_PER_SECOND
// (a token bucket - the Worker enforces it).
export const RATE_BURST = 20;
export const RATE_PER_SECOND = 5;

// Room codes: 5 characters from an alphabet with nothing that reads like
// something else (no 0/O, 1/I/L, 5/S, 2/Z, 8/B) - 25^5, about 9.8 million
// codes. Typed in any case; the canonical form is upper case.
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_ALPHABET = "34679ACDEFGHJKMNPQRTUVWXY";
export const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

// Reconnect tokens: 32 hex characters (128 random bits), made by the server.
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// Nicknames: up to 12 characters (counted as the reader sees them, so 陳大文
// is 3), trimmed, inner runs of spaces collapsed, and with no control or
// invisible formatting characters and none of < > & " ' ` - nothing that
// could be read as markup wherever a name ends up.
export const NICKNAME_MAX = 12;
// The raw string a client may send before cleaning (room for spaces and
// characters that get stripped).
export const NICKNAME_RAW_MAX = 64;

const graphemes = (s: string): string[] => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);

// The cleaned nickname, or null if nothing usable is left.
export function cleanNickname(raw: string): string | null {
  const cleaned = raw
    .normalize("NFC")
    // Controls, format characters (zero-width, bidi overrides - but not the
    // zero-width joiner, which builds emoji like 👨‍👩‍👧), separators other
    // than the plain space, and private-use / unassigned code points.
    .replace(/(?!\u200d)[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[<>&"'`]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  const chars = graphemes(cleaned);
  return chars.length > NICKNAME_MAX ? chars.slice(0, NICKNAME_MAX).join("").trimEnd() : cleaned;
}
