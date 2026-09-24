/**
 * MotherDuck in the browser with broker-minted read-scaling tokens.
 *
 * A MotherDuck read-scaling token is a **session credential** in this kit's
 * taxonomy (minutes to a year, reusable, revocable), so the browser side is
 * the plain `CredentialManager` typed to the MotherDuck envelope — the first
 * species, like AWS STS — plus an **engine holder** over
 * `@motherduck/wasm-client`, because the token is consumed by a DuckDB
 * instance rather than by a fetch.
 *
 * Two measured facts (2026-09-24, wasm-client 1.5.5-r.1, headless Chrome,
 * a read-scaling token of a service account) shape the holder:
 *
 * 1. **The token is consumed at connect, once.** The client configures the
 *    extension with `SET motherduck_token` during initialization, and after
 *    that the setting is sealed: `SET motherduck_token` answers
 *    "can only be set during initialization", `DETACH` of the workspace is
 *    refused for read-only credentials, and `ATTACH 'md:'` says the
 *    databases are already attached. There is no in-place swap.
 * 2. **A live session outlives its token.** Revoking the token the session
 *    was created with did not stop remote queries, hybrid joins, or the
 *    tab's local tables — the extension holds a session, not the token.
 *
 * So rotation is NOT a per-refresh event here: the manager keeps a fresh
 * token at hand, and the engine is rebuilt (terminate + create, which
 * DROPS the tab's local tables) only when the app decides to — an explicit
 * {@link MotherDuckEngine.rebuild}, or on demand when a remote query
 * reports a dead session (see {@link isMotherDuckAuthError}). Eager
 * rebuild-on-rotation is available as an option for apps with no local
 * state to lose.
 *
 * `accessMode: "read_only"` is refused up front: it governs the tab's own
 * in-memory DuckDB (which cannot open read-only) — the read-scaling token is
 * what makes the cloud side read-only.
 *
 * @packageDocumentation
 */

import {
  type BrokerRouteOptions,
  CredentialManager,
  type CredentialTarget,
  credentialsUrl,
  type EphemeralCredential,
} from "@habemus-papadum/cf-browser-credentials";
import type { AsyncDuckDB, MDConnection, MDConnectionParams } from "@motherduck/wasm-client";

/** A stock duckdb-wasm connection on the engine (the client's vendored type, derived). */
export type MotherDuckConnection = Awaited<ReturnType<AsyncDuckDB["connect"]>>;

/** The envelope the broker's motherduck route returns. */
export interface MotherDuckCredentials extends EphemeralCredential {
  /** A MotherDuck access token, normally `read_scaling`. */
  token: string;
  /**
   * The lane's account the token was minted for, when the route says so.
   * Informational — a page never needs it; it names the compute tier's owner.
   */
  serviceAccount?: string;
}

/** The conventional broker route for MotherDuck tokens. */
export const MOTHERDUCK_CREDENTIALS_PATH = "/api/credentials/motherduck";

/**
 * The endpoint URL at a well-known credentials service for a site's key,
 * e.g. `motherDuckCredentialsUrl("https://creds.example.com", { key: "notes" })`.
 */
export function motherDuckCredentialsUrl(base: string, target: CredentialTarget = {}): string {
  return credentialsUrl(MOTHERDUCK_CREDENTIALS_PATH, { base, ...target });
}

export interface MotherDuckCredentialManagerOptions extends BrokerRouteOptions {
  /** Full endpoint URL; overrides `base`/`key`. Defaults to {@link MOTHERDUCK_CREDENTIALS_PATH}, same-origin. */
  url?: string;
  /** Refresh this long before expiration (the kit default, 10 minutes). */
  refreshMarginMs?: number;
  /** See `CredentialFetchOptions` in cf-browser-credentials. */
  bounce?: boolean;
  loginUrl?: string;
}

/**
 * A manager typed to the MotherDuck envelope, defaulting to the conventional
 * route. It keeps a fresh token at hand for the next (re)connect; it does
 * not, by itself, touch any DuckDB instance.
 */
export function createMotherDuckCredentialManager(
  options: MotherDuckCredentialManagerOptions = {},
): CredentialManager<MotherDuckCredentials> {
  return new CredentialManager<MotherDuckCredentials>({
    url: credentialsUrl(MOTHERDUCK_CREDENTIALS_PATH, options),
    refreshMarginMs: options.refreshMarginMs,
    bounce: options.bounce,
    loginUrl: options.loginUrl,
  });
}

/**
 * What the engine needs from a credential source: a current token, and
 * optionally a rotation feed. A `CredentialManager<MotherDuckCredentials>`
 * satisfies it structurally; {@link staticMotherDuckToken} is the dev/paste
 * shape.
 */
export interface TokenSource {
  get(): Promise<MotherDuckCredentials>;
  onRotate?(fn: (creds: MotherDuckCredentials) => void): () => void;
}

/** A fixed token (a pasted one, or a dev key injected by the build). */
export function staticMotherDuckToken(token: string, expiration?: string): TokenSource {
  const creds: MotherDuckCredentials = {
    token,
    expiration: expiration ?? new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
  };
  return { get: async () => creds };
}

/** Everything the client takes except the token, which the source supplies. */
export type MotherDuckEngineParams = Omit<MDConnectionParams, "mdToken">;

