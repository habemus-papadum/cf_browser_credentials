import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AwsCredentials,
  awsCredentialsUrl,
  createAwsCredentialManager,
  createSignedFetch,
  listObjects,
} from "./index.js";

const manager = (sessionToken: string, region?: string) =>
  ({
    get: async () => ({
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      sessionToken,
      region,
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

  it("signs with the region the envelope carries when none is passed", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const signed = createSignedFetch(manager("tok", "eu-west-2"));
    await signed("https://bucket.s3.eu-west-2.amazonaws.com/key");

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.headers.get("authorization")).toMatch(/\/eu-west-2\/s3\/aws4_request/);
  });

  it("lets an explicit region override the envelope's", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const signed = createSignedFetch(manager("tok", "eu-west-2"), { region: "us-east-1" });
    await signed("https://bucket.s3.us-east-1.amazonaws.com/key");

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.headers.get("authorization")).toMatch(/\/us-east-1\/s3\/aws4_request/);
  });

  it("says so when neither the caller nor the envelope names a region", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const signed = createSignedFetch(manager("tok"));
    await expect(signed("https://bucket.s3.amazonaws.com/key")).rejects.toThrow(/no region/);
  });
});

describe("createAwsCredentialManager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds the well-known service URL from base and key", () => {
    expect(awsCredentialsUrl("https://creds.example.com", { key: "scratch" })).toBe(
      "https://creds.example.com/api/credentials/aws?key=scratch",
    );
  });

  it("builds the well-known service URL from base and role", () => {
    expect(awsCredentialsUrl("https://creds.example.com", "smoke")).toBe(
      "https://creds.example.com/api/credentials/aws?role=smoke",
    );
    expect(awsCredentialsUrl("https://creds.example.com", { role: "smoke" })).toBe(
      "https://creds.example.com/api/credentials/aws?role=smoke",
    );
  });

  it("throws when a target is given without base", () => {
    expect(() => createAwsCredentialManager({ role: "smoke" })).toThrow(/role requires base/);
    expect(() => createAwsCredentialManager({ key: "scratch" })).toThrow(/key requires base/);
  });

  it("throws when key and role are given together", () => {
    expect(() =>
      createAwsCredentialManager({
        base: "https://creds.example.com",
        key: "scratch",
        role: "smoke",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("fetches the keyed route, region included", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessKeyId: "AKID",
            secretAccessKey: "secret",
            sessionToken: "tok",
            region: "us-east-1",
            expiration: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const creds = await createAwsCredentialManager({
      base: "https://creds.example.com",
      key: "scratch",
    }).get();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://creds.example.com/api/credentials/aws?key=scratch",
    );
    expect(creds.region).toBe("us-east-1");
  });

  it("surfaces the broker's refusal of an unknown key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "no aws grant for key: nope" }), { status: 404 }),
      ),
    );

    await expect(
      createAwsCredentialManager({ base: "https://creds.example.com", key: "nope" }).get(),
    ).rejects.toThrow(/404.*no aws grant for key: nope/s);
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
