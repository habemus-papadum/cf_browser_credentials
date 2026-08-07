import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialManager, type EphemeralCredential } from "./index.js";

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
