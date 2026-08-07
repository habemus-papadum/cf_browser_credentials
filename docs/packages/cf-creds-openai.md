# @habemus-papadum/cf-creds-openai

Keyless OpenAI in the browser via AWS workload identity federation. The whole
chain runs client-side; **no API key exists anywhere**:

```
CredentialManager (AWS role creds, from the broker)
  → STS GetWebIdentityToken (≤300s OIDC JWT, sub = the role ARN)
    → OpenAI SDK workloadIdentity: exchanges the JWT internally,
      re-invoking the provider whenever its access token needs renewal
```

The refresh cycles nest: the manager keeps AWS credentials fresh (hours), the
JWT is minted on demand (seconds, single exchange), and the SDK caches its
exchanged access token with its own background-refresh buffer. A request
virtually never waits on credential work.

Peers: `openai`, `@aws-sdk/client-sts`.

## Browser walkthrough

```ts
import { createAwsCredentialManager } from "@habemus-papadum/cf-creds-aws";
import { createFederatedOpenAI } from "@habemus-papadum/cf-creds-openai";

// Dev servers point at the deployed broker; production uses the same origin.
const manager = createAwsCredentialManager({
  url: import.meta.env.DEV ? "https://example.com/api/credentials/aws" : undefined,
});

const client = createFederatedOpenAI({
  manager,
  region: "us-east-1",
  identityProviderId: "idp_…", // OpenAI dashboard: provider registration
  serviceAccountId: "user-…",  // the service account the mapping targets
});

// From here it is just the OpenAI SDK:
const models = await client.models.list();
const response = await client.responses.create({
  model: "gpt-4o-mini",
  input: "Confirm you were reached from a browser without an API key.",
});
```

Browser gotchas the factory absorbs — both found the hard way:

- `dangerouslyAllowBrowser: true` is required by the SDK in browsers, even
  though there is no key to expose in this chain.
- The SDK's token-exchange helper calls its stored fetch method-style
  (`this.fetch(...)`), which browsers reject as an illegal invocation; the
  factory supplies a binding-preserving fetch wrapper.

## Infra prerequisites (one-time)

Terraform-able: outbound web identity federation enabled on the AWS account
(exports the issuer URL); `sts:GetWebIdentityToken` on the role, condition-
locked to the OpenAI audience and ≤300s; an OpenAI project + service account
with a project role (a role-less service account authenticates but 403s).
Dashboard-only: the workload identity provider registration (issuer +
audience) and the mapping from the role ARN to the service account.

Revocation worth knowing: removing the service account's project role
instantly neutralizes even already-issued access tokens.
