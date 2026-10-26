# @habemus-papadum/cf-browser-credentials

Request short-lived credentials from a service protected by Cloudflare Access.
The manager caches credentials in memory, combines concurrent requests, and
refreshes before expiration. It works with relative routes on the site's origin
and with a credential service on another hostname.

Provider responses must include an ISO-8601 `expiration` timestamp. Other fields
belong to each provider. Packages such as `cf-creds-aws` define those fields and
provide typed factories.

```ts
import { CredentialManager, credentialsUrl } from "@habemus-papadum/cf-browser-credentials";

interface CredentialBundle {
  token: string;
  expiration: string;
}

const manager = new CredentialManager<CredentialBundle>({
  url: credentialsUrl("/api/credentials/example", {
    base: "https://creds.example.com",
    grantPath: "research/example",
  }),
});

const credentials = await manager.get();
manager.onRotate((next) => reconfigure(next));
```

`get()` returns cached credentials until expiration is within `refreshMarginMs`
(default: 10 minutes). Concurrent calls share one request. A background timer
also refreshes at that margin; `get()` checks expiration independently in case
the browser delays the timer. Credentials are stored only in memory.

## Select a grant

A grant path identifies server-side credential configuration. Cloudflare Access
supplies the caller's identity; selecting a path does not itself grant access.
The response includes the provider configuration needed to use the credentials.
For AWS this includes the region. For OpenAI it includes an identity token and
identity-provider and service-account IDs.

```ts
credentialsUrl("/api/credentials/aws", {
  base: "https://creds.example.com",
  grantPath: "scratch",
});
// https://creds.example.com/api/credentials/aws?grant_path=scratch

credentialsUrl("/api/credentials/aws", { grantPath: "scratch" });
// /api/credentials/aws?grant_path=scratch
```

Provider factories accept the same `{ base, grantPath }` options. An explicit
`url` overrides route construction. Without `base`, the URL stays relative;
without a target, the helper leaves the route unchanged.

`key` is a deprecated alias for `grantPath`; it also sends `grant_path`.
Different values for `key` and `grantPath` are rejected. The deprecated `role`
selector continues to send `?role=` for older services. It cannot be combined
with either grant-path option. Deploy service support for `grant_path` before
upgrading clients to this SDK version.

## Complete Access login

Access cookies are specific to each hostname. A background request cannot
complete an interactive identity-provider login. When a cross-origin request
requires authentication, `fetchCredentials()` opens a login popup, retries the
request, and closes the popup after success. `CredentialManager` uses this
function internally.

Set `loginUrl` to a dedicated login page, such as `/api/login`, or use
`bounce: false` to disable popups. If a popup is blocked, catch
`AccessLoginRequired` and open its `loginUrl` from a user gesture, then retry.

Cross-origin development also requires the service to allow the development
origin and credentials in its CORS response. `cf-loopback-cors` provides this
for loopback origins.

## Inject a credential source

Consumers can accept a small interface instead of a `CredentialManager`:

```ts
interface CredentialSource<C> {
  get(): Promise<C>;
}
interface RenewableCredentialSource<C> extends CredentialSource<C> {
  refresh(): Promise<C>;
}
```

Both interfaces are exported. `CredentialManager` implements them. A custom
source can use a different service protocol or explicit credentials without
changing the provider consumer. The source owns authentication, response
validation, caching and renewal. Its owner also owns cleanup. These interfaces
do not add a login flow, a timer or a credential store.

AWS signed fetch and OpenAI federation need `get()`. The Mosaic connector also
needs `refresh()` for its explicit refresh option. Existing URL-based factories
remain available.
