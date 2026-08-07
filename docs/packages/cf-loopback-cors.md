# @habemus-papadum/cf-loopback-cors

Loopback-only CORS echo for cookie-authenticated endpoints.

The pattern: a static site's dev server runs on `localhost` on an *arbitrary*
port (many dev servers at once — port-walking) and calls the deployed
endpoint cross-origin, authenticated by the cookie that rides along with
`credentials: "include"`. That only works when the endpoint echoes the exact
caller origin — a wildcard cannot be combined with credentials — so this
echoes loopback origins on any port, and nothing else.

Two principles baked in:

- **CORS is never used to reject.** Authentication belongs to the layer in
  front (e.g. Cloudflare Access). A non-loopback origin simply gets no CORS
  headers; same-origin traffic is untouched.
- **Port-independence by construction.** Any `localhost`/`127.0.0.1`/`[::1]`
  port is echoed, so parallel dev servers all work with zero configuration.

```ts
import { corsHeadersFor } from "@habemus-papadum/cf-loopback-cors";

const cors = corsHeadersFor(request.headers.get("origin")) ?? {};
return Response.json(data, { headers: { ...cors, "cache-control": "no-store" } });
```
