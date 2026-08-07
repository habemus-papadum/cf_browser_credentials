# @habemus-papadum/cf-creds-worker

Server-side mint kit for a credential-broker worker: STS `AssumeRole` over
plain fetch (via aws4fetch), runtime-agnostic — workerd and Node alike.

This is a kit, not a framework: routes, env names, and auth tripwires are
deployment configuration, so the worker itself stays a small composition
root that each deployment owns. The canonical one, for a broker behind
Cloudflare Access:

```ts
import { corsHeadersFor } from "@habemus-papadum/cf-loopback-cors";
import { assumeRole } from "@habemus-papadum/cf-creds-worker";

interface Env {
  AWS_ACCESS_KEY_ID: string;      // wrangler secret: the broker user's key
  AWS_SECRET_ACCESS_KEY: string;  // wrangler secret
  BROWSER_ROLE_ARN: string;       // var
  SESSION_SECONDS?: string;       // var
  BASE_PATH?: string;             // var, e.g. "/api/credentials"
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeadersFor(request.headers.get("origin")) ?? {};
    const headers = { ...cors, "cache-control": "no-store, private" };
    const base = (env.BASE_PATH ?? "/api/credentials").replace(/\/+$/, "");
    if (url.pathname !== `${base}/aws`) {
      return Response.json({ error: "not found" }, { status: 404, headers });
    }
    // Tripwire: this worker must only ever be reachable through Access.
    if (!request.headers.get("cf-access-jwt-assertion")) {
      return new Response("no Cloudflare Access identity on request", { status: 401, headers });
    }
    const creds = await assumeRole(
      { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
      env.BROWSER_ROLE_ARN,
      Number(env.SESSION_SECONDS ?? 7200),
    );
    return Response.json(creds, { headers });
  },
};
```

Deployment notes that keep the gate honest: disable `workers_dev` and
`preview_urls` (anything reachable off-route bypasses Access), and scope the
worker's route to the credential path only so it stays a pure broker.

Adding providers is adding routes: each `/api/credentials/<name>` returns its
own envelope, and the one contract every envelope must honour is an
`expiration` field (ISO-8601) — that is what the browser-side manager
schedules refresh against. A vendor-key provider (e.g. ElevenLabs) is a route
that calls the vendor's ephemeral-token API with a wrangler-secret key and
returns `{ …vendorFields, expiration }`.
