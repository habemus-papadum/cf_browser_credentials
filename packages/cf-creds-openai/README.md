# @habemus-papadum/cf-creds-openai

Keyless OpenAI in the browser via AWS workload identity federation. The whole
chain runs client-side: the manager's ephemeral AWS credentials → STS
`GetWebIdentityToken` (a ≤300s OIDC JWT whose `sub` is the role ARN) → the
OpenAI SDK's `workloadIdentity` option exchanges it internally and re-invokes
the provider whenever its access token needs renewal. No API key exists
anywhere in the chain, and revoking the role's project membership instantly
neutralizes even already-issued access tokens.

Peers: `openai`, `@aws-sdk/client-sts`.

The page names only itself. One keyed mint returns the whole bundle — the STS
envelope plus the region, audience, identity-provider id and service-account
id the two legs need — so no federation id is baked into site code:

```ts
import { createBrokeredOpenAI } from "@habemus-papadum/cf-creds-openai";

const { client, manager } = await createBrokeredOpenAI({
  base: "https://creds.example.com",
  key: "scratch", // this site's own name at the service
});

manager.onRotate((creds) => showExpiry(creds.expiration));

const response = await client.responses.create({ model: "gpt-4o-mini", input: "hi" });
```

The factory is async because the broker's ids are known only once the bundle
has been fetched: the first mint happens inside it, and the returned manager
keeps the credentials fresh from there. `createOpenAICredentialManager` is
the same manager on its own, typed to the `OpenAICredentials` bundle.

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

## Legacy: ids passed from site code

`createFederatedOpenAI({ manager, region, identityProviderId, serviceAccountId })`
is the pre-key-contract entry point, where every id was a constant in the
page. It still works and is deprecated — the ids it wants are exactly what
the broker now returns. `awsSubjectTokenProvider` remains the underlying
piece, useful on its own to observe a subject token:

```ts
const provider = awsSubjectTokenProvider({ manager, region: "us-east-1" });
const jwt = await provider.getToken(); // sub = the role ARN, ~300s
```
