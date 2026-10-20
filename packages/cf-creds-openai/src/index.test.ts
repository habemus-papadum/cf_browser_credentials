import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openai", () => {
  class OpenAI {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      constructed.push(options);
    }
  }
  return { default: OpenAI };
});

const constructed: Record<string, unknown>[] = [];

const expiresIn = (ms: number) => new Date(Date.now() + ms).toISOString();

// The bundle one keyed openai mint returns: the service-signed subject token
// plus the ids the SDK's exchange names.
const bundle = (overrides: Record<string, unknown> = {}) => ({
  identityToken: "header.payload.signature",
  expiration: expiresIn(300_000),
  audience: "https://api.openai.com/v1",
  identityProviderId: "idp_from_broker",
  serviceAccountId: "user-from-broker",
  ...overrides,
});

type Constructed = {
  workloadIdentity: {
    identityProviderId: string;
    serviceAccountId: string;
    provider: { tokenType: string; getToken: () => Promise<string> };
  };
};

describe("createBrokeredOpenAI", () => {
  beforeEach(() => {
    constructed.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("builds a client from nothing but the site's own key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(bundle()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createBrokeredOpenAI } = await import("./index.js");

    const { client, manager } = await createBrokeredOpenAI({
      base: "https://creds.example.com",
      key: "research",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://creds.example.com/api/credentials/openai?key=research",
    );
    // Every id the SDK is configured with came off the wire, not from here.
    const { workloadIdentity } = constructed[0] as Constructed;
    expect(workloadIdentity.identityProviderId).toBe("idp_from_broker");
    expect(workloadIdentity.serviceAccountId).toBe("user-from-broker");
    expect(workloadIdentity.provider.tokenType).toBe("jwt");
    expect(client).toBeDefined();
    // The manager comes back typed to the bundle, for onRotate and refresh.
    expect((await manager.get()).serviceAccountId).toBe("user-from-broker");
  });

  it("hands the SDK the minted token, and the same one while it is fresh", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return new Response(JSON.stringify(bundle({ identityToken: `token-${n}` })), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createBrokeredOpenAI } = await import("./index.js");

    await createBrokeredOpenAI({ base: "https://creds.example.com", key: "research" });
    const { workloadIdentity } = constructed[0] as Constructed;

    expect(await workloadIdentity.provider.getToken()).toBe("token-1");
    expect(await workloadIdentity.provider.getToken()).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mints afresh when the cached token is near its end", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      // The first token has seconds left — inside the 30 s margin.
      const expiration = expiresIn(n === 1 ? 10_000 : 300_000);
      return new Response(JSON.stringify(bundle({ identityToken: `token-${n}`, expiration })), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createBrokeredOpenAI } = await import("./index.js");

    await createBrokeredOpenAI({ base: "https://creds.example.com", key: "research" });
    const { workloadIdentity } = constructed[0] as Constructed;

    expect(await workloadIdentity.provider.getToken()).toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("schedules no background refresh — the SDK asks when it needs one", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(bundle()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createBrokeredOpenAI } = await import("./index.js");

    await createBrokeredOpenAI({ base: "https://creds.example.com", key: "research" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the broker's 400 when no key is sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "key required" }), { status: 400 })),
    );
    const { createBrokeredOpenAI } = await import("./index.js");

    await expect(createBrokeredOpenAI({ url: "/api/credentials/openai" })).rejects.toThrow(
      /400.*key required/s,
    );
  });

  it("surfaces the broker's 404 for a key with no openai grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "no openai grant for key: artifacts" }), {
            status: 404,
          }),
      ),
    );
    const { createBrokeredOpenAI } = await import("./index.js");

    await expect(
      createBrokeredOpenAI({ base: "https://creds.example.com", key: "artifacts" }),
    ).rejects.toThrow(/404.*no openai grant for key: artifacts/s);
  });

  it("refuses a key and a legacy role together", async () => {
    const { createBrokeredOpenAI } = await import("./index.js");
    await expect(
      createBrokeredOpenAI({ base: "https://creds.example.com", key: "research", role: "smoke" }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe("openaiCredentialsUrl", () => {
  it("names the site, not the grant", async () => {
    const { openaiCredentialsUrl } = await import("./index.js");
    expect(openaiCredentialsUrl("https://creds.example.com", { key: "research" })).toBe(
      "https://creds.example.com/api/credentials/openai?key=research",
    );
  });
});
