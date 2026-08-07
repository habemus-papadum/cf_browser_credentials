import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import { describe, expect, it, vi } from "vitest";

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

const sent: { config: unknown; input: unknown }[] = [];

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
