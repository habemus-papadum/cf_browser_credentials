/**
 * Browser-side credential manager for static sites whose ephemeral
 * credentials are minted by a broker endpoint (typically a Cloudflare Worker
 * behind Cloudflare Access), one endpoint per provider —
 * `/api/credentials/aws`, `/api/credentials/elevenlabs`, ….
 *
 * The manager is generic over the credential payload: each provider returns
 * its own envelope, and the only field the manager itself needs is
 * `expiration`, to refresh ahead of it. Everything else — in-memory caching,
 * margin-based refresh, deduplication of concurrent fetches, rotation
 * listeners — is provider-agnostic. Provider-specific envelope types and
 * consumption helpers live in sibling packages (`cf-creds-aws`, …).
 *
 * @packageDocumentation
 */

/** The one contract every provider envelope must honour. */
export interface EphemeralCredential {
  /** ISO-8601 expiration timestamp; the manager refreshes ahead of it. */
  expiration: string;
}

export interface CredentialManagerOptions {
  /**
   * Endpoint to fetch this credential from — same-origin relative in
   * production, the deployed broker's absolute URL in cross-origin dev.
   */
  url: string;
  /** Refresh this long before expiration. */
  refreshMarginMs?: number;
}

type Listener<C> = (creds: C) => void;

export class CredentialManager<C extends EphemeralCredential = EphemeralCredential> {
  #url: string;
  #margin: number;
  #creds: C | null = null;
  #inflight: Promise<C> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<Listener<C>>();

  constructor(options: CredentialManagerOptions) {
    this.#url = options.url;
    this.#margin = options.refreshMarginMs ?? 10 * 60 * 1000;
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
    // credentials:"include" is a no-op same-origin and required when a dev
    // server on localhost calls the deployed broker cross-origin.
    let res: Response;
    try {
      res = await fetch(this.#url, { credentials: "include" });
    } catch (err) {
      throw new Error(
        `credential fetch failed: ${err} — if this is a dev server calling the deployed broker, open ${this.#url} in a tab, log in, and reload`,
      );
    }
    if (!res.ok) {
      throw new Error(`credential fetch failed (${res.status}): ${await res.text()}`);
    }
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
