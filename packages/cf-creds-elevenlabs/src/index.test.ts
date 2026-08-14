import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectUrl,
  elevenLabsCredentialsUrl,
  fetchScribeToken,
  mintScribeToken,
  scribeSocketUrl,
} from "./index.js";

describe("mintScribeToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mints with the parent key and stamps the fixed TTL", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "sutkn_abc" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const before = Date.now();
    const creds = await mintScribeToken("parent-key");

    expect(creds.token).toBe("sutkn_abc");
    const ttlMs = Date.parse(creds.expiration) - before;
    expect(ttlMs).toBeGreaterThan(890_000);
    expect(ttlMs).toBeLessThanOrEqual(901_000);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
    expect(new Headers(init.headers).get("xi-api-key")).toBe("parent-key");
  });

  it("surfaces vendor errors with status and body", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing_permissions", { status: 401 }));
    await expect(mintScribeToken("bad")).rejects.toThrow(/401.*missing_permissions/s);
  });
});

describe("fetchScribeToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  const token = () =>
    new Response(JSON.stringify({ token: "sutkn_abc", expiration: new Date().toISOString() }), {
      status: 200,
    });

  it("names the site with its own key at a well-known service", () => {
    expect(elevenLabsCredentialsUrl("https://creds.example.com", { key: "scratch" })).toBe(
      "https://creds.example.com/api/credentials/elevenlabs?key=scratch",
    );
  });

  it("fetches the keyed route from broker options", async () => {
    const fetchMock = vi.fn(async () => token());
    vi.stubGlobal("fetch", fetchMock);

    const creds = await fetchScribeToken({ base: "https://creds.example.com", key: "scratch" });

    expect(creds.token).toBe("sutkn_abc");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://creds.example.com/api/credentials/elevenlabs?key=scratch",
    );
  });

  it("still takes a bare URL, and connectUrl takes broker options too", async () => {
    const fetchMock = vi.fn(async () => token());
    vi.stubGlobal("fetch", fetchMock);

    await fetchScribeToken("/api/credentials/elevenlabs");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/credentials/elevenlabs");

    const url = new URL(await connectUrl({ base: "https://creds.example.com", key: "scratch" }));
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://creds.example.com/api/credentials/elevenlabs?key=scratch",
    );
    expect(url.searchParams.get("token")).toBe("sutkn_abc");
  });

  it("surfaces the broker's refusal of an unknown key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "no elevenlabs grant for key: nope" }), {
            status: 404,
          }),
      ),
    );

    await expect(
      fetchScribeToken({ base: "https://creds.example.com", key: "nope" }),
    ).rejects.toThrow(/404.*no elevenlabs grant for key: nope/s);
  });
});

describe("scribeSocketUrl", () => {
  it("puts the token in the query with sane defaults", () => {
    const url = new URL(scribeSocketUrl("sutkn_abc"));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("token")).toBe("sutkn_abc");
  });

  it("passes audio format and timestamps through", () => {
    const url = new URL(
      scribeSocketUrl("sutkn_abc", { audioFormat: "pcm_24000", includeTimestamps: true }),
    );
    expect(url.searchParams.get("audio_format")).toBe("pcm_24000");
    expect(url.searchParams.get("include_timestamps")).toBe("true");
  });
});
