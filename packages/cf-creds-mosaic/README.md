# @habemus-papadum/cf-creds-mosaic

Credential-aware Mosaic connector: every query — including the SQL Mosaic
generates on its own for brushes, linked selections, and chart initialization
— first ensures the manager's current credentials are installed in
DuckDB-Wasm. DuckDB stores credential *strings*, not a provider callback, so
rotation means re-installing `s3_*` state; views survive rotation because
they store S3 paths, not credentials.

Peer: `@uwdata/mosaic-core`.

```ts
import { DuckDBWASMConnector, coordinator } from "@uwdata/vgplot";
import { createAwsCredentialManager } from "@habemus-papadum/cf-creds-aws";
import { credentialAwareConnector } from "@habemus-papadum/cf-creds-mosaic";

const manager = createAwsCredentialManager({
  base: "https://creds.example.com",
  key: "scratch", // this site's own name at the service
});
const base = new DuckDBWASMConnector({ duckdb: db, connection });
const connector = credentialAwareConnector(base, manager, {
  onInstall: (mode, creds) => console.log(`installed via ${mode}`, creds.accessKeyId),
});
coordinator().databaseConnector(connector);
```

The region installs alongside the keys. Under the key contract it rides in
the envelope, so nothing above names one; each install takes the region
belonging to the credentials it is installing, which keeps a rotation that
moves buckets honest. Pass `options.region` when the broker returns none (an
older route, or a bucket elsewhere) — an explicit value always wins, and with
neither the install fails loudly rather than signing for the wrong region.

Install prefers `CREATE OR REPLACE SECRET` and falls back to `SET s3_*`
(current duckdb-wasm builds reject the former); `onInstall` reports which
mode resolved. `forceRefresh` exists for rotation torture-testing.

The pre-key-contract signature — `credentialAwareConnector(base, manager,
"us-east-1", options)`, with the region as a third positional — still works
and is deprecated; move that value to `options.region`, or drop it.

Traffic reality, measured (duckdb-wasm ≤ 1.33): the S3 layer downloads whole
objects on first touch — no column-pruned range reads — then serves
everything from its filesystem cache, so a crossfilter brush over millions of
remote rows costs a handful of requests and ~zero bytes. Budget one full read
per file per session and interactivity is free after that.