/**
 * The slice of `@motherduck/wasm-client` the engine drives. Injectable for
 * tests; the default is a lazy `import("@motherduck/wasm-client")`, so this
 * package loads without the client until an engine is actually built.
 */
export interface MotherDuckClient {
  MDConnection: { create(params: MDConnectionParams): MDConnection };
  getAsyncDuckDb(params: MDConnectionParams): Promise<AsyncDuckDB>;
  terminateDuckDB(): Promise<void>;
}

/** A live engine generation: the client's singleton DuckDB and its connection. */
export interface MotherDuckEngineHandle {
  /** The stock duckdb-wasm instance — what Mosaic's `wasmConnector({ duckdb, connection })` takes. */
  db: AsyncDuckDB;
  /** The client's own connection (its sequenced query API). */
  connection: MDConnection;
  /** A dedicated stock connection on the same engine (one for Mosaic, one for agent reads, …). */
  connect(): Promise<MotherDuckConnection>;
  /** Increments on every rebuild; a consumer holding a handle can tell it is stale. */
  generation: number;
}

export interface MotherDuckEngineOptions {
  client?: MotherDuckClient | Promise<MotherDuckClient>;
  /**
   * Rebuild eagerly whenever the source rotates. Default `false`: a live
   * session outlives its token (measured), and a rebuild drops the tab's
   * local tables. Turn it on only for an app with nothing local to lose.
   */
  rebuildOnRotate?: boolean;
}

export type RebuildListener = (handle: MotherDuckEngineHandle, reason: string) => void;

export interface MotherDuckEngine {
  /** The current generation, building the first one on demand (deduplicated). */
  ready(): Promise<MotherDuckEngineHandle>;
  /**
   * Terminate the instance and create a new one with the source's CURRENT
   * token. Local tables are gone afterwards; `onRebuild` listeners fire with
   * the new handle so the app can re-wire Mosaic and re-materialize.
   */
  rebuild(reason?: string): Promise<MotherDuckEngineHandle>;
  onRebuild(fn: RebuildListener): () => void;
  /** The generation count so far (0 before the first `ready()`). */
  readonly generation: number;
  /** Terminate and stop listening to the source. */
  close(): Promise<void>;
}

const READ_ONLY_REFUSED =
  'accessMode: "read_only" applies to the tab\'s own in-memory DuckDB and fails there — ' +
  "the read-scaling token is what makes the cloud side read-only; drop the option";

/**
 * Build an engine over the client from a token source. Nothing happens
 * until `ready()`; the source is consulted at every (re)build.
 */
export function motherDuckEngine(
  source: TokenSource,
  params: MotherDuckEngineParams = {},
  options: MotherDuckEngineOptions = {},
): MotherDuckEngine {
  if (params.accessMode === "read_only") throw new Error(READ_ONLY_REFUSED);

  const clientPromise = Promise.resolve(options.client ?? loadClient());
  const listeners = new Set<RebuildListener>();
  let generation = 0;
  let current: Promise<MotherDuckEngineHandle> | undefined;
  let building: Promise<MotherDuckEngineHandle> | undefined;
  let unsubscribe: (() => void) | undefined;

  async function build(): Promise<MotherDuckEngineHandle> {
    const [client, creds] = await Promise.all([clientPromise, source.get()]);
    const full: MDConnectionParams = { ...params, mdToken: creds.token };
    const connection = client.MDConnection.create(full);
    const db = await client.getAsyncDuckDb(full);
    generation += 1;
    return {
      db,
      connection,
      connect: () => db.connect(),
      generation,
    };
  }

  async function rebuild(reason = "manual"): Promise<MotherDuckEngineHandle> {
    if (building) return building;
    building = (async () => {
      const client = await clientPromise;
      if (current !== undefined) {
        await current.then(() => client.terminateDuckDB()).catch(() => client.terminateDuckDB());
      }
      const next = build();
      current = next;
      const handle = await next;
      for (const fn of listeners) fn(handle, reason);
      return handle;
    })().finally(() => {
      building = undefined;
    });
    return building;
  }

  if (options.rebuildOnRotate && source.onRotate) {
    unsubscribe = source.onRotate(() => {
      if (current === undefined) return; // nothing built yet: the next ready() takes the new token
      rebuild("rotate").catch((err) => console.error("motherduck engine rebuild failed", err));
    });
  }

  return {
    ready() {
      current ??= build();
      return current;
    },
    rebuild,
    onRebuild(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get generation() {
      return generation;
    },
    async close() {
      unsubscribe?.();
      listeners.clear();
      if (current === undefined) return;
      const client = await clientPromise;
      current = undefined;
      await client.terminateDuckDB();
    },
  };
}

async function loadClient(): Promise<MotherDuckClient> {
  const mod = await import("@motherduck/wasm-client");
  return {
    MDConnection: mod.MDConnection,
    getAsyncDuckDb: mod.getAsyncDuckDb,
    terminateDuckDB: mod.terminateDuckDB,
  };
}

/**
 * True for the errors a MotherDuck session raises once it can no longer
 * authenticate — the signal to `rebuild()` with a fresh token. The patterns
 * are the ones seen from the wasm client; a plain catalog or binder error
 * is not one of them.
 */
export function isMotherDuckAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /PERMISSION_DENIED|UNAUTHENTICATED|token (is )?(expired|invalid|revoked)|invalid.*token|authentication/i.test(
    message,
  );
}
