# @habemus-papadum/cf-creds-openai

Keyless OpenAI in the browser via AWS workload identity federation. The whole
chain runs client-side: the manager's ephemeral AWS credentials → STS
`GetWebIdentityToken` (a ≤300s OIDC JWT whose `sub` is the role ARN) → the
OpenAI SDK's `workloadIdentity` option exchanges it internally and re-invokes
the provider whenever its access token needs renewal. No API key exists
anywhere in the chain, and revoking the role's project membership instantly
neutralizes even already-issued access tokens.

Peers: `openai`, `@aws-sdk/client-sts`.

```ts
import { createAwsCredentialManager } from "@habemus-papadum/cf-creds-aws";
import { createFederatedOpenAI } from "@habemus-papadum/cf-creds-openai";

const manager = createAwsCredentialManager();
const client = createFederatedOpenAI({
  manager,
  region: "us-east-1",
  identityProviderId: "idp_…",   // OpenAI dashboard: provider registration
  serviceAccountId: "user-…",    // OpenAI service account the mapping targets
});

const response = await client.responses.create({ model: "gpt-4o-mini", input: "hi" });
```

Browser gotchas the factory absorbs: `dangerouslyAllowBrowser` (required by
the SDK in browsers even though there is no key to expose here) and a
binding-preserving fetch wrapper (the SDK's exchange helper calls its stored
fetch method-style, which browsers reject unless rebound).

One-time infra prerequisites (Terraform-able except the last): outbound web
identity federation enabled on the AWS account, `sts:GetWebIdentityToken` on
the role (audience- and duration-locked), an OpenAI project + service account
with a project role, and — dashboard-only — the workload identity provider
registration (AWS issuer + audience) plus a mapping from the role ARN to the
service account.
