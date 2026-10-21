/**
 * Credential authorization and request logs.
 *
 * A policy receives the verified Access identity and decides which credentials
 * to provide. Every outcome can be recorded with logCredentialRequest().
 * The allowAll() helper returns the same grant for all authenticated callers.
 * Deployments that need additional restrictions must supply their own policy.
 *
 * @packageDocumentation
 */

import type { AccessIdentity } from "./identity.js";

/** What a policy sees: who is asking, for which provider, on what request. */
export interface CredentialContext {
  identity: AccessIdentity;
  /** Provider route: "aws", "elevenlabs", … */
  provider: string;
  request: Request;
}

/**
 * A grant carries the provider-specific request parameters (for AWS: role ARN,
 * duration, session tags), so the policy is where credential *shaping*
 * lives, not just yes/no.
 */
export type CredentialDecision<Grant> =
  | { allow: true; grant: Grant }
  | { allow: false; reason: string; status?: number };

export type CredentialPolicy<Grant> = (
  context: CredentialContext,
) => CredentialDecision<Grant> | Promise<CredentialDecision<Grant>>;

/** The default posture: everyone Access admitted gets the standard grant. */
export function allowAll<Grant>(grant: Grant): CredentialPolicy<Grant> {
  return () => ({ allow: true, grant });
}

/** One structured log line per credential request. */
export interface CredentialRequestLogRecord {
  type: "credential_request";
  provider: string;
  outcome: "allowed" | "denied" | "error";
  identity: { kind: string; email?: string; commonName?: string } | null;
  reason?: string;
  grant?: unknown;
  expiration?: string;
  rayId?: string;
  colo?: string;
}

export interface CredentialRequestLogInput {
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

export function credentialRequestLogRecord(
  input: CredentialRequestLogInput,
): CredentialRequestLogRecord {
  const { request, identity, ...rest } = input;
  const cf = request ? (request as Request & { cf?: { colo?: string } }).cf : undefined;
  return {
    type: "credential_request",
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
 * Emit the credential request record as one JSON line. With `observability.enabled` in the
 * worker's wrangler config, Workers Logs captures and indexes the fields —
 * that is the integration with Cloudflare's logging infrastructure; Logpush
 * is the incremental step if retention beyond days is ever needed.
 */
export function logCredentialRequest(input: CredentialRequestLogInput): void {
  console.log(JSON.stringify(credentialRequestLogRecord(input)));
}

/** @deprecated Use CredentialContext. */
export type MintContext = CredentialContext;
/** @deprecated Use CredentialDecision. */
export type MintDecision<Grant> = CredentialDecision<Grant>;
/** @deprecated Use CredentialPolicy. */
export type MintPolicy<Grant> = CredentialPolicy<Grant>;
/** @deprecated Use CredentialRequestLogRecord. */
export type MintLogRecord = CredentialRequestLogRecord;
/** @deprecated Use CredentialRequestLogInput. */
export type MintLogInput = CredentialRequestLogInput;
/** @deprecated Use credentialRequestLogRecord. New records use credential_request. */
export const mintLogRecord = credentialRequestLogRecord;
/** @deprecated Use logCredentialRequest. New records use credential_request. */
export const logMint = logCredentialRequest;
