/**
 * Browser-side credential manager for static sites whose ephemeral
 * credentials are minted by a broker endpoint (typically a Cloudflare Worker
 * behind Cloudflare Access) — either same-origin routes
 * (`/api/credentials/aws`, `/api/credentials/elevenlabs`, …) or a well-known
 * cross-origin credentials service (e.g. `https://creds.example.com`).
 *
 * The manager is generic over the credential payload: each provider returns
 * its own envelope, and the only field the manager itself needs is
 * `expiration`, to refresh ahead of it. Everything else — in-memory caching,
 * margin-based refresh, deduplication of concurrent fetches, rotation
 * listeners — is provider-agnostic. Provider-specific envelope types and
 * consumption helpers live in sibling packages (`cf-creds-aws`, …).
 *
 * A page addresses the broker by **key**: it sends its own name (`?key=`)
 * and nothing else, and the route answers with the whole bundle needed to
 * consume the credential. {@link credentialsUrl} builds those URLs; the
 * provider packages wrap it with their own route path.
 *
 * Cross-origin endpoints add one wrinkle: Access cookies are per-hostname,
 * so the first fetch of a session can fail (Access 302s the request into an
 * IdP flow that a background fetch cannot complete — it surfaces as a CORS
 * error). {@link fetchCredentials} handles this with a **login bounce**: it
 * opens the endpoint in a popup once (a top-level navigation completes the
 * SSO dance and sets the cookie), polls until the fetch succeeds, and closes
 * the popup. The bounce is enabled automatically for cross-origin URLs.
 *
 * @packageDocumentation
 */

/** The one contract every provider envelope must honour. */
export interface EphemeralCredential {
  /** ISO-8601 expiration timestamp; the manager refreshes ahead of it. */
  expiration: string;
}

/**
 * How a page names what it wants from the broker — **the key contract**: a
 * site sends only its own key and the ambient Access identity, and the
 * broker answers with everything needed to consume the credential. Internal
 * names (role ARNs, service accounts, provider ids, regions, audiences)
 * never reach site code, so re-pointing a site is a broker-side edit.
 */
export interface CredentialTarget {
  /**
   * The site's own name at the credentials service (its `?key=` parameter).
   * Requires `base` — a key is meaningless against a same-origin route.
   */
  key?: string;
  /**
   * @deprecated The legacy `?role=` lane, which named an internal role from
   * site code. Name the site itself with {@link CredentialTarget.key}.
   */
  role?: string;
}

/** Where a provider route lives, and which target to ask it for. */
export interface BrokerRouteOptions extends CredentialTarget {
  /** Full endpoint URL; overrides `base` and the target. */
  url?: string;
  /** Origin of a well-known credentials service, e.g. `https://creds.example.com`. */
  base?: string;
}

/**
 * Resolve a provider route (`/api/credentials/<species>`) to an endpoint
 * URL: an explicit `url` wins, otherwise `base` + `path` carrying the
 * target, otherwise the same-origin `path`.
 */
export function credentialsUrl(path: string, options: BrokerRouteOptions = {}): string {
  const { url, base, key, role } = options;
  if (key && role) {
    throw new Error(
      "key and role are mutually exclusive — key is the contract, role the legacy lane",
    );
  }
  if ((key || role) && !base) {
    throw new Error(
      `${key ? "key" : "role"} requires base — the well-known credentials service origin`,
    );
  }
  if (url) return url;
  if (!base) return path;
  const resolved = new URL(path, base);
  if (key) resolved.searchParams.set("key", key);
  else if (role) resolved.searchParams.set("role", role);
  return resolved.toString();
}

/** How {@link fetchCredentials} reacts to an auth-shaped failure. */
export interface CredentialFetchOptions {
  /**
   * Open a login window on first auth failure, then retry. Defaults to
   * enabled when the URL is absolute and cross-origin, disabled otherwise.
   */
  bounce?: boolean;
  /**
   * Where the login window navigates. Defaults to the fetch URL itself —
   * any Access-gated path works; a dedicated `/api/login` page that closes
   * itself is friendlier when the service offers one.
   */
  loginUrl?: string;
}

/**
 * Thrown when a login bounce was needed but the popup was blocked. Catch it
 * and call `window.open(err.loginUrl)` from a user gesture, then retry.
 */
