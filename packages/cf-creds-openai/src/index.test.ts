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

  it("builds a client from nothing but the site's grant path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(bundle()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createBrokeredOpenAI } = await import("./index.js");

    const { client, manager } = await createBrokeredOpenAI({
      base: "https://creds.example.com",
      grantPath: "research",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://creds.example.com/api/credentials/openai?grant_path=research",
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

    await createBrokeredOpenAI({ base: "https://creds.example.com", grantPath: "research" });
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

    await createBrokeredOpenAI({ base: "https://creds.example.com", grantPath: "research" });
    const { workloadIdentity } = constructed[0] as Constructed;

    expect(await workloadIdentity.provider.getToken()).toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("schedules no background refresh — the SDK asks when it needs one", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(bundle()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createBrokeredOpenAI } = await import("./index.js");

    await createBrokeredOpenAI({ base: "https://creds.example.com", grantPath: "research" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the broker's 400 when no grant path is sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "grant path required" }), { status: 400 }),
      ),
    );
    const { createBrokeredOpenAI } = await import("./index.js");

    await expect(createBrokeredOpenAI({ url: "/api/credentials/openai" })).rejects.toThrow(
      /400.*grant path required/s,
    );
  });

  it("surfaces the broker's 404 for a grant path with no openai grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "no openai grant for path: artifacts" }), {
            status: 404,
          }),
      ),
    );
    const { createBrokeredOpenAI } = await import("./index.js");

    await expect(
      createBrokeredOpenAI({ base: "https://creds.example.com", grantPath: "artifacts" }),
    ).rejects.toThrow(/404.*no openai grant for path: artifacts/s);
  });

  it("refuses a grant path and a legacy role together", async () => {
    const { createBrokeredOpenAI } = await import("./index.js");
    await expect(
      createBrokeredOpenAI({
        base: "https://creds.example.com",
        grantPath: "research",
        role: "smoke",
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe("openaiCredentialsUrl", () => {
  it("names the site, not the grant", async () => {
    const { openaiCredentialsUrl } = await import("./index.js");
    expect(openaiCredentialsUrl("https://creds.example.com", { grantPath: "research" })).toBe(
      "https://creds.example.com/api/credentials/openai?grant_path=research",
    );
  });
});

describe("createOpenAIFromSource", () => {
  beforeEach(() => {
    constructed.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses an injected source without a broker request or background timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let value = bundle();
    const source = { get: vi.fn(async () => value) };
    const { createOpenAIFromSource } = await import("./index.js");
    await createOpenAIFromSource(source);
    const { workloadIdentity } = constructed[0] as Constructed;
    expect(workloadIdentity.identityProviderId).toBe(value.identityProviderId);
    expect(workloadIdentity.serviceAccountId).toBe(value.serviceAccountId);
    expect(await workloadIdentity.provider.getToken()).toBe(value.identityToken);

    value = bundle({ identityToken: "rotated-token" });
    expect(await workloadIdentity.provider.getToken()).toBe("rotated-token");
    const calls = source.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(source.get).toHaveBeenCalledTimes(calls);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["audience", "identityProviderId", "serviceAccountId"])(
    "rejects a changed %s on renewal without exposing its value",
    async (field) => {
      const value = bundle();
      const source = { get: async () => value };
      const { createOpenAIFromSource } = await import("./index.js");
      await createOpenAIFromSource(source);
      // Mutate the same source object to prove the initial coordinates were
      // copied rather than retained through a mutable bundle reference.
      Object.assign(value, { [field]: "sensitive-target-sentinel" });
      const { workloadIdentity } = constructed[0] as Constructed;

      await expect(workloadIdentity.provider.getToken()).rejects.toThrow(
        "OpenAI credential target changed; create a new client.",
      );
      await expect(workloadIdentity.provider.getToken()).rejects.not.toThrow(
        "sensitive-target-sentinel",
      );
    },
  );

  it("does not substitute broker credentials if the injected source refuses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createOpenAIFromSource } = await import("./index.js");
    await expect(
      createOpenAIFromSource({
        async get() {
          throw new Error("source unavailable");
        },
      }),
    ).rejects.toThrow("source unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(0);
  });
});
