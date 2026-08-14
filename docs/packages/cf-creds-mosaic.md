# @habemus-papadum/cf-creds-mosaic

Credential-aware Mosaic connector: every query — including the SQL Mosaic
generates on its own for chart initialization, brushes, and linked selections
— first ensures the manager's current credentials are installed in
DuckDB-Wasm. DuckDB stores credential *strings*, not a provider callback, so
rotation means re-installing; views survive rotation because they store S3
paths, not credentials.

Peer: `@uwdata/mosaic-core`.

## Browser walkthrough — crossfilter over private parquet

```ts
import * as vg from "@uwdata/vgplot";
import { DuckDBWASMConnector, Selection, coordinator } from "@uwdata/vgplot";
import { createAwsCredentialManager, createSignedFetch, listObjects } from "@habemus-papadum/cf-creds-aws";
import { credentialAwareConnector } from "@habemus-papadum/cf-creds-mosaic";

// The page names only itself; the region arrives with the credentials.
const manager = createAwsCredentialManager({
  base: "https://creds.example.com",
  key: "scratch",
});

// Wrap Mosaic's connector; the credential check now guards ALL queries.
const base = new DuckDBWASMConnector({ duckdb: db, connection });
const connector = credentialAwareConnector(base, manager, {
  onInstall: (mode) => console.log(`credentials installed via ${mode}`),
});
coordinator().databaseConnector(connector);

// Multi-file view: list with the SDK, read with DuckDB (S3 globbing is not
// supported by duckdb-wasm — ListObjectsV2 is the reliable path).
const signedFetch = createSignedFetch(manager);
const endpoint = "https://bucket.s3.us-east-1.amazonaws.com";
const keys = await listObjects(signedFetch, endpoint, "taxi/yellow/");
const files = keys.map((k) => `'s3://bucket/${k}'`).join(", ");
await connector.query({
  type: "exec",
  sql: `CREATE OR REPLACE VIEW trips AS
        SELECT * FROM read_parquet([${files}], union_by_name = true, hive_partitioning = true)`,
});

// Linked histograms with one crossfilter selection; every brush gesture is
// Mosaic-generated SQL through the credential-aware connector.
const $filter = Selection.crossfilter();
const histogram = (column: string) =>
  vg.plot(
    vg.rectY(vg.from("trips", { filterBy: $filter }), {
      x: vg.bin(column), y: vg.count(), fill: "steelblue", inset: 0.5,
    }),
    vg.intervalX({ as: $filter }),
    vg.width(680), vg.height(140),
  );
document.querySelector("#app")!.append(
  vg.vconcat(histogram("hour"), histogram("trip_distance"), histogram("fare_amount")),
);
```

## Behaviour notes, measured

- Install prefers `CREATE OR REPLACE SECRET` and falls back to `SET s3_*`
  (current duckdb-wasm builds reject the former); `onInstall` reports which.
- **The region installs alongside the keys**, resolved per install from the
  credentials being installed — so a rotation that moves buckets stays
  honest. `options.region` overrides it for a broker that returns none (an
  older route, or a bucket elsewhere); with neither, the install fails loudly
  rather than signing for the wrong region. The pre-key-contract signature
  `credentialAwareConnector(base, manager, "us-east-1", options)` still works
  and is deprecated.
- **Traffic reality** (duckdb-wasm ≤ 1.33): the S3 layer downloads whole
  objects on first touch — no column-pruned range reads, even for a
  single-column aggregate — then serves everything from its filesystem
  cache. A crossfilter brush over ~10M remote rows costs a handful of
  requests and ~zero bytes. Budget one full read per file per session;
  interactivity is free after that.
- First `read_parquet` fetches a ~3 MB parquet extension from
  `extensions.duckdb.org` at runtime — a third-party CDN dependency to be
  aware of.
- `forceRefresh` exists for rotation torture-testing: mint on every query,
  re-install on every key change, views keep answering.
