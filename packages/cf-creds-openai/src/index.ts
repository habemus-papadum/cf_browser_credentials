/**
 * Keyless OpenAI in the browser via AWS workload identity federation.
 *
 * The chain, entirely client-side: the manager's ephemeral AWS credentials →
 * STS `GetWebIdentityToken` (a ≤300s OIDC JWT whose `sub` is the role ARN) →
 * the OpenAI SDK's `workloadIdentity` option exchanges it internally and
 * re-invokes the provider whenever it needs a fresh token. No API key exists
 * anywhere in the chain.
 *
 * Prerequisites (once, server/infra-side): outbound web identity federation
 * enabled on the AWS account, `sts:GetWebIdentityToken` allowed on the role,
 * and an OpenAI workload identity provider + service-account mapping pinned
 * to the role ARN.
 *
 * @packageDocumentation
 */

import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";
import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import OpenAI from "openai";

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
  const {
    manager,
    region,
    audience = "https://api.openai.com/v1",
    durationSeconds = 300,
  } = options;
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
 */
export function createFederatedOpenAI(options: FederatedOpenAIOptions): OpenAI {
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
