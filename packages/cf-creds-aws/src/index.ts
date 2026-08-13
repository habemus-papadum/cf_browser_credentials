/**
 * The AWS flavour of the ephemeral-credential pattern: the envelope type the
 * AWS broker route returns, a typed manager factory, and signed fetch — SigV4
 * request signing via aws4fetch, with the signing client cached per
 * credential session so key derivation isn't repeated across thousands of
 * range reads.
 *
 * @packageDocumentation
 */

import {
  CredentialManager,
  type EphemeralCredential,
} from "@habemus-papadum/cf-browser-credentials";
import { AwsClient } from "aws4fetch";

/** The envelope minted by an AWS AssumeRole broker route. */
export interface AwsCredentials extends EphemeralCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** The conventional broker route for AWS credentials. */
export const AWS_CREDENTIALS_PATH = "/api/credentials/aws";

/**
 * The endpoint URL for a named role at a well-known credentials service,
 * e.g. `awsCredentialsUrl("https://creds.example.com", "smoke")`.
 */
export function awsCredentialsUrl(base: string, role?: string): string {
  const url = new URL(AWS_CREDENTIALS_PATH, base);
  if (role) url.searchParams.set("role", role);
  return url.toString();
}

export interface AwsCredentialManagerOptions {
  /** Full endpoint URL; overrides `base`/`role`. Defaults to {@link AWS_CREDENTIALS_PATH}, same-origin. */
  url?: string;
  /** Origin of a well-known credentials service, e.g. `https://creds.example.com`. */
  base?: string;
  /** Named role at the well-known service (its `?role=` parameter). Requires `base`. */
  role?: string;
  refreshMarginMs?: number;
  /** See `CredentialFetchOptions` in cf-browser-credentials. */
  bounce?: boolean;
  loginUrl?: string;
}

/** A manager typed to the AWS envelope, defaulting to the conventional route. */
export function createAwsCredentialManager(
  options: AwsCredentialManagerOptions = {},
): CredentialManager<AwsCredentials> {
  if (options.role && !options.base) {
    throw new Error("role requires base — the well-known credentials service origin");
  }
  const url =
    options.url ??
    (options.base ? awsCredentialsUrl(options.base, options.role) : AWS_CREDENTIALS_PATH);
  return new CredentialManager<AwsCredentials>({
    url,
    refreshMarginMs: options.refreshMarginMs,
    bounce: options.bounce,
    loginUrl: options.loginUrl,
  });
}

/** A fetch that signs each request with the manager's current credentials. */
export type SignedFetch = (input: string | Request, init?: RequestInit) => Promise<Response>;

export interface SignedFetchOptions {
  region: string;
  /** AWS service to sign for. */
  service?: string;
  /** Observe every response (request counting, byte accounting). */
  onResponse?: (response: Response, input: string | Request, init?: RequestInit) => void;
}

/**
 * Build a {@link SignedFetch} over the manager. One aws4fetch client per
 * credential session: aws4fetch caches its derived signing key per instance,
 * so the client lives until the credentials rotate.
 */
export function createSignedFetch(
  manager: CredentialManager<AwsCredentials>,
  options: SignedFetchOptions,
): SignedFetch {
  const { region, service = "s3", onResponse } = options;
  let aws: AwsClient | undefined;
  let session: string | undefined;
  return async (input, init) => {
    const creds = await manager.get();
    if (!aws || session !== creds.sessionToken) {
      aws = new AwsClient({ ...creds, region, service });
      session = creds.sessionToken;
    }
    const res = await aws.fetch(input as RequestInfo, init);
    onResponse?.(res, input, init);
    return res;
  };
}

/**
 * List object keys under a prefix via ListObjectsV2, following continuation
 * tokens. `endpoint` is the bucket endpoint, e.g.
 * `https://my-bucket.s3.us-east-1.amazonaws.com`. Parsed with regexes, not
 * DOMParser, so it runs in workers and Node checks as well as the browser.
 */
export async function listObjects(
  signedFetch: SignedFetch,
  endpoint: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ "list-type": "2", prefix });
    if (token) params.set("continuation-token", token);
    const res = await signedFetch(`${endpoint}/?${params}`);
    const text = await res.text();
    if (!res.ok) throw new Error(`ListObjectsV2 ${res.status}: ${text.slice(0, 300)}`);
    for (const match of text.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      keys.push(unescapeXml(match[1]));
    }
    token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(text)?.[1];
  } while (token);
  return keys;
}

const unescapeXml = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
