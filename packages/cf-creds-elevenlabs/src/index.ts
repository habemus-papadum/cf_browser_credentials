/**
 * ElevenLabs single-use realtime tokens.
 *
 * ElevenLabs is the third credential species in this kit: not federated (no
 * AWS identity federation exists there) and not a session credential — its
 * realtime tokens are **single-use** (consumed at first connect) with a
 * fixed, non-configurable 15-minute TTL. Caching one would hand out a dead
 * token, so there is deliberately no `CredentialManager` here: the browser
 * fetches a fresh token from the broker route immediately before every
 * WebSocket connect.
 *
 * Worker side: {@link mintScribeToken} calls the vendor with the parent key
 * (a wrangler secret) and returns the standard envelope. Browser side:
 * {@link fetchScribeToken} + {@link scribeSocketUrl}.
 *
 * @packageDocumentation
 */

import {
  type BrokerRouteOptions,
  type CredentialFetchOptions,
  type CredentialTarget,
  credentialsUrl,
  type EphemeralCredential,
  fetchCredentials,
} from "@habemus-papadum/cf-browser-credentials";

/** Fixed by ElevenLabs; no ttl/expires_in parameter exists. */
export const SCRIBE_TOKEN_TTL_SECONDS = 900;

/** The conventional broker route for scribe tokens. */
export const ELEVENLABS_CREDENTIALS_PATH = "/api/credentials/elevenlabs";

/**
 * The envelope the broker route returns. `expiration` honours the kit-wide
 * contract, but note the stronger constraint: the token dies at first use,
 * so treat it as connect-immediately, never cache.
 */
export interface ScribeToken extends EphemeralCredential {
  /** Single-use realtime token (`sutkn_…`). */
  token: string;
}

/**
 * Worker-side mint: exchange the parent API key for a single-use realtime
 * scribe token. The token type is the scope; there is no finer scoping.
 */
export async function mintScribeToken(apiKey: string): Promise<ScribeToken> {
  const res = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ElevenLabs token mint failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const { token } = JSON.parse(text) as { token?: string };
  if (!token) throw new Error("ElevenLabs token mint returned no token");
  return {
    token,
    expiration: new Date(Date.now() + SCRIBE_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Where to fetch a token from: the well-known service (`base`) plus the
 * site's own `key`, or an explicit `url`. Fetch options ride along.
 */
export interface ScribeBrokerOptions extends BrokerRouteOptions, CredentialFetchOptions {}

/**
 * The endpoint URL at a well-known credentials service for a site's key,
 * e.g. `elevenLabsCredentialsUrl("https://creds.example.com", { key: "scratch" })`.
 */
export function elevenLabsCredentialsUrl(base: string, target: CredentialTarget = {}): string {
  return credentialsUrl(ELEVENLABS_CREDENTIALS_PATH, { base, ...target });
}

// Both browser entry points accept either shape: a bare URL string (the
// same-origin route, or a full one) or the keyed broker options.
function brokerFetch(
  broker: string | ScribeBrokerOptions,
  options: CredentialFetchOptions,
): Promise<Response> {
  const source: ScribeBrokerOptions = typeof broker === "string" ? { url: broker } : broker;
  return fetchCredentials(credentialsUrl(ELEVENLABS_CREDENTIALS_PATH, source), {
    bounce: options.bounce ?? source.bounce,
    loginUrl: options.loginUrl ?? source.loginUrl,
  });
}

/**
 * Browser-side: fetch a fresh single-use token from the broker route.
 * Call this immediately before each WebSocket connect — never ahead of time.
 */
export async function fetchScribeToken(
  broker: string | ScribeBrokerOptions = ELEVENLABS_CREDENTIALS_PATH,
  options: CredentialFetchOptions = {},
): Promise<ScribeToken> {
  const res = await brokerFetch(broker, options);
  return (await res.json()) as ScribeToken;
}

export interface ScribeSocketOptions {
  modelId?: string;
  /** e.g. "pcm_24000". */
  audioFormat?: string;
  includeTimestamps?: boolean;
}

/**
 * The realtime STT WebSocket URL for a token — the `token` query parameter
 * replaces the `xi-api-key` header; no subprotocol is involved.
 */
export function scribeSocketUrl(token: string, options: ScribeSocketOptions = {}): string {
  const params = new URLSearchParams({
    model_id: options.modelId ?? "scribe_v2_realtime",
    token,
  });
  if (options.audioFormat) params.set("audio_format", options.audioFormat);
  if (options.includeTimestamps !== undefined) {
    params.set("include_timestamps", String(options.includeTimestamps));
  }
  return `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`;
}

/**
 * Convenience for the whole browser flow: fresh token, then the socket URL.
 *
 * ```ts
 * const ws = new WebSocket(
 *   await connectUrl({ base: "https://creds.example.com", key: "scratch" }),
 * );
 * ```
 */
export async function connectUrl(
  broker: string | ScribeBrokerOptions = ELEVENLABS_CREDENTIALS_PATH,
  options: ScribeSocketOptions = {},
  fetchOptions: CredentialFetchOptions = {},
): Promise<string> {
  const { token } = await fetchScribeToken(broker, fetchOptions);
  return scribeSocketUrl(token, options);
}
