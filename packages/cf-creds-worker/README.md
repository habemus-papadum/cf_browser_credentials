# @habemus-papadum/cf-creds-worker

Credential service helpers for a credential-broker worker: STS `AssumeRole` over
plain fetch (via aws4fetch), Cloudflare Access identity verification, a
pluggable credential policy, and a structured request log. Runtime-agnostic — workerd
and Node alike.

This is a kit, not a framework: routes, env names, and policy are deployment
configuration, so the worker itself stays a small composition root that each
deployment owns.

The worker verifies the Access JWT signature against the team's published
signing keys. It passes the verified identity to the credential policy and
records it in request logs. AWS session names include the identity for
CloudTrail attribution. `allowAll()` returns the deployment's standard grant
for every authenticated caller. Supply another policy when callers need
different permissions, roles, or token lifetimes.

The canonical composition, for a broker behind Cloudflare Access:

```ts
import { corsHeadersFor } from "@habemus-papadum/cf-loopback-cors";
import {
  type AccessIdentity,
  allowAll,
  assumeRole,
  logCredentialRequest,
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

    // Verify the Access JWT and identify the caller.
    let identity: AccessIdentity;
    try {
      identity = await verifyAccessIdentity(request, {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_APP_AUD,
      });
    } catch (err) {
      logCredentialRequest({ provider: "aws", outcome: "denied", identity: null, reason: String(err), request });
      return new Response("no valid Cloudflare Access identity", { status: 401, headers });
    }

    // The default posture: everyone Access admits gets the standard grant.
    const policy = allowAll({
      roleArn: env.BROWSER_ROLE_ARN,
      durationSeconds: Number(env.SESSION_SECONDS ?? 7200),
    });
    const decision = await policy({ identity, provider: "aws", request });
    if (!decision.allow) {
      logCredentialRequest({ provider: "aws", outcome: "denied", identity, reason: decision.reason, request });
      return Response.json({ error: decision.reason }, { status: decision.status ?? 403, headers });
    }

    const creds = await assumeRole(
      { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
      decision.grant.roleArn,
      decision.grant.durationSeconds,
      { sessionName: sessionNameFor(identity) }, // CloudTrail attribution
    );
    logCredentialRequest({
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

Deployment settings: disable `workers_dev` and
`preview_urls` (anything reachable off-route bypasses Access), and scope the
worker's route to the credential path only so it stays a pure broker.
`ACCESS_TEAM_DOMAIN` is the Zero Trust team domain the JWT's issuer and
JWKS are derived from; `ACCESS_APP_AUD` (recommended) additionally pins the
JWT to this Access app's AUD tag. The team's signing keys are cached in the
isolate and refreshed on rotation.

To land credential request events in Cloudflare's logging infrastructure, enable Workers
Logs in the worker's wrangler config — `logCredentialRequest` emits one JSON line per
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
treatment: verify once, consult the policy under its provider name, log the
outcome.

The canonical policy types are `CredentialContext`, `CredentialDecision`, and
`CredentialPolicy`. Logging uses `credentialRequestLogRecord()` or
`logCredentialRequest()`, with event type `credential_request`. The prior
`Mint*` types, `mintLogRecord`, and `logMint` remain deprecated aliases.
