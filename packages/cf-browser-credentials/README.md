# @habemus-papadum/cf-browser-credentials

Browser-side credential manager for static sites whose ephemeral credentials
are minted by a broker endpoint (typically a Cloudflare Worker behind
Cloudflare Access) — same-origin routes (`/api/credentials/aws`,
`/api/credentials/elevenlabs`, …) or a **well-known cross-origin credentials
service** (e.g. `https://creds.example.com`). Caches in memory, refreshes
before expiry, deduplicates concurrent fetches, notifies consumers on
rotation.

The manager is **generic over the credential envelope**: each provider route
returns its own shape, and the only field the manager itself requires is
`expiration` (ISO-8601) — that is the whole provider contract. AWS-specific
types and helpers live in `@habemus-papadum/cf-creds-aws`; a new provider is
a new route plus a type, with no changes here.

```ts
import { CredentialManager } from "@habemus-papadum/cf-browser-credentials";

interface ElevenLabsCredential {
  token: string;
  expiration: string;
}

const manager = new CredentialManager<ElevenLabsCredential>({
  // Dev servers call the deployed broker cross-origin; the auth cookie rides
  // along. Same-origin relative in production.
  url: "/api/credentials/elevenlabs",
});

const creds = await manager.get();          // cached, refreshed inside the margin
manager.onRotate((c) => reconfigure(c));    // push rotations to consumers
```

Semantics worth relying on:

- `get()` returns cached credentials until they are within `refreshMarginMs`
  (default 10 min) of expiry, then refreshes; concurrent callers share one
  in-flight request.
- A background timer refreshes at `expiration − margin`; browser tab
  throttling only delays it — `get()` re-checks on every call, so
  correctness never depends on the timer.
- Credentials live in memory only.

The cross-origin dev flow requires the broker to echo loopback origins with
credentials allowed — see `@habemus-papadum/cf-loopback-cors`.

## The login bounce

Access cookies are per-hostname, so the first fetch of a session against a
cross-origin credentials service fails before the browser holds that host's
cookie (Access 302s the background fetch into an IdP flow, surfacing as a
CORS error). `fetchCredentials` — used by the manager and exported directly —
handles this automatically for cross-origin URLs: it opens the endpoint in a
popup once (a top-level navigation completes the SSO dance and sets the
cookie), polls until the fetch succeeds, and closes the popup. Pass
`loginUrl` to bounce via a dedicated self-closing page (e.g. `/api/login`)
when the service offers one, `bounce: false` to opt out, and catch
`AccessLoginRequired` to rerun the bounce from a user gesture when the
popup is blocked.
