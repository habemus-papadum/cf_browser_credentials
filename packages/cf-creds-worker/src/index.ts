/**
 * Server-side mint kit for a credential-broker worker: turn long-lived
 * source credentials into short-lived role credentials via STS AssumeRole,
 * with Cloudflare Access identity verification (identity.ts), a pluggable
 * mint policy, and a structured mint log (policy.ts).
 * Runtime-agnostic (fetch-based) — runs in workerd and Node alike.
 *
 * This is deliberately a kit, not a framework: the worker itself stays a
 * small composition root owned by each deployment, because routes, env
 * names, and policy are deployment config. See the README for the
 * canonical composition.
 *
 * @packageDocumentation
 */

import { AwsClient } from "aws4fetch";

import type { AccessIdentity } from "./identity.js";

export * from "./identity.js";
export * from "./policy.js";

export interface SourceCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsTemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO-8601, as returned by STS. */
  expiration: string;
}

export interface AssumeRoleOptions {
  /** STS region; requests go to the regional endpoint. */
  region?: string;
  /** Session name recorded in CloudTrail; see {@link sessionNameFor}. */
  sessionName?: string;
  /**
   * STS session tags (the role's trust policy must grant `sts:TagSession`).
   * Tags land in CloudTrail and are usable in IAM policy conditions.
   */
  tags?: Record<string, string>;
}

/**
 * A RoleSessionName carrying the caller's identity. The session name is
 * embedded in the assumed-role ARN, so every API call made with the minted
 * credentials attributes to this identity in CloudTrail — the single
 * highest-leverage line of the attribution story. Sanitized to the STS
 * session-name charset and length.
 */
export function sessionNameFor(identity: AccessIdentity): string {
  const raw = identity.kind === "user" ? identity.email : identity.commonName;
  const clean = raw.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);
  return clean.length >= 2 ? clean : "anonymous";
}

function extract(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  if (!match) throw new Error(`STS response missing <${tag}>`);
  return match[1];
}

export async function assumeRole(
  source: SourceCredentials,
  roleArn: string,
  durationSeconds: number,
  options: AssumeRoleOptions = {},
): Promise<AwsTemporaryCredentials> {
  const region = options.region ?? "us-east-1";
  const sts = new AwsClient({ ...source, region, service: "sts" });
  const body = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: options.sessionName ?? `browser-${Date.now()}`,
    DurationSeconds: String(durationSeconds),
  });
  Object.entries(options.tags ?? {}).forEach(([key, value], i) => {
    body.set(`Tags.member.${i + 1}.Key`, key);
    body.set(`Tags.member.${i + 1}.Value`, value);
  });
  const res = await sts.fetch(`https://sts.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const xml = await res.text();
  if (!res.ok) {
    throw new Error(`STS AssumeRole failed (${res.status}): ${xml.slice(0, 500)}`);
  }
  return {
    accessKeyId: extract(xml, "AccessKeyId"),
    secretAccessKey: extract(xml, "SecretAccessKey"),
    sessionToken: extract(xml, "SessionToken"),
    expiration: extract(xml, "Expiration"),
  };
}
