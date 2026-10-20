# @habemus-papadum/cf-creds-openai

Keyless OpenAI in the browser, federated straight from the credentials
service's own OIDC issuer. One keyed mint returns the whole bundle: a
short-lived identity token the service signed — its issuer the service, its
audience the one OpenAI's workload identity provider is registered with, the
grant key as a claim the provider's mapping matches — plus the
identity-provider and service-account ids. The OpenAI SDK's
`workloadIdentity` option exchanges the token internally and re-invokes the
provider whenever its access token needs renewal; a fresh token is a fresh
mint. No API key and no cloud credential exists anywhere in the chain, and
disabling the mapping neutralizes even already-issued access tokens.

Peer: `openai`.

The page names only itself:

```ts
import { createBrokeredOpenAI } from "@habemus-papadum/cf-creds-openai";

const { client, manager } = await createBrokeredOpenAI({
  base: "https://creds.example.com",
  key: "research", // this site's own name at the service
});

manager.onRotate((creds) => showExpiry(creds.expiration));

const response = await client.responses.create({ model: "gpt-4o-mini", input: "hi" });
```

The factory is async because the service's ids are known only once the
bundle has been fetched: the first mint happens inside it. The manager mints
on demand — when the SDK asks for a token and the cached one is within 30 s
of its end — and never on a timer, since the token lives minutes.
`createOpenAICredentialManager` is the same manager on its own, typed to the
`OpenAICredentials` bundle; `brokeredSubjectTokenProvider` wraps one as the
provider the SDK takes.

Browser gotchas the factory absorbs: `dangerouslyAllowBrowser` (required by
the SDK in browsers even though there is no key to expose here) and a
binding-preserving fetch wrapper (the SDK's exchange helper calls its stored
fetch method-style, which browsers reject unless rebound).

One-time prerequisites, service-side: an OpenAI project + service account
with a project role, and — dashboard-only — a workload identity provider for
the service's issuer (standard OIDC discovery, the agreed audience) with a
mapping from the key claim to the service account.

## Through 0.5: the AWS leg

Earlier versions rode AWS workload identity federation: the bundle was an
STS envelope and the page minted a `GetWebIdentityToken` JWT itself through
`@aws-sdk/client-sts`, with a role per grant behind it. That leg and the
`createFederatedOpenAI` / `awsSubjectTokenProvider` entry points are gone; a
service still answering the envelope shape needs 0.5.
