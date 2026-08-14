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

Under the key contract the page names only itself. One mint of
`/api/credentials/openai?key=…` returns the whole bundle — the STS envelope
plus the region, audience, identity-provider id and service-account id both
legs need — so nothing about the federation is baked into site code:

```ts
import { createBrokeredOpenAI } from "@habemus-papadum/cf-creds-openai";

const { client, manager } = await createBrokeredOpenAI({
  base: "https://creds.example.com",
  key: "scratch", // this site's own name at the service
});

manager.onRotate((creds) => showExpiry(creds.expiration));

// From here it is just the OpenAI SDK:
const models = await client.models.list();
const response = await client.responses.create({
  model: "gpt-4o-mini",
  input: "Confirm you were reached from a browser without an API key.",
});
```

The factory is async for one reason: the broker's ids are known only after
the bundle has been fetched, so the first mint happens inside it. The
returned `manager` is that same credential manager, typed to the
`OpenAICredentials` bundle — `onRotate` for UI, `refresh()` to force a mint.
`createOpenAICredentialManager` builds it alone if a page wants the
credentials without a client.

Browser gotchas the factory absorbs — both found the hard way:

- `dangerouslyAllowBrowser: true` is required by the SDK in browsers, even
  though there is no key to expose in this chain.
- The SDK's token-exchange helper calls its stored fetch method-style
  (`this.fetch(...)`), which browsers reject as an illegal invocation; the
  factory supplies a binding-preserving fetch wrapper.

## Legacy: ids passed from site code

`createFederatedOpenAI` is the pre-key-contract entry point: same client,
but every id arrives as a constant from the page.

```ts
import { createAwsCredentialManager } from "@habemus-papadum/cf-creds-aws";
import { createFederatedOpenAI } from "@habemus-papadum/cf-creds-openai";

const manager = createAwsCredentialManager();
const client = createFederatedOpenAI({
  manager,
  region: "us-east-1",
  identityProviderId: "idp_…", // OpenAI dashboard: provider registration
  serviceAccountId: "user-…",  // the service account the mapping targets
});
```

It still works and is deprecated — what it asks for is exactly what the
broker now returns. `awsSubjectTokenProvider` is the piece underneath both
paths, and stays useful on its own for observing a subject token:

```ts
const provider = awsSubjectTokenProvider({ manager, region: "us-east-1" });
const jwt = await provider.getToken(); // sub = the role ARN, ~300s lifetime
```

## Infra prerequisites (one-time)

Terraform-able: outbound web identity federation enabled on the AWS account
(exports the issuer URL); `sts:GetWebIdentityToken` on the role, condition-
locked to the OpenAI audience and ≤300s; an OpenAI project + service account
with a project role (a role-less service account authenticates but 403s).
Dashboard-only: the workload identity provider registration (issuer +
audience) and the mapping from the role ARN to the service account.

Revocation worth knowing: removing the service account's project role
instantly neutralizes even already-issued access tokens.
