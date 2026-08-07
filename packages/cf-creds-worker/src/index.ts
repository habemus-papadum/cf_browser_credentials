/**
 * Server-side mint kit for a credential-broker worker: turn long-lived
 * source credentials into short-lived role credentials via STS AssumeRole.
 * Runtime-agnostic (fetch-based) — runs in workerd and Node alike.
 *
 * This is deliberately a kit, not a framework: the worker itself stays a
 * ~30-line composition root owned by each deployment, because routes, env
 * names, and auth tripwires are deployment config. See the README for the
 * canonical composition.
 *
 * @packageDocumentation
 */

import { AwsClient } from "aws4fetch";

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
  /** Session name recorded in CloudTrail. */
  sessionName?: string;
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
