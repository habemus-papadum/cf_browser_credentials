/**
 * The mint-policy seam and the mint log.
 *
 * Posture: **attribution before authorization**. Every mint flows through a
 * policy that sees the verified identity, and every outcome — allowed or
 * denied — is logged. But the shipped default is {@link allowAll}: anyone
 * Cloudflare Access admitted gets the deployment's standard grant. A real
 * policy is written the day a lane needs one (a scoped-down role for an
 * agent's service token, a shorter TTL for a semi-trusted context), not
 * installed as ceremony in advance.
 *
 * @packageDocumentation
 */

import type { AccessIdentity } from "./identity.js";

/** What a policy sees: who is asking, for which provider, on what request. */
export interface MintContext {
  identity: AccessIdentity;
  /** Provider key — the route: "aws", "elevenlabs", … */
  provider: string;
  request: Request;
}

/**
 * A grant carries the provider-specific mint parameters (for AWS: role ARN,
 * duration, session tags), so the policy is where credential *shaping*
 * lives, not just yes/no.
 */
export type MintDecision<Grant> =
  | { allow: true; grant: Grant }
  | { allow: false; reason: string; status?: number };

export type MintPolicy<Grant> = (
  context: MintContext,
) => MintDecision<Grant> | Promise<MintDecision<Grant>>;

/** The default posture: everyone Access admitted gets the standard grant. */
export function allowAll<Grant>(grant: Grant): MintPolicy<Grant> {
  return () => ({ allow: true, grant });
}

/** One structured log line per mint attempt. */
export interface MintLogRecord {
  type: "credential-mint";
  provider: string;
  outcome: "allowed" | "denied" | "error";
  identity: { kind: string; email?: string; commonName?: string } | null;
  reason?: string;
  grant?: unknown;
  expiration?: string;
  rayId?: string;
  colo?: string;
}

export interface MintLogInput {
  provider: string;
  outcome: "allowed" | "denied" | "error";
  /** Null when verification itself failed — there is no identity to name. */
  identity: AccessIdentity | null;
  /** When given, the Cloudflare ray id and colo are lifted off the request. */
  request?: Request;
  reason?: string;
  grant?: unknown;
  expiration?: string;
}

export function mintLogRecord(input: MintLogInput): MintLogRecord {
  const { request, identity, ...rest } = input;
  const cf = request ? (request as Request & { cf?: { colo?: string } }).cf : undefined;
  return {
    type: "credential-mint",
    ...rest,
    identity:
      identity &&
      (identity.kind === "user"
        ? { kind: identity.kind, email: identity.email }
        : { kind: identity.kind, commonName: identity.commonName }),
    rayId: request?.headers.get("cf-ray") ?? undefined,
    colo: cf?.colo,
  };
}

/**
 * Emit the mint record as one JSON line. With `observability.enabled` in the
 * worker's wrangler config, Workers Logs captures and indexes the fields —
 * that is the integration with Cloudflare's logging infrastructure; Logpush
 * is the incremental step if retention beyond days is ever needed.
 */
export function logMint(input: MintLogInput): void {
  console.log(JSON.stringify(mintLogRecord(input)));
}
