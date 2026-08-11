# @habemus-papadum/cf-creds-worker

Server-side mint kit for a credential-broker worker: STS `AssumeRole` over
plain fetch (via aws4fetch), Cloudflare Access identity verification, a
pluggable mint policy, and a structured mint log. Runtime-agnostic — workerd
and Node alike.

This is a kit, not a framework: routes, env names, and policy are deployment
configuration, so the worker itself stays a small composition root that each
deployment owns.

The posture is **attribution before authorization**. The worker verifies the
Access JWT on every request — signature against the team's published keys,
not mere header presence — and threads the verified identity (a user's
email, or a service token's client id) through the mint policy, into the
mint log, and into the credential itself: the AWS `RoleSessionName` *is* the
identity, so every API call made with the minted credentials attributes to a
person in CloudTrail. The shipped policy is `allowAll` — anyone Access
admits gets the standard grant, preserving the high-trust default.
Restricting or shaping per identity (a scoped-down role for an agent's
service token, a shorter TTL) is a policy you write the day a lane needs
one, not ceremony installed in advance.

The canonical composition, for a broker behind Cloudflare Access:

```ts
import { corsHeadersFor } from "@habemus-papadum/cf-loopback-cors";
import {
  type AccessIdentity,
  allowAll,
  assumeRole,
  logMint,
  sessionNameFor,
  verifyAccessIdentity,
} from "@habemus-papadum/cf-creds-worker";

interface Env {
  AWS_ACCESS_KEY_ID: string;      // wrangler secret: the broker user's key
  AWS_SECRET_ACCESS_KEY: string;  // wrangler secret
  BROWSER_ROLE_ARN: string;       // var
  ACCESS_TEAM_DOMAIN: string;     // var, e.g. "example.cloudflareaccess.com"
  ACCESS_APP_AUD?: string;        // var: the Access app's AUD tag (recommended)
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

    // Access already gated the hostname; verifying its JWT keeps the gate
    // honest against misconfiguration and names the caller.
    let identity: AccessIdentity;
    try {
      identity = await verifyAccessIdentity(request, {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_APP_AUD,
      });
    } catch (err) {
      logMint({ provider: "aws", outcome: "denied", identity: null, reason: String(err), request });
      return new Response("no valid Cloudflare Access identity", { status: 401, headers });
    }

    // The default posture: everyone Access admits gets the standard grant.
    const policy = allowAll({
      roleArn: env.BROWSER_ROLE_ARN,
      durationSeconds: Number(env.SESSION_SECONDS ?? 7200),
    });
    const decision = await policy({ identity, provider: "aws", request });
    if (!decision.allow) {
      logMint({ provider: "aws", outcome: "denied", identity, reason: decision.reason, request });
      return Response.json({ error: decision.reason }, { status: decision.status ?? 403, headers });
    }

    const creds = await assumeRole(
      { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
      decision.grant.roleArn,
      decision.grant.durationSeconds,
      { sessionName: sessionNameFor(identity) }, // CloudTrail attribution
    );
    logMint({
      provider: "aws",
      outcome: "allowed",
      identity,
      grant: decision.grant,
      expiration: creds.expiration,
      request,
    });
    return Response.json(creds, { headers });
  },
};
```

Deployment notes that keep the gate honest: disable `workers_dev` and
`preview_urls` (anything reachable off-route bypasses Access), and scope the
worker's route to the credential path only so it stays a pure broker.
`ACCESS_TEAM_DOMAIN` is the Zero Trust team domain the JWT's issuer and
JWKS are derived from; `ACCESS_APP_AUD` (recommended) additionally pins the
JWT to this Access app's AUD tag. The team's signing keys are cached in the
isolate and refreshed on rotation.

To land mint events in Cloudflare's logging infrastructure, enable Workers
Logs in the worker's wrangler config — `logMint` emits one JSON line per
attempt (allowed and denied alike), and Workers Logs indexes the fields for
query; Logpush is the incremental step if retention beyond days is needed:

```jsonc
{ "observability": { "enabled": true } }
```

Session tags (`assumeRole`'s `tags` option) additionally require
`sts:TagSession` in the browser role's trust policy; the session name alone
needs nothing extra.

Adding providers is adding routes: each `/api/credentials/<name>` returns
its own envelope, and the one contract every envelope must honour is an
`expiration` field (ISO-8601) — that is what the browser-side manager
schedules refresh against. A vendor-key provider (e.g. ElevenLabs) is a
route that calls the vendor's ephemeral-token API with a wrangler-secret key
and returns `{ …vendorFields, expiration }`. Give every route the same
treatment: verify once, consult the policy under its provider key, log the
outcome.
