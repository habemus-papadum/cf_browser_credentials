import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AwsCredentials, createSignedFetch, listObjects } from "./index.js";

const manager = (sessionToken: string) =>
  ({
    get: async () => ({
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      sessionToken,
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  }) as unknown as CredentialManager<AwsCredentials>;

describe("createSignedFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs requests and reports responses", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const seen: number[] = [];
    const signed = createSignedFetch(manager("tok"), {
      region: "us-east-1",
      onResponse: (res) => seen.push(res.status),
    });

    const res = await signed("https://bucket.s3.us-east-1.amazonaws.com/key");

    expect(res.status).toBe(200);
    expect(seen).toEqual([200]);
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.headers.get("authorization")).toMatch(/AWS4-HMAC-SHA256/);
    expect(request.headers.get("x-amz-security-token")).toBe("tok");
  });
});

const PAGE = (keys: string[], next?: string) =>
  `<ListBucketResult>${keys
    .map((k) => `<Contents><Key>${k}</Key></Contents>`)
    .join(
      "",
    )}${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;

describe("listObjects", () => {
  it("follows continuation tokens", async () => {
    const pages = [PAGE(["a.parquet"], "tok2"), PAGE(["b.parquet"])];
    let call = 0;
    const signed = async () => new Response(pages[call++], { status: 200 });

    const keys = await listObjects(signed, "https://bucket.example", "data/");

    expect(keys).toEqual(["a.parquet", "b.parquet"]);
    expect(call).toBe(2);
  });
});