export class AccessLoginRequired extends Error {
  readonly loginUrl: string;

  constructor(loginUrl: string, cause: string) {
    super(
      `Access login required and the popup was blocked — open ${loginUrl} from a user gesture, then retry (${cause})`,
    );
    this.name = "AccessLoginRequired";
    this.loginUrl = loginUrl;
  }
}

function crossOrigin(url: string): boolean {
  if (typeof location === "undefined") return false;
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const BOUNCE_POLL_MS = 1500;
const BOUNCE_POLL_TRIES = 40;

/**
 * Fetch a credential endpoint with `credentials: "include"`, running the
 * login bounce on auth-shaped failures when enabled (see
 * {@link CredentialFetchOptions}). Resolves only with an ok response.
 */
export async function fetchCredentials(
  url: string,
  options: CredentialFetchOptions = {},
): Promise<Response> {
  const bounce = options.bounce ?? crossOrigin(url);

  // Two failure shapes mean "not logged in at the credential host": a
  // network/CORS error (Access 302ed the fetch into the IdP flow) and an
  // explicit 401/403. Anything else is a real error and propagates as-is.
  let authFailure: string;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (res.ok) return res;
    const body = await res.text();
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`credential fetch failed (${res.status}): ${body}`);
    }
    authFailure = `${res.status}: ${body}`;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("credential fetch failed")) throw err;
    authFailure = String(err);
  }

  if (!bounce) {
    throw new Error(
      `credential fetch failed: ${authFailure} — open ${url} in a tab, log in, and retry`,
    );
  }

  const loginUrl = options.loginUrl ?? url;
  const popup =
    typeof window === "undefined"
      ? null
      : window.open(loginUrl, "_blank", "popup,width=520,height=640");
  if (!popup) throw new AccessLoginRequired(loginUrl, authFailure);

  try {
    for (let attempt = 0; attempt < BOUNCE_POLL_TRIES; attempt += 1) {
      await sleep(BOUNCE_POLL_MS);
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok) return res;
      } catch {
        // Still logging in; keep polling.
      }
    }
  } finally {
    try {
      popup.close();
    } catch {
      // A cross-origin popup handle can still refuse; nothing to do.
    }
  }
  throw new Error(`credential fetch failed after login bounce (${authFailure}): ${url}`);
}

export interface CredentialManagerOptions extends CredentialFetchOptions {
  /**
   * Endpoint to fetch this credential from — same-origin relative, or the
   * absolute URL of a well-known credentials service / deployed broker.
   */
  url: string;
  /** Refresh this long before expiration. */
  refreshMarginMs?: number;
}

type Listener<C> = (creds: C) => void;

export class CredentialManager<C extends EphemeralCredential = EphemeralCredential> {
  #url: string;
  #margin: number;
  #fetchOptions: CredentialFetchOptions;
  #creds: C | null = null;
  #inflight: Promise<C> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<Listener<C>>();

  constructor(options: CredentialManagerOptions) {
    this.#url = options.url;
    this.#margin = options.refreshMarginMs ?? 10 * 60 * 1000;
    this.#fetchOptions = { bounce: options.bounce, loginUrl: options.loginUrl };
  }

  /** Current credentials, fetching/refreshing if absent or near expiry. */
  async get(): Promise<C> {
    if (this.#creds && !this.#expiringSoon()) return this.#creds;
    return this.refresh();
  }

  /** Subscribe to rotations; returns an unsubscribe function. */
  onRotate(fn: Listener<C>): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Force a fetch now (deduplicates concurrent callers). */
  refresh(): Promise<C> {
    this.#inflight ??= this.#fetch().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  #expiringSoon(): boolean {
    return !this.#creds || Date.parse(this.#creds.expiration) - Date.now() < this.#margin;
  }

  async #fetch(): Promise<C> {
    const res = await fetchCredentials(this.#url, this.#fetchOptions);
    const creds = (await res.json()) as C;
    this.#creds = creds;
    for (const fn of this.#listeners) fn(creds);
    clearTimeout(this.#timer);
    const delay = Math.max(60_000, Date.parse(creds.expiration) - Date.now() - this.#margin);
    this.#timer = setTimeout(() => {
      this.refresh().catch((err) => console.error("credential refresh failed", err));
    }, delay);
    return creds;
  }
}
