# @habemus-papadum/cf-creds-elevenlabs

ElevenLabs single-use realtime tokens — the third credential species in this
kit. No AWS federation exists at ElevenLabs, and their realtime tokens are
**single-use** (consumed at first connect) with a fixed 15-minute TTL, so the
cache-until-expiry `CredentialManager` model would hand out dead tokens.
Instead: mint on the worker from a parent key, and in the browser fetch a
fresh token immediately before every WebSocket connect.

Worker route (composes into the standard broker; parent key is a wrangler
secret):

```ts
import { mintScribeToken } from "@habemus-papadum/cf-creds-elevenlabs";

if (url.pathname === `${base}/elevenlabs`) {
  const creds = await mintScribeToken(env.ELEVENLABS_API_KEY);
  return Response.json(creds, { headers });
}
```

Browser, one call per connection. Against a well-known credentials service
the page names **itself** — its `key` — and the broker resolves the rest:

```ts
import { connectUrl } from "@habemus-papadum/cf-creds-elevenlabs";

const ws = new WebSocket(
  await connectUrl(
    { base: "https://creds.example.com", key: "scratch" },
    { audioFormat: "pcm_24000", includeTimestamps: true },
  ),
);
// first inbound frame on success: {"message_type":"session_started",…}
```

`connectUrl` and `fetchScribeToken` both still take a bare URL string in
place of the broker options — `connectUrl("/api/credentials/elevenlabs")` is
the same-origin route, unchanged.

Facts baked in from live probing: mint is
`POST /v1/single-use-token/realtime_scribe` with `xi-api-key`; the token type
*is* the scope; TTL is fixed at 900s (no parameter exists); the `token` query
parameter replaces the header at connect; a reused token gets
`{"message_type":"auth_error",…}`.
