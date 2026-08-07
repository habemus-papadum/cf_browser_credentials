# The pattern

A static site does real work directly against cloud services — S3 range
reads, DuckDB queries, realtime AI sessions — **from the browser**, using
short-lived credentials minted by a tiny Cloudflare Worker. No backend serves
data; no long-lived secret ever reaches a client.

```
Browser (static site, hosted on R2)
  │  cookie (Cloudflare Access — Google login in front of everything)
  ▼
Credential worker (same origin, /api/credentials/*)
  │  one route per provider, each holding its own upstream secret
  ▼
{ …providerFields, expiration }   ← the only universal contract
  │
  ▼
Browser talks to S3 / OpenAI / ElevenLabs directly — signed requests,
federated exchanges, single-use tokens. The worker is never on the data path.
```

## The parts

- **One origin.** The static site lives in R2 (served by its own catch-all
  worker or any other means); the credential worker claims only
  `/api/credentials/*` on the same hostname. Path routes beat the custom
  domain, so the two deploy independently.
- **Cloudflare Access is the entire auth story.** Access (with your IdP)
  gates the hostname and sets a cookie; the worker trusts that cookie
  completely and never inspects identity claims. This is deliberately a
  **single-user posture** — one person who trusts themselves, minting
  credentials to reduce friction, not a multi-tenant system. The worker's
  only defensive move is a tripwire: 401 when the Access JWT header is
  missing, which would mean it's reachable around the gate.
- **Providers are routes.** `/api/credentials/aws` returns STS role
  credentials; `/api/credentials/elevenlabs` returns a single-use realtime
  token; each route holds its own upstream secret as a wrangler secret. The
  one contract every response honours: an ISO-8601 `expiration` field.
- **Dev is the deployed worker, cross-origin.** A dev server on any
  localhost port calls the production broker with the Access cookie riding
  along (`credentials: "include"`); the worker echoes loopback origins only
  (see `cf-loopback-cors`). No local stubs, no proxies, no per-port config.

## Three credential species

The packages split along how the credential *behaves*, which turned out to
matter more than which vendor issues it:

| Species | Behaviour | Client model | Example |
|---|---|---|---|
| **Session credential** | Valid for hours, reusable | `CredentialManager`: cache, refresh before expiry, notify on rotation | AWS STS role creds |
| **Federated exchange** | Browser holds one credential, derives another | Provider callback the consuming SDK re-invokes | OpenAI workload identity |
| **Single-use token** | Consumed at first use | Fetch immediately before each connection — never cache | ElevenLabs realtime |

The core `CredentialManager` is generic over the envelope and implements the
first species; the OpenAI package chains off it for the second; the
ElevenLabs package deliberately bypasses it for the third.

## Package map

| Package | Role |
|---|---|
| [cf-browser-credentials](/packages/cf-browser-credentials) | generic in-browser credential manager |
| [cf-creds-worker](/packages/cf-creds-worker) | worker-side mint kit (STS AssumeRole) + the canonical broker |
| [cf-loopback-cors](/packages/cf-loopback-cors) | loopback-only CORS echo for the cross-origin dev flow |
| [cf-creds-aws](/packages/cf-creds-aws) | AWS envelope, typed manager, SigV4 signed fetch, ListObjectsV2 |
| [cf-creds-openai](/packages/cf-creds-openai) | keyless OpenAI via AWS workload identity federation |
| [cf-creds-elevenlabs](/packages/cf-creds-elevenlabs) | single-use realtime tokens |
| [cf-creds-mosaic](/packages/cf-creds-mosaic) | credential-aware Mosaic/DuckDB-Wasm connector |
| [cf-creds-zarr](/packages/cf-creds-zarr) | signed range reads for zarr stores |
