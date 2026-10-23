// A small, dependency-free schema checker for the multiplayer messages.
//
// Each schema both checks an unknown value and carries its TypeScript type
// (Infer<typeof S>), so a message is described once and the type and the
// server's validation can't drift apart. Objects are strict by default: an
// unexpected key is an error, so a client can't smuggle extra fields past the
// server. A game record from a phone is read with `strip` instead - older app
// versions saved fields that have since gone, and those are dropped, not refused.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Schema<T> {
  check(value: unknown, path: string): Result<T>;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (path: string, what: string): Result<never> => ({ ok: false, error: `${path || "message"}: ${what}` });

export function literal<const L extends string | number | boolean>(lit: L): Schema<L> {
  return { check: (v, path) => (v === lit ? ok(lit) : fail(path, `expected ${JSON.stringify(lit)}`)) };
}

export function oneOf<const L extends string>(...options: L[]): Schema<L> {
  return {
    check: (v, path) => (typeof v === "string" && (options as string[]).includes(v) ? ok(v as L) : fail(path, `expected one of ${options.join(", ")}`)),
  };
}

export function int(min: number, max: number): Schema<number> {
  return {
    check: (v, path) =>
      typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? ok(v) : fail(path, `expected a whole number ${min}-${max}`),
  };
}

// Any finite number in range, fractions included (half a 拉 when 整數模式 is off).
export function num(min: number, max: number): Schema<number> {
  return {
    check: (v, path) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? ok(v) : fail(path, `expected a number ${min}-${max}`)),
  };
}

export const bool: Schema<boolean> = {
  check: (v, path) => (typeof v === "boolean" ? ok(v) : fail(path, "expected true or false")),
};

// A string of at most `max` UTF-16 units, optionally matching `pattern`.
// Content rules beyond that (nicknames) are applied after validation.
export function str(max: number, pattern?: RegExp): Schema<string> {
  return {
    check: (v, path) => {
      if (typeof v !== "string") return fail(path, "expected text");
      if (v.length > max) return fail(path, `longer than ${max}`);
      if (pattern && !pattern.test(v)) return fail(path, "not in the expected form");
      return ok(v);
    },
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return { check: (v, path) => (v === null ? ok(null) : inner.check(v, path)) };
}

export function array<T>(item: Schema<T>, min: number, max: number): Schema<T[]> {
  return {
    check: (v, path) => {
      if (!Array.isArray(v)) return fail(path, "expected a list");
      if (v.length < min || v.length > max) return fail(path, `expected ${min}-${max} items`);
      const out: T[] = [];
      for (let i = 0; i < v.length; i++) {
        const r = item.check(v[i], `${path}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    },
  };
}

// Marks an object field as optional: it may be left out (but not sent as
// undefined/null unless the inner schema allows null).
export interface Optional<T> {
  optional: Schema<T>;
}
export const optional = <T>(inner: Schema<T>): Optional<T> => ({ optional: inner });

type Shape = Record<string, Schema<unknown> | Optional<unknown>>;
type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K] extends Optional<unknown> ? never : K }[keyof S];
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends Optional<unknown> ? K : never }[keyof S];
type FieldType<F> = F extends Optional<infer T> ? T : F extends Schema<infer T> ? T : never;
type Flatten<T> = { [K in keyof T]: T[K] };
export type ObjectOf<S extends Shape> = Flatten<{ [K in RequiredKeys<S>]: FieldType<S[K]> } & { [K in OptionalKeys<S>]?: FieldType<S[K]> }>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function object<S extends Shape>(shape: S, opts: { strip?: boolean } = {}): Schema<ObjectOf<S>> & { shape: S } {
  return {
    shape,
    check: (v, path) => {
      if (!isPlainObject(v)) return fail(path, "expected an object");
      if (!opts.strip) for (const key of Object.keys(v)) if (!Object.hasOwn(shape, key)) return fail(path, `unexpected field "${key}"`);
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        const at = path ? `${path}.${key}` : key;
        if ("optional" in field) {
          if (!Object.hasOwn(v, key)) continue;
          const r = field.optional.check(v[key], at);
          if (!r.ok) return r;
          out[key] = r.value;
        } else {
          if (!Object.hasOwn(v, key)) return fail(at, "missing");
          const r = field.check(v[key], at);
          if (!r.ok) return r;
          out[key] = r.value;
        }
      }
      return ok(out as ObjectOf<S>);
    },
  };
}

// A map from text keys to one kind of value, e.g. player name -> colour.
export function record<T>(key: Schema<string>, value: Schema<T>, maxKeys: number): Schema<Record<string, T>> {
  return {
    check: (v, path) => {
      if (!isPlainObject(v)) return fail(path, "expected an object");
      const entries = Object.entries(v);
      if (entries.length > maxKeys) return fail(path, `more than ${maxKeys} entries`);
      const out: [string, T][] = [];
      for (const [k, x] of entries) {
        const kr = key.check(k, `${path}[key]`);
        if (!kr.ok) return kr;
        const vr = value.check(x, `${path}.${k}`);
        if (!vr.ok) return vr;
        out.push([k, vr.value]);
      }
      // fromEntries defines each key as its own property - a key like
      // "__proto__" stays data, never a prototype.
      return ok(Object.fromEntries(out));
    },
  };
}

// A union of object schemas told apart by one field - `t` for messages,
// `kind` for moves - so an error names the one problem with the shape the
// client meant rather than every alternative's.
export function tagged<M extends Record<string, Schema<object>>>(byTag: M, key = "t"): Schema<Infer<M[keyof M]>> {
  return {
    check: (v, path) => {
      if (!isPlainObject(v)) return fail(path, "expected an object");
      const tag = v[key];
      const at = path ? `${path}.${key}` : key;
      if (typeof tag !== "string" || !Object.hasOwn(byTag, tag)) return fail(at, key === "t" ? "unknown message type" : `unknown ${key}`);
      return byTag[tag].check(v, path) as Result<Infer<M[keyof M]>>;
    },
  };
}
