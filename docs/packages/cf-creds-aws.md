# @habemus-papadum/cf-creds-aws

Signed fetch for browsers holding ephemeral AWS credentials: SigV4 request
signing via aws4fetch — the browser signs its own traffic with headers, no
presigned URLs, no data proxy. The signing client is cached per credential
session, so key derivation isn't repeated across thousands of range reads.

Also home to the AWS flavour of the credential pattern: the `AwsCredentials`
envelope the AWS broker route returns, and a typed manager factory defaulting
to the conventional `/api/credentials/aws` route. Pass `base` (and optionally
`role`) to target a well-known credentials service instead — cross-origin
first-touch auth is handled by the login bounce in
`@habemus-papadum/cf-browser-credentials`.

```ts
import {
  createAwsCredentialManager,
  createSignedFetch,
  listObjects,
} from "@habemus-papadum/cf-creds-aws";

const manager = createAwsCredentialManager();
// …or against a well-known credentials service:
// createAwsCredentialManager({ base: "https://creds.example.com", role: "smoke" });
const signedFetch = createSignedFetch(manager, { region: "us-east-1" });

// Plain S3 URLs, signed per request:
const res = await signedFetch("https://bucket.s3.us-east-1.amazonaws.com/key.parquet", {
  headers: { range: "bytes=0-1023" },
});

// ListObjectsV2 with continuation-token pagination:
const keys = await listObjects(signedFetch, "https://bucket.s3.us-east-1.amazonaws.com", "data/");
```

The optional `onResponse` hook observes every response — request counting and
byte accounting for traffic-honest dashboards.
