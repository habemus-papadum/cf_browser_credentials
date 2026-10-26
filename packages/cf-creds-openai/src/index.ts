/**
 * Keyless OpenAI in the browser, federated straight from the credentials
 * service's own OIDC issuer.
 *
 * One credential request returns the openai bundle: a short-lived identity token the
 * service signed — its issuer the service, its audience the one OpenAI's
 * workload identity provider is registered with, the grant path as a claim
 * the provider's mapping matches — plus the identity-provider and
 * service-account ids. The OpenAI SDK's `workloadIdentity` option exchanges
 * the token internally and re-invokes the provider whenever its access token
 * needs renewal; a new token requires a new credential request. No API key and no cloud
 * credential exists anywhere in the chain.
 *
 * Through 0.5 this package rode AWS: the bundle was an STS envelope and the
 * page minted a `GetWebIdentityToken` JWT itself through the AWS SDK. That
 * leg, the role per grant behind it and the `@aws-sdk/client-sts` peer are
 * gone; a service still answering the envelope shape needs 0.5.
 *
 * @packageDocumentation
 */

import {
  type BrokerRouteOptions,
  type CredentialFetchOptions,
  CredentialManager,
  type CredentialSource,
  type CredentialTarget,
  credentialsUrl,
  type EphemeralCredential,
} from "@habemus-papadum/cf-browser-credentials";
import OpenAI from "openai";

/** The shape the OpenAI SDK expects from `workloadIdentity.provider`. */
export interface SubjectTokenProvider {
  tokenType: "jwt";
  getToken: () => Promise<string>;
}

/** The conventional broker route for the OpenAI federation bundle. */
export const OPENAI_CREDENTIALS_PATH = "/api/credentials/openai";

/**
 * The whole bundle one OpenAI credential request returns: the subject token and the
 * federation config the SDK's exchange names. Everything a page would
 * otherwise hard-code lives here instead.
 */
export interface OpenAICredentials extends EphemeralCredential {
  /**
   * The identity token the service signed: issuer the service, audience the
   * provider's, the grant path as a claim. Lives minutes; `expiration` is its
   * `exp`.
   */
  identityToken: string;
  /** Audience the OpenAI identity provider is registered with. */
  audience: string;
  /** OpenAI provider registration (idp_…). */
  identityProviderId: string;
  /** OpenAI service account the mapping targets (user-…). */
  serviceAccountId: string;
}

/** Tokens live minutes: refresh this close to the end, not the manager's ten-minute default. */
const DEFAULT_REFRESH_MARGIN_MS = 30_000;

/**
 * A provider handing the SDK the current token, requesting a new token only when
 * the cached one is near its end. The SDK asks when its exchanged access
 * token needs renewal, so a credential request happens per access-token lifetime, never
 * per request.
 */
export function brokeredSubjectTokenProvider(
  source: CredentialSource<OpenAICredentials>,
): SubjectTokenProvider {
  return {
    tokenType: "jwt",
    getToken: async () => (await source.get()).identityToken,
  };
}

/**
 * The endpoint URL at a well-known credentials service for a site's grant path,
 * e.g. `openaiCredentialsUrl("https://creds.example.com", { grantPath: "research" })`.
 */
export function openaiCredentialsUrl(base: string, target: CredentialTarget = {}): string {
  return credentialsUrl(OPENAI_CREDENTIALS_PATH, { base, ...target });
}

export interface BrokeredOpenAIOptions extends BrokerRouteOptions, CredentialFetchOptions {
  /** Full endpoint URL; overrides `base`/`grantPath`. Defaults to {@link OPENAI_CREDENTIALS_PATH}, same-origin. */
  url?: string;
  /** Refresh the token this close to its expiry (default 30 s). */
  refreshMarginMs?: number;
}

/**
 * A manager typed to the openai bundle, defaulting to the conventional
 * route. It fetches on demand only: the SDK asks when its access token
 * needs renewal, and a background timer on a minutes-long token would make requests
 * all day.
 */
export function createOpenAICredentialManager(
  options: BrokeredOpenAIOptions = {},
): CredentialManager<OpenAICredentials> {
  return new CredentialManager<OpenAICredentials>({
    url: credentialsUrl(OPENAI_CREDENTIALS_PATH, options),
    refreshMarginMs: options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS,
    autoRefresh: false,
    bounce: options.bounce,
    loginUrl: options.loginUrl,
  });
}

export interface BrokeredOpenAI {
  /** Federated client, ready to use — it is the OpenAI SDK from here on. */
  client: OpenAI;
  /** The credentials behind it: `onRotate` for UI, `refresh()` to request a new token. */
  manager: CredentialManager<OpenAICredentials>;
}

/**
 * A federated OpenAI client built from nothing but the site's grant path. The
 * service's ids are only known once the bundle has been fetched, so this is
 * async — the first request happens here, and the manager requests credentials again whenever
 * the SDK needs a fresh token. Browser notes baked in: `dangerouslyAllowBrowser`
 * is required by the SDK in browsers even though there is no key to expose
 * here, and the SDK's exchange helper calls its stored fetch method-style —
 * which browsers reject unless rebound — so a binding-preserving fetch
 * wrapper is supplied.
 *
 * ```ts
 * const { client, manager } = await createBrokeredOpenAI({
 *   base: "https://creds.example.com",
 *   grantPath: "research",
 * });
 * manager.onRotate((creds) => show(creds.expiration));
 * const res = await client.responses.create({ model: "gpt-4o-mini", input: "hi" });
 * ```
 */
export async function createBrokeredOpenAI(
  options: BrokeredOpenAIOptions = {},
): Promise<BrokeredOpenAI> {
  const manager = createOpenAICredentialManager(options);
  const client = await createOpenAIFromSource(manager);
  return { client, manager };
}

/**
 * Build an OpenAI SDK client from an injected credential source. Authentication,
 * response validation, caching and cleanup stay with the source's owner.
 *
 * The first bundle fixes the federation coordinates for this client. Later
 * subject tokens must use the same audience, identity provider and service
 * account. Rebuild the client deliberately to select a different target.
 */
export async function createOpenAIFromSource(
  source: CredentialSource<OpenAICredentials>,
): Promise<OpenAI> {
  const { audience, identityProviderId, serviceAccountId } = await source.get();
  const provider: SubjectTokenProvider = {
    tokenType: "jwt",
    async getToken() {
      const bundle = await source.get();
      if (
        bundle.audience !== audience ||
        bundle.identityProviderId !== identityProviderId ||
        bundle.serviceAccountId !== serviceAccountId
      ) {
        throw new Error("OpenAI credential target changed; create a new client.");
      }
      return bundle.identityToken;
    },
  };
  return new OpenAI({
    dangerouslyAllowBrowser: true,
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    workloadIdentity: {
      identityProviderId,
      serviceAccountId,
      provider,
    },
  });
}
