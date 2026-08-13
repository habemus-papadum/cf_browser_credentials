import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccessLoginRequired,
  CredentialManager,
  type EphemeralCredential,
  fetchCredentials,
} from "./index.js";

interface AwsCredentials extends EphemeralCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

const creds = (id: string, expiresInMs: number): AwsCredentials => ({
  accessKeyId: id,
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: new Date(Date.now() + expiresInMs).toISOString(),
});

function stubFetch(responses: AwsCredentials[]) {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return () => calls;
}

describe("CredentialManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fetches once and serves from cache while fresh", async () => {
    const calls = stubFetch([creds("AKID1", 60 * 60 * 1000)]);
    const manager = new CredentialManager<AwsCredentials>({ url: "/api/credentials/aws" });
    expect((await manager.get()).accessKeyId).toBe("AKID1");
    expect((await manager.get()).accessKeyId).toBe("AKID1");
    expect(calls()).toBe(1);
  });

  it("deduplicates concurrent refreshes", async () => {
    const calls = stubFetch([creds("AKID1", 60 * 60 * 1000)]);
    const manager = new CredentialManager<AwsCredentials>({ url: "/api/credentials/aws" });
    await Promise.all([manager.get(), manager.get(), manager.get()]);
    expect(calls()).toBe(1);
  });

  it("refreshes when within the margin", async () => {
    const calls = stubFetch([
      creds("AKID1", 5 * 60 * 1000), // inside the default 10-minute margin
      creds("AKID2", 60 * 60 * 1000),
    ]);
    const manager = new CredentialManager<AwsCredentials>({ url: "/api/credentials/aws" });
    expect((await manager.get()).accessKeyId).toBe("AKID1");
    expect((await manager.get()).accessKeyId).toBe("AKID2");
    expect(calls()).toBe(2);
  });

  it("notifies rotation listeners, and unsubscribe works", async () => {
    stubFetch([creds("AKID1", 60 * 60 * 1000)]);
    const manager = new CredentialManager<AwsCredentials>({ url: "/api/credentials/aws" });
    const seen: string[] = [];
    const off = manager.onRotate((c) => seen.push(c.accessKeyId));
    await manager.get();
    off();
    await manager.refresh();
    expect(seen).toEqual(["AKID1"]);
  });

  it("surfaces the endpoint's failure body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no Cloudflare Access identity", { status: 401 })),
    );
    const manager = new CredentialManager<AwsCredentials>({ url: "/api/credentials/aws" });
    await expect(manager.get()).rejects.toThrow(/401.*no Cloudflare Access identity/s);
  });
});

describe("fetchCredentials login bounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A browser-shaped page origin: bounce auto-enables for cross-origin URLs.
    vi.stubGlobal("location", new URL("https://app.example.com/"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens a login window on cross-origin auth failure, then retries", async () => {
    const close = vi.fn();
    const open = vi.fn(() => ({ close, closed: false }));
    vi.stubGlobal("window", { open });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        // First fetch: the CORS-shaped failure Access produces for a
        // background request with no cookie. After the "login": success.
        if (calls === 1) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ minted: true }), { status: 200 });
      }),
    );
    const pending = fetchCredentials("https://creds.example.com/api/credentials/aws");
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect((await res.json()).minted).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
  });

  it("throws AccessLoginRequired when the popup is blocked", async () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      fetchCredentials("https://creds.example.com/api/credentials/aws"),
    ).rejects.toBeInstanceOf(AccessLoginRequired);
  });

  it("does not bounce same-origin failures", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(fetchCredentials("/api/credentials/aws")).rejects.toThrow(/401: nope/);
    expect(open).not.toHaveBeenCalled();
  });
});
