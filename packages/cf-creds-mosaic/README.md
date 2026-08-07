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

const manager = createAwsCredentialManager();
const base = new DuckDBWASMConnector({ duckdb: db, connection });
const connector = credentialAwareConnector(base, manager, "us-east-1", {
  onInstall: (mode, creds) => console.log(`installed via ${mode}`, creds.accessKeyId),
});
coordinator().databaseConnector(connector);
```

Install prefers `CREATE OR REPLACE SECRET` and falls back to `SET s3_*`
(current duckdb-wasm builds reject the former); `onInstall` reports which
mode resolved. `forceRefresh` exists for rotation torture-testing.

Traffic reality, measured (duckdb-wasm ≤ 1.33): the S3 layer downloads whole
objects on first touch — no column-pruned range reads — then serves
everything from its filesystem cache, so a crossfilter brush over millions of
remote rows costs a handful of requests and ~zero bytes. Budget one full read
per file per session and interactivity is free after that.
