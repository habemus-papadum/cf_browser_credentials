import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-sts", () => {
  class STSClient {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
    async send(command: { input: unknown }) {
      sent.push({ config: this.config, input: command.input });
      return { WebIdentityToken: "header.payload.signature" };
    }
  }
  class GetWebIdentityTokenCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { STSClient, GetWebIdentityTokenCommand };
});

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

const sent: { config: unknown; input: unknown }[] = [];
const constructed: Record<string, unknown>[] = [];

const manager = {
  get: async () => ({
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    sessionToken: "tok",
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
  }),
} as unknown as CredentialManager<AwsCredentials>;

describe("awsSubjectTokenProvider", () => {
  it("mints a JWT with the manager's current credentials and sane defaults", async () => {
    const { awsSubjectTokenProvider } = await import("./index.js");
    const provider = awsSubjectTokenProvider({ manager, region: "us-east-1" });

    expect(provider.tokenType).toBe("jwt");
    expect(await provider.getToken()).toBe("header.payload.signature");
    expect(sent[0].input).toEqual({
      Audience: ["https://api.openai.com/v1"],
      SigningAlgorithm: "ES384",
      DurationSeconds: 300,
    });
  });
});

// The bundle one keyed openai mint returns: the STS envelope plus every
// federation id the two client-side legs need.
const BUNDLE = {
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  sessionToken: "tok",
  expiration: new Date(Date.now() + 3_600_000).toISOString(),
  region: "eu-west-2",
  audience: "https://api.openai.com/v1",
  identityProviderId: "idp_from_broker",
  serviceAccountId: "user-from-broker",
};

describe("createBrokeredOpenAI", () => {
  beforeEach(() => {
    sent.length = 0;
    constructed.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a client from nothing but the site's own key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(BUNDLE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createBrokeredOpenAI } = await import("./index.js");

    const { client, manager: brokered } = await createBrokeredOpenAI({
      base: "https://creds.example.com",
      key: "scratch",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://creds.example.com/api/credentials/openai?key=scratch",
    );
    // Every id the SDK is configured with came off the wire, not from here.
    const { workloadIdentity } = constructed[0] as {
      workloadIdentity: { identityProviderId: string; serviceAccountId: string };
    };
    expect(workloadIdentity.identityProviderId).toBe("idp_from_broker");
    expect(workloadIdentity.serviceAccountId).toBe("user-from-broker");
    expect(client).toBeDefined();
    // The manager comes back typed to the bundle, for onRotate and refresh.
    expect((await brokered.get()).serviceAccountId).toBe("user-from-broker");
  });

  it("takes the STS leg's region and audience from the envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...BUNDLE, audience: "https://audience.example" }), {
            status: 200,
          }),
      ),
    );
    const { createBrokeredOpenAI } = await import("./index.js");

    await createBrokeredOpenAI({ base: "https://creds.example.com", key: "scratch" });
    const { workloadIdentity } = constructed[0] as {
      workloadIdentity: { provider: { getToken: () => Promise<string> } };
    };
    await workloadIdentity.provider.getToken();

    expect(sent[0].config).toMatchObject({ region: "eu-west-2" });
    expect(sent[0].input).toEqual({
      Audience: ["https://audience.example"],
      SigningAlgorithm: "ES384",
      DurationSeconds: 300,
    });
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
      createBrokeredOpenAI({ base: "https://creds.example.com", key: "scratch", role: "smoke" }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe("openaiCredentialsUrl", () => {
  it("names the site, not the grant", async () => {
    const { openaiCredentialsUrl } = await import("./index.js");
    expect(openaiCredentialsUrl("https://creds.example.com", { key: "scratch" })).toBe(
      "https://creds.example.com/api/credentials/openai?key=scratch",
    );
  });
});
