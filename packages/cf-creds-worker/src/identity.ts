/**
 * Cloudflare Access identity verification.
 *
 * Access fronts the hostname and forwards a signed JWT on every request
 * (`cf-access-jwt-assertion`). Verifying the signature — rather than merely
 * detecting the header, as the original tripwire did — hardens the gate
 * against route misconfiguration and, more importantly, yields the caller's
 * identity: the email of a logged-in user, or the client id of a service
 * token on a headless lane. Identity is recorded on every mint; whether it
 * *restricts* anything is the policy's business (see policy.ts).
 *
 * @packageDocumentation
 */

/** Claims of a verified Access JWT. Cloudflare's set, open to extension. */
export interface AccessClaims {
  aud?: string | string[];
  email?: string;
  /** Service-token authentication: the token's client id. */
  common_name?: string;
  iss?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  country?: string;
  identity_nonce?: string;
  [claim: string]: unknown;
}

/** Who a verified request is: a human who logged in, or a service token. */
export type AccessIdentity =
  | { kind: "user"; email: string; claims: AccessClaims }
  | { kind: "service-token"; commonName: string; claims: AccessClaims };

export interface VerifyAccessOptions {
  /** Zero Trust team domain, e.g. "example.cloudflareaccess.com". */
  teamDomain: string;
  /** Access app AUD tag; when set, the JWT's `aud` must include it. */
  audience?: string;
  /** Allowed clock skew for exp/nbf checks, in seconds (default 60). */
  clockToleranceSeconds?: number;
  /** Fetch used for the JWKS request (test seam). */
  fetcher?: typeof fetch;
}

/** Any reason a request's Access identity could not be established. */
export class AccessVerificationError extends Error {}

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_RETRY_FLOOR_MS = 60 * 1000;

interface CachedJwks {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

// Module-level: a worker isolate serves many requests, the team's signing
// keys rotate rarely. Refreshed on expiry or on an unseen kid (rate-limited).
const jwksCache = new Map<string, CachedJwks>();

function base64UrlToBytes(part: string) {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

async function fetchJwks(teamDomain: string, fetcher: typeof fetch): Promise<CachedJwks> {
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) {
    throw new AccessVerificationError(`Access JWKS fetch failed (${res.status})`);
  }
  const { keys } = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  return { fetchedAt: Date.now(), keys: imported };
}

async function signingKey(
  teamDomain: string,
  kid: string,
  fetcher: typeof fetch,
): Promise<CryptoKey> {
  const cached = jwksCache.get(teamDomain);
  const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
  const hit = cached?.keys.get(kid);
  if (hit && age < JWKS_TTL_MS) return hit;
  if (cached && age < JWKS_RETRY_FLOOR_MS) {
    // Fresh fetch, kid still unknown — don't hammer the JWKS endpoint.
    throw new AccessVerificationError(`no Access signing key for kid ${kid}`);
  }
  const fresh = await fetchJwks(teamDomain, fetcher);
  jwksCache.set(teamDomain, fresh);
  const key = fresh.keys.get(kid);
  if (!key) throw new AccessVerificationError(`no Access signing key for kid ${kid}`);
  return key;
}

/**
 * Verify the request's `cf-access-jwt-assertion` and return who it is.
 *
 * Checks: signature against the team's published JWKS, `exp`/`nbf` (with
 * skew tolerance), `iss` matching the team domain, and — when `audience` is
 * given — that `aud` includes the Access app's AUD tag. Throws
 * {@link AccessVerificationError} on any failure; the composition root maps
 * that to a 401.
 */
export async function verifyAccessIdentity(
  request: Request,
  options: VerifyAccessOptions,
): Promise<AccessIdentity> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AccessVerificationError("no Cloudflare Access JWT on request");
  return verifyAccessToken(token, options);
}

/** {@link verifyAccessIdentity} for a bare token string. */
export async function verifyAccessToken(
  token: string,
  options: VerifyAccessOptions,
): Promise<AccessIdentity> {
  const teamDomain = options.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  const tolerance = options.clockToleranceSeconds ?? 60;

  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessVerificationError("malformed Access JWT");
  let header: Record<string, unknown>;
  let claims: AccessClaims;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = decodeJsonPart(parts[0]);
    claims = decodeJsonPart(parts[1]) as AccessClaims;
    signature = base64UrlToBytes(parts[2]);
  } catch {
    throw new AccessVerificationError("malformed Access JWT");
  }
  if (header.alg !== "RS256") {
    throw new AccessVerificationError(`unexpected Access JWT alg ${String(header.alg)}`);
  }
  if (typeof header.kid !== "string") {
    throw new AccessVerificationError("Access JWT header carries no kid");
  }

  const key = await signingKey(teamDomain, header.kid, fetcher);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AccessVerificationError("Access JWT signature verification failed");

  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || now > claims.exp + tolerance) {
    throw new AccessVerificationError("Access JWT expired");
  }
  if (typeof claims.nbf === "number" && now < claims.nbf - tolerance) {
    throw new AccessVerificationError("Access JWT not yet valid");
  }
  if (claims.iss !== `https://${teamDomain}`) {
    throw new AccessVerificationError(`unexpected Access JWT issuer ${String(claims.iss)}`);
  }
  if (options.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(options.audience)) {
      throw new AccessVerificationError("Access JWT audience mismatch");
    }
  }

  if (typeof claims.email === "string" && claims.email) {
    return { kind: "user", email: claims.email, claims };
  }
  if (typeof claims.common_name === "string" && claims.common_name) {
    return { kind: "service-token", commonName: claims.common_name, claims };
  }
  throw new AccessVerificationError("Access JWT carries neither email nor common_name");
}
