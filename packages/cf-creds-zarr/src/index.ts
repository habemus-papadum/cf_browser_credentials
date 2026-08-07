/**
 * Signed range reads for zarr-over-S3.
 *
 * Two proven arms for reading a zarr archive from a private bucket with a
 * {@link SignedFetch}:
 *
 * - **directory tree** — pass the signed fetch straight to zarrita's
 *   `FetchStore` as its custom `fetch` option; one signed GET per chunk.
 * - **zip archive** — wrap the archive URL in {@link SignedRangeReader} and
 *   hand it to `ZipFileStore` (its Reader interface is structural, so this
 *   package needs no zarr imports); a chunk costs two ranged reads (zip
 *   local header, then payload).
 *
 * @packageDocumentation
 */

import type { SignedFetch } from "@habemus-papadum/cf-creds-aws";

/**
 * A Reader over one remote object that signs every range read — the shape
 * `ZipFileStore` (via unzipit) expects. Refuses a 200 on a range request:
 * that would mean the whole archive came down to read one chunk.
 */
export class SignedRangeReader {
  #url: string;
  #fetch: SignedFetch;
  #length: number | undefined;

  constructor(url: string, signedFetch: SignedFetch) {
    this.#url = url;
    this.#fetch = signedFetch;
  }

  async getLength(): Promise<number> {
    if (this.#length === undefined) {
      const res = await this.#fetch(this.#url, { method: "HEAD" });
      if (!res.ok) throw new Error(`HEAD ${this.#url}: ${res.status}`);
      const len = res.headers.get("content-length");
      if (!len) throw new Error("HEAD returned no content-length");
      this.#length = Number(len);
    }
    return this.#length;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    const res = await this.#fetch(this.#url, {
      headers: { range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (res.status !== 206) {
      throw new Error(`expected 206 for range read, got ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
