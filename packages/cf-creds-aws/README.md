# @habemus-papadum/cf-creds-aws

Signed fetch for browsers holding ephemeral AWS credentials: SigV4 request
signing via aws4fetch — the browser signs its own traffic with headers, no
presigned URLs, no data proxy. The signing client is cached per credential
session, so key derivation isn't repeated across thousands of range reads.

Also home to the AWS flavour of the credential pattern: the `AwsCredentials`
envelope the AWS broker route returns, and a typed manager factory defaulting
to the conventional `/api/credentials/aws` route.

Against a well-known credentials service the page names **itself** — its
`key` — and the broker answers with the credentials *and* the region they are
for. No role name, no ARN, no region constant in site code; re-pointing a
site is a broker-side edit. Cross-origin first-touch auth is handled by the
login bounce in `@habemus-papadum/cf-browser-credentials`.

```ts
import {
  createAwsCredentialManager,
  createSignedFetch,
  listObjects,
} from "@habemus-papadum/cf-creds-aws";

const manager = createAwsCredentialManager({
  base: "https://creds.example.com",
  key: "scratch", // this site's own name at the service
});

// The region rides in the envelope, so nothing to pass here:
const signedFetch = createSignedFetch(manager);

// Plain S3 URLs, signed per request:
const res = await signedFetch("https://bucket.s3.us-east-1.amazonaws.com/key.parquet", {
  headers: { range: "bytes=0-1023" },
});

// ListObjectsV2 with continuation-token pagination:
const keys = await listObjects(signedFetch, "https://bucket.s3.us-east-1.amazonaws.com", "data/");
```

`createAwsCredentialManager()` with no arguments still targets the
same-origin `/api/credentials/aws`; `url` overrides the route outright. Pass
`region` to `createSignedFetch` when the broker does not return one (an older
route, or a bucket in another region) — an explicit value always wins.

The optional `onResponse` hook observes every response — request counting and
byte accounting for traffic-honest dashboards.

## Legacy: the `role` lane

Before the key contract, a page named the *grant* it wanted:
`createAwsCredentialManager({ base, role: "smoke" })`, sent as `?role=`.
Brokers still serve it and the option still works, but it leaks an internal
name into site code and returns no region. `key` and `role` are mutually
exclusive; either one requires `base`.
