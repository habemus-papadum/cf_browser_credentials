import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import { describe, expect, it } from "vitest";
import { credentialAwareConnector } from "./index.js";

function fakeManager(ids: string[], region?: string) {
  let i = 0;
  const current = () => ({
    accessKeyId: ids[Math.min(i, ids.length - 1)],
    secretAccessKey: "s",
    sessionToken: "t",
    region,
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return {
    rotate: () => {
      i += 1;
    },
    manager: {
      get: async () => current(),
      refresh: async () => {
        i += 1;
        return current();
      },
    } as unknown as CredentialManager<AwsCredentials>,
  };
}

function fakeBase(rejectSecret: boolean) {
  const executed: string[] = [];
  // Full statements too, for asserting what actually landed in DuckDB.
  const statements: string[] = [];
  return {
    executed,
    statements,
    base: {
      query: async ({ sql }: { sql: string }) => {
        if (rejectSecret && sql.includes("CREATE OR REPLACE SECRET")) {
          throw new Error("secrets unsupported");
        }
        executed.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
        statements.push(sql);
        return [];
      },
      // biome-ignore lint/suspicious/noExplicitAny: structural stand-in for mosaic's Connector
    } as any,
  };
}

describe("credentialAwareConnector", () => {
  it("installs once, then passes queries straight through", async () => {
    const { manager } = fakeManager(["AKID1"]);
    const { base, executed } = fakeBase(false);
    const connector = credentialAwareConnector(base, manager, "us-east-1");

    await connector.query({ type: "exec", sql: "SELECT 1" });
    await connector.query({ type: "exec", sql: "SELECT 2" });

    expect(executed).toEqual(["CREATE OR", "SELECT 1", "SELECT 2"]);
  });

  it("falls back to SET s3_* and reports the mode", async () => {
    const { manager } = fakeManager(["AKID1"]);
    const { base, executed } = fakeBase(true);
    const modes: string[] = [];
    const connector = credentialAwareConnector(base, manager, "us-east-1", {
      onInstall: (mode) => modes.push(mode),
    });

    await connector.query({ type: "exec", sql: "SELECT 1" });

    expect(modes).toEqual(["SET s3_*"]);
    expect(executed).toEqual(["SET s3_region", "SELECT 1"]);
  });

  it("re-installs when the credentials rotate", async () => {
    const { manager, rotate } = fakeManager(["AKID1", "AKID2"]);
    const { base, executed } = fakeBase(false);
    const keys: string[] = [];
    const connector = credentialAwareConnector(base, manager, "us-east-1", {
      onInstall: (_mode, creds) => keys.push(creds.accessKeyId),
    });

    await connector.query({ type: "exec", sql: "SELECT 1" });
    rotate();
    await connector.query({ type: "exec", sql: "SELECT 2" });

    expect(keys).toEqual(["AKID1", "AKID2"]);
    expect(executed).toEqual(["CREATE OR", "SELECT 1", "CREATE OR", "SELECT 2"]);
  });

  it("installs the region the envelope carries when none is passed", async () => {
    const { manager } = fakeManager(["AKID1"], "eu-west-2");
    const { base, statements } = fakeBase(false);
    const connector = credentialAwareConnector(base, manager);

    await connector.query({ type: "exec", sql: "SELECT 1" });

    expect(statements[0]).toContain("REGION 'eu-west-2'");
  });

  it("lets an explicit region override the envelope's", async () => {
    const { manager } = fakeManager(["AKID1"], "eu-west-2");
    const { base, statements } = fakeBase(false);
    const connector = credentialAwareConnector(base, manager, { region: "us-east-1" });

    await connector.query({ type: "exec", sql: "SELECT 1" });

    expect(statements[0]).toContain("REGION 'us-east-1'");
  });

  it("still honours the deprecated region positional", async () => {
    const { manager } = fakeManager(["AKID1"], "eu-west-2");
    const { base, statements } = fakeBase(false);
    const modes: string[] = [];
    const connector = credentialAwareConnector(base, manager, "us-east-1", {
      onInstall: (mode) => modes.push(mode),
    });

    await connector.query({ type: "exec", sql: "SELECT 1" });

    expect(statements[0]).toContain("REGION 'us-east-1'");
    expect(modes).toEqual(["CREATE SECRET"]);
  });

  it("takes the region of the credentials being installed across a rotation", async () => {
    let region = "eu-west-2";
    const { manager, rotate } = fakeManager(["AKID1", "AKID2"]);
    const rotating = {
      get: async () => ({ ...(await manager.get()), region }),
      refresh: async () => ({ ...(await manager.refresh()), region }),
      // biome-ignore lint/suspicious/noExplicitAny: structural stand-in for the manager
    } as any;
    const { base, statements } = fakeBase(false);
    const connector = credentialAwareConnector(base, rotating);

    await connector.query({ type: "exec", sql: "SELECT 1" });
    rotate();
    region = "us-east-1";
    await connector.query({ type: "exec", sql: "SELECT 2" });

    expect(statements[0]).toContain("REGION 'eu-west-2'");
    expect(statements[2]).toContain("REGION 'us-east-1'");
  });

  it("says so when neither the caller nor the envelope names a region", async () => {
    const { manager } = fakeManager(["AKID1"]);
    const { base } = fakeBase(false);
    const connector = credentialAwareConnector(base, manager);

    await expect(connector.query({ type: "exec", sql: "SELECT 1" })).rejects.toThrow(/no region/);
  });

  it("forceRefresh mints on every query but installs only on change", async () => {
    const { manager } = fakeManager(["AKID1", "AKID2", "AKID3"]);
    const { base, executed } = fakeBase(false);
    const connector = credentialAwareConnector(base, manager, "us-east-1", {
      forceRefresh: () => true,
    });

    await connector.query({ type: "exec", sql: "SELECT 1" });
    await connector.query({ type: "exec", sql: "SELECT 2" });

    // Every query minted a new key, so every query re-installed.
    expect(executed).toEqual(["CREATE OR", "SELECT 1", "CREATE OR", "SELECT 2"]);
  });
});
