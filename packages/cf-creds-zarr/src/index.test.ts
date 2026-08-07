import { describe, expect, it } from "vitest";

import { SignedRangeReader } from "./index.js";

const object = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

const fakeFetch = (log: string[]) => async (_input: string | Request, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const range = new Headers(init?.headers).get("range");
  log.push(`${method}${range ? ` ${range}` : ""}`);
  if (method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { "content-length": String(object.length) },
    });
  }
  const match = /bytes=(\d+)-(\d+)/.exec(range ?? "");
  if (!match) return new Response(object, { status: 200 });
  const [start, end] = [Number(match[1]), Number(match[2])];
  return new Response(object.slice(start, end + 1), { status: 206 });
};

describe("SignedRangeReader", () => {
  it("caches the length from one HEAD", async () => {
    const log: string[] = [];
    const reader = new SignedRangeReader("https://x/archive.zip", fakeFetch(log));
    expect(await reader.getLength()).toBe(64);
    expect(await reader.getLength()).toBe(64);
    expect(log).toEqual(["HEAD"]);
  });

  it("reads exact ranges", async () => {
    const reader = new SignedRangeReader("https://x/archive.zip", fakeFetch([]));
    expect([...(await reader.read(8, 4))]).toEqual([8, 9, 10, 11]);
    expect(await reader.read(0, 0)).toHaveLength(0);
  });

  it("refuses a 200 where a 206 was required", async () => {
    const fullDownload = async () => new Response(object, { status: 200 });
    const reader = new SignedRangeReader("https://x/archive.zip", fullDownload);
    await expect(reader.read(0, 4)).rejects.toThrow(/expected 206/);
  });
});
