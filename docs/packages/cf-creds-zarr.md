# @habemus-papadum/cf-creds-zarr

Signed range reads for zarr-over-S3. Unlike DuckDB-Wasm's S3 layer, zarrita's
stores do honest partial reads — chunk-sized signed GETs and true ranged
requests — so this is the shape browser-compute wants for array data.

## Browser walkthrough — both store arms

```ts
import * as zarr from "zarrita";
import ZipFileStore from "@zarrita/storage/zip";
import { createAwsCredentialManager, createSignedFetch } from "@habemus-papadum/cf-creds-aws";
import { SignedRangeReader } from "@habemus-papadum/cf-creds-zarr";

const manager = createAwsCredentialManager();
const signedFetch = createSignedFetch(manager, {
  region: "us-east-1",
  onResponse: (res) => stats.count(res), // optional traffic accounting
});
const base = "https://bucket.s3.us-east-1.amazonaws.com/archive";

// Arm 1 — directory tree: one signed GET per chunk.
const dirStore = new zarr.FetchStore(`${base}/data.zarr`, { fetch: signedFetch });

// Arm 2 — zip archive: ranged reads into the original .zarr.zip; a chunk
// costs two requests (zip local header, then payload).
const zipStore = new ZipFileStore(
  new SignedRangeReader(`${base}/data.zarr.zip`, signedFetch),
);

const root = await zarr.withConsolidatedMetadata(dirStore, { format: "v3" });
```

`SignedRangeReader` refuses a 200 where a 206 was required — silently
downloading a whole archive to read one chunk is treated as a bug, not a
fallback. Its Reader interface is structural (`getLength()` / `read()`), so
the package imports nothing from the zarr ecosystem and composes with
anything expecting that shape.
