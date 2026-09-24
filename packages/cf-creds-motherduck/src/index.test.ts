import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMotherDuckCredentialManager,
  isMotherDuckAuthError,
  type MotherDuckClient,
  type MotherDuckCredentials,
  motherDuckCredentialsUrl,
  motherDuckEngine,
  staticMotherDuckToken,
  type TokenSource,
} from "./index.js";

const envelope = (token: string, ttlMs = 3_600_000): MotherDuckCredentials => ({
  token,
  serviceAccount: "reader",
  expiration: new Date(Date.now() + ttlMs).toISOString(),
});

describe("the route", () => {
  it("names the site with its own key at a well-known service", () => {
    expect(motherDuckCredentialsUrl("https://creds.example.com", { key: "notes" })).toBe(
      "https://creds.example.com/api/credentials/motherduck?key=notes",
    );
  });
});

describe("createMotherDuckCredentialManager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the keyed route once and caches until near expiry", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(envelope("tok_1")), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const manager = createMotherDuckCredentialManager({
      base: "https://creds.example.com",
      key: "notes",
    });
    const first = await manager.get();
    const second = await manager.get();

    expect(first.token).toBe("tok_1");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://creds.example.com/api/credentials/motherduck?key=notes",
    );
  });

  it("surfaces the broker's refusal of an unknown key", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "no motherduck grant for key: nope" }), {
          status: 404,
        }),
    );
    await expect(
      createMotherDuckCredentialManager({ base: "https://creds.example.com", key: "nope" }).get(),
    ).rejects.toThrow(/404.*no motherduck grant for key: nope/s);
  });
});

/** A scripted client: records creates and terminates, hands back inert handles. */
function fakeClient() {
  const creates: Array<Record<string, unknown>> = [];
  let terminates = 0;
  const client: MotherDuckClient = {
    MDConnection: {
      create: (params) => {
        creates.push(params as unknown as Record<string, unknown>);
        return { params } as never;
      },
    },
    getAsyncDuckDb: async () => ({ connect: async () => ({ id: creates.length }) }) as never,
    terminateDuckDB: async () => {
      terminates += 1;
    },
  };
  return { client, creates, terminates: () => terminates };
}

/** A rotating source with a manual `rotate()`. */
function fakeSource(tokens: string[]) {
  let i = 0;
  const listeners = new Set<(c: MotherDuckCredentials) => void>();
  const current = () => envelope(tokens[Math.min(i, tokens.length - 1)]);
  const source: TokenSource = {
    get: async () => current(),
    onRotate: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    source,
    rotate: () => {
      i += 1;
      for (const fn of listeners) fn(current());
    },
  };
}

describe("motherDuckEngine", () => {
  it("builds once, with the source's token and the caller's params, and dedupes ready()", async () => {
    const { client, creates } = fakeClient();
    const { source } = fakeSource(["tok_1"]);
    const engine = motherDuckEngine(
      source,
      { sessionName: "visitor-1", customUserAgent: "app/1" },
      { client },
    );

    expect(engine.generation).toBe(0);
    const [a, b] = await Promise.all([engine.ready(), engine.ready()]);

    expect(a).toBe(b);
    expect(creates).toEqual([
      { sessionName: "visitor-1", customUserAgent: "app/1", mdToken: "tok_1" },
    ]);
    expect(engine.generation).toBe(1);
    expect(a.generation).toBe(1);
    await expect(a.connect()).resolves.toEqual({ id: 1 });
  });

  it("does NOT rebuild on rotation by default — the live session outlives its token", async () => {
    const { client, creates, terminates } = fakeClient();
    const { source, rotate } = fakeSource(["tok_1", "tok_2"]);
    const engine = motherDuckEngine(source, {}, { client });
    const first = await engine.ready();

    rotate();
    await new Promise((r) => setTimeout(r, 0));

    expect(await engine.ready()).toBe(first);
    expect(creates).toHaveLength(1);
    expect(terminates()).toBe(0);
  });

  it("rebuilds on rotation when asked, terminating first and taking the new token", async () => {
    const { client, creates, terminates } = fakeClient();
    const { source, rotate } = fakeSource(["tok_1", "tok_2"]);
    const engine = motherDuckEngine(source, {}, { client, rebuildOnRotate: true });
    const reasons: string[] = [];
    const generations: number[] = [];
    engine.onRebuild((handle, reason) => {
      reasons.push(reason);
      generations.push(handle.generation);
    });
    await engine.ready();

    rotate();
    await vi.waitFor(() => expect(creates).toHaveLength(2));

    expect(terminates()).toBe(1);
    expect(creates[1].mdToken).toBe("tok_2");
    expect(reasons).toEqual(["rotate"]);
    expect(generations).toEqual([2]);
    expect((await engine.ready()).generation).toBe(2);
  });

  it("ignores a rotation before anything was built: the first ready() takes the new token", async () => {
    const { client, creates, terminates } = fakeClient();
    const { source, rotate } = fakeSource(["tok_1", "tok_2"]);
    const engine = motherDuckEngine(source, {}, { client, rebuildOnRotate: true });

    rotate();
    await engine.ready();

    expect(creates.map((c) => c.mdToken)).toEqual(["tok_2"]);
    expect(terminates()).toBe(0);
  });

  it("rebuild() is explicit, deduplicated, and reports its reason", async () => {
    const { client, creates, terminates } = fakeClient();
    const { source, rotate } = fakeSource(["tok_1", "tok_2"]);
    const engine = motherDuckEngine(source, {}, { client });
    const reasons: string[] = [];
    engine.onRebuild((_handle, reason) => reasons.push(reason));
    await engine.ready();
    rotate();

    const [a, b] = await Promise.all([engine.rebuild("session lost"), engine.rebuild("again")]);

    expect(a).toBe(b);
    expect(terminates()).toBe(1);
    expect(creates.map((c) => c.mdToken)).toEqual(["tok_1", "tok_2"]);
    expect(reasons).toEqual(["session lost"]);
    expect(engine.generation).toBe(2);
  });

  it("close() terminates and stops listening", async () => {
    const { client, creates, terminates } = fakeClient();
    const { source, rotate } = fakeSource(["tok_1", "tok_2"]);
    const engine = motherDuckEngine(source, {}, { client, rebuildOnRotate: true });
    await engine.ready();

    await engine.close();
    rotate();
    await new Promise((r) => setTimeout(r, 0));

    expect(terminates()).toBe(1);
    expect(creates).toHaveLength(1);
  });

  it("refuses accessMode: read_only up front", () => {
    const { client } = fakeClient();
    expect(() =>
      motherDuckEngine(staticMotherDuckToken("tok"), { accessMode: "read_only" }, { client }),
    ).toThrow(/read_only.*tab's own/s);
  });
});

describe("staticMotherDuckToken", () => {
  it("is a source with a far-future expiration", async () => {
    const creds = await staticMotherDuckToken("tok").get();
    expect(creds.token).toBe("tok");
    expect(Date.parse(creds.expiration) - Date.now()).toBeGreaterThan(300 * 24 * 3_600_000);
  });
});

describe("isMotherDuckAuthError", () => {
  it("matches the session-dead shapes and nothing else", () => {
    expect(isMotherDuckAuthError(new Error("PERMISSION_DENIED: token revoked"))).toBe(true);
    expect(isMotherDuckAuthError("Invalid Error: UNAUTHENTICATED")).toBe(true);
    expect(
      isMotherDuckAuthError(new Error("Catalog Error: Table with name es does not exist!")),
    ).toBe(false);
    expect(isMotherDuckAuthError(new Error("Binder Error: column x not found"))).toBe(false);
  });
});
