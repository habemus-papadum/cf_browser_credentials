# @habemus-papadum/cf-creds-zarr

Signed range reads for zarr-over-S3, in two proven arms:

**Directory tree** — hand the signed fetch straight to zarrita's `FetchStore`;
one signed GET per chunk:

```ts
import * as zarr from "zarrita";
import { createSignedFetch } from "@habemus-papadum/cf-creds-aws";

const signedFetch = createSignedFetch(manager, { region: "us-east-1" });
const store = new zarr.FetchStore("https://bucket.s3.us-east-1.amazonaws.com/data.zarr", {
  fetch: signedFetch,
});
```

**Zip archive** — wrap the archive URL in `SignedRangeReader` and hand it to
`ZipFileStore`; a chunk costs two ranged reads (zip local header, then
payload), and the reader refuses a 200 where a 206 was required — silently
downloading the whole archive to read one chunk is treated as a bug:

```ts
import ZipFileStore from "@zarrita/storage/zip";
import { SignedRangeReader } from "@habemus-papadum/cf-creds-zarr";

const store = new ZipFileStore(
  new SignedRangeReader("https://bucket.s3.us-east-1.amazonaws.com/data.zarr.zip", signedFetch),
);
```

The Reader interface is structural, so this package imports nothing from the
zarr ecosystem; it composes with anything expecting `getLength()`/`read()`.
