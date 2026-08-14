/**
 * Keyless OpenAI in the browser via AWS workload identity federation.
 *
 * The chain, entirely client-side: the manager's ephemeral AWS credentials →
 * STS `GetWebIdentityToken` (a ≤300s OIDC JWT whose `sub` is the role ARN) →
 * the OpenAI SDK's `workloadIdentity` option exchanges it internally and
 * re-invokes the provider whenever it needs a fresh token. No API key exists
 * anywhere in the chain.
 *
 * Under the **key contract** the page names only itself: one call to
 * {@link createBrokeredOpenAI} with `{ base, key }` fetches the openai
 * bundle — the STS envelope plus region, audience, identity-provider id and
 * service-account id, minted together — and returns a ready client. No
 * federation id is baked into site code.
 *
 * Prerequisites (once, server/infra-side): outbound web identity federation
 * enabled on the AWS account, `sts:GetWebIdentityToken` allowed on the role,
 * and an OpenAI workload identity provider + service-account mapping pinned
 * to the role ARN.
 *
 * @packageDocumentation
 */

import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";
import {
  type BrokerRouteOptions,
  type CredentialFetchOptions,
  CredentialManager,
  type CredentialTarget,
  credentialsUrl,
} from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import OpenAI from "openai";

/** The audience OpenAI's workload identity provider is registered with. */
const DEFAULT_AUDIENCE = "https://api.openai.com/v1";

export interface SubjectTokenOptions {
  manager: CredentialManager<AwsCredentials>;
  /** STS region — GetWebIdentityToken exists only on regional endpoints. */
  region: string;
  /** Must match the audience configured on the OpenAI identity provider. */
  audience?: string;
  /** JWT lifetime; it only needs to survive one exchange round-trip. */
  durationSeconds?: number;
}

/** The shape the OpenAI SDK expects from `workloadIdentity.provider`. */
export interface SubjectTokenProvider {
  tokenType: "jwt";
  getToken: () => Promise<string>;
}

/**
 * A provider minting a fresh OIDC JWT on demand from whatever credentials
 * the manager currently holds — composing the two refresh cycles: the
 * manager keeps AWS credentials fresh, the SDK re-invokes this whenever its
 * exchanged access token needs renewal.
 */
export function awsSubjectTokenProvider(options: SubjectTokenOptions): SubjectTokenProvider {
  const { manager, region, audience = DEFAULT_AUDIENCE, durationSeconds = 300 } = options;
  return {
    tokenType: "jwt",
    getToken: async () => {
      const creds = await manager.get();
      const sts = new STSClient({
        region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
      const { WebIdentityToken } = await sts.send(
        new GetWebIdentityTokenCommand({
          Audience: [audience],
          SigningAlgorithm: "ES384",
          DurationSeconds: durationSeconds,
        }),
      );
      if (!WebIdentityToken) throw new Error("STS returned no web identity token");
      return WebIdentityToken;
    },
  };
}

export interface FederatedOpenAIOptions extends SubjectTokenOptions {
  /** From the OpenAI dashboard's provider registration (idp_…). */
  identityProviderId: string;
  /** From the OpenAI service account (user-…). */
  serviceAccountId: string;
}

/**
 * An OpenAI client authenticated purely by federation. Browser notes baked
 * in: `dangerouslyAllowBrowser` is required by the SDK in browsers even
 * though there is no key to expose here, and the SDK's exchange helper calls
 * its stored fetch method-style — which browsers reject unless rebound — so
 * a binding-preserving fetch wrapper is supplied.
 *
 * @deprecated Every id here now comes from the broker. Use
 * {@link createBrokeredOpenAI}, which names only the site's own key.
 */
export function createFederatedOpenAI(options: FederatedOpenAIOptions): OpenAI {
  return federatedClient(options);
}

function federatedClient(options: FederatedOpenAIOptions): OpenAI {
  const { identityProviderId, serviceAccountId, ...subject } = options;
  return new OpenAI({
    dangerouslyAllowBrowser: true,
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    workloadIdentity: {
      identityProviderId,
      serviceAccountId,
      provider: awsSubjectTokenProvider(subject),
    },
  });
}

/** The conventional broker route for the OpenAI federation bundle. */
export const OPENAI_CREDENTIALS_PATH = "/api/credentials/openai";

/**
 * The whole bundle one openai mint returns: the STS envelope plus the
 * federation config both legs of the chain need. Everything a page would
 * otherwise hard-code lives here instead.
 */
export interface OpenAICredentials extends AwsCredentials {
  /** STS region for the GetWebIdentityToken leg. */
  region: string;
  /** Audience the OpenAI identity provider is registered with. */
  audience: string;
  /** OpenAI provider registration (idp_…). */
  identityProviderId: string;
  /** OpenAI service account the mapping targets (user-…). */
  serviceAccountId: string;
}

/**
 * The endpoint URL at a well-known credentials service for a site's key,
 * e.g. `openaiCredentialsUrl("https://creds.example.com", { key: "scratch" })`.
 */
export function openaiCredentialsUrl(base: string, target: CredentialTarget = {}): string {
  return credentialsUrl(OPENAI_CREDENTIALS_PATH, { base, ...target });
}

export interface BrokeredOpenAIOptions extends BrokerRouteOptions, CredentialFetchOptions {
  /** Full endpoint URL; overrides `base`/`key`. Defaults to {@link OPENAI_CREDENTIALS_PATH}, same-origin. */
  url?: string;
  refreshMarginMs?: number;
  /** JWT lifetime for the STS leg; it only needs to survive one exchange. */
  durationSeconds?: number;
}

/** A manager typed to the openai bundle, defaulting to the conventional route. */
export function createOpenAICredentialManager(
  options: BrokeredOpenAIOptions = {},
): CredentialManager<OpenAICredentials> {
  return new CredentialManager<OpenAICredentials>({
    url: credentialsUrl(OPENAI_CREDENTIALS_PATH, options),
    refreshMarginMs: options.refreshMarginMs,
    bounce: options.bounce,
    loginUrl: options.loginUrl,
  });
}

export interface BrokeredOpenAI {
  /** Federated client, ready to use — it is the OpenAI SDK from here on. */
  client: OpenAI;
  /** The credentials behind it: `onRotate` for UI, `refresh()` to force a mint. */
  manager: CredentialManager<OpenAICredentials>;
}

/**
 * A federated OpenAI client built from nothing but the site's own key. The
 * broker's ids are only known once the bundle has been fetched, so this is
 * async — the first mint happens here, and the manager keeps it fresh
 * afterwards.
 *
 * ```ts
 * const { client, manager } = await createBrokeredOpenAI({
 *   base: "https://creds.example.com",
 *   key: "scratch",
 * });
 * manager.onRotate((creds) => show(creds.expiration));
 * const res = await client.responses.create({ model: "gpt-4o-mini", input: "hi" });
 * ```
 */
export async function createBrokeredOpenAI(
  options: BrokeredOpenAIOptions = {},
): Promise<BrokeredOpenAI> {
  const manager = createOpenAICredentialManager(options);
  // The first mint resolves the federation config; rotations keep the same
  // grant, so the ids are read once and the manager carries the rest.
  const bundle = await manager.get();
  const client = federatedClient({
    manager,
    region: bundle.region,
    audience: bundle.audience,
    durationSeconds: options.durationSeconds,
    identityProviderId: bundle.identityProviderId,
    serviceAccountId: bundle.serviceAccountId,
  });
  return { client, manager };
}
