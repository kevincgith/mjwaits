// The walkie-talkie's sound on the wire: IMA ADPCM, four bits a sample. Plain
// arithmetic rather than a browser's own recorder, so every phone makes and
// reads exactly the same bytes (iPhones and Android record different formats,
// and a recorder's pieces can't be played until the recording ends).
//
// A frame is a 3-byte header - the predictor (int16, little-endian) and the
// step index it starts from - then two samples to the byte. Each frame stands
// alone, so one that's lost costs its own 100 ms and nothing after it.

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724,
  796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350,
  22385, 24623, 27086, 29794, 32767,
];
const INDEX_CHANGE = [-1, -1, -1, -1, 2, 4, 6, 8];
const HEADER = 3;

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

// Where the coder has got to: carried from frame to frame while encoding.
export interface AdpcmState {
  predictor: number;
  index: number;
}
export const newAdpcmState = (): AdpcmState => ({ predictor: 0, index: 0 });

// One nibble's effect on the state (the same on both sides).
function step(state: AdpcmState, nibble: number) {
  const size = STEPS[state.index];
  let diff = size >> 3;
  if (nibble & 4) diff += size;
  if (nibble & 2) diff += size >> 1;
  if (nibble & 1) diff += size >> 2;
  state.predictor = clamp(nibble & 8 ? state.predictor - diff : state.predictor + diff, -32768, 32767);
  state.index = clamp(state.index + INDEX_CHANGE[nibble & 7], 0, STEPS.length - 1);
}

export function encodeAdpcm(samples: Int16Array, state: AdpcmState): Uint8Array {
  const out = new Uint8Array(HEADER + Math.ceil(samples.length / 2));
  new DataView(out.buffer).setInt16(0, state.predictor, true);
  out[2] = state.index;
  for (let i = 0; i < samples.length; i++) {
    const size = STEPS[state.index];
    let delta = samples[i] - state.predictor;
    let nibble = 0;
    if (delta < 0) {
      nibble = 8;
      delta = -delta;
    }
    if (delta >= size) {
      nibble |= 4;
      delta -= size;
    }
    if (delta >= size >> 1) {
      nibble |= 2;
      delta -= size >> 1;
    }
    if (delta >= size >> 2) nibble |= 1;
    step(state, nibble);
    out[HEADER + (i >> 1)] |= i & 1 ? nibble << 4 : nibble;
  }
  return out;
}

// Whatever comes off the wire decodes to something: a bad frame is noise for
// 100 ms, not an error.
export function decodeAdpcm(frame: Uint8Array): Int16Array {
  if (frame.length <= HEADER) return new Int16Array(0);
  const state: AdpcmState = {
    predictor: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getInt16(0, true),
    index: clamp(frame[2], 0, STEPS.length - 1),
  };
  const out = new Int16Array((frame.length - HEADER) * 2);
  for (let i = 0; i < out.length; i++) {
    const byte = frame[HEADER + (i >> 1)];
    step(state, i & 1 ? byte >> 4 : byte & 15);
    out[i] = state.predictor;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
