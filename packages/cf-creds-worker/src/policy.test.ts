import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessIdentity } from "./identity.js";
import { allowAll, logMint, mintLogRecord } from "./policy.js";

const user: AccessIdentity = { kind: "user", email: "nehal@example.com", claims: {} };
const machine: AccessIdentity = { kind: "service-token", commonName: "abc.access", claims: {} };

describe("allowAll", () => {
  it("grants the standard grant to any identity", async () => {
    const policy = allowAll({ roleArn: "arn:aws:iam::123:role/r", durationSeconds: 7200 });
    const request = new Request("https://site.example/api/credentials/aws");
    for (const identity of [user, machine]) {
      const decision = await policy({ identity, provider: "aws", request });
      expect(decision).toEqual({
        allow: true,
        grant: { roleArn: "arn:aws:iam::123:role/r", durationSeconds: 7200 },
      });
    }
  });
});

describe("mintLogRecord", () => {
  it("summarises the identity and lifts the ray id off the request", () => {
    const request = new Request("https://site.example/api/credentials/aws", {
      headers: { "cf-ray": "8f00ba55-SJC" },
    });
    const record = mintLogRecord({
      provider: "aws",
      outcome: "allowed",
      identity: user,
      request,
      grant: { roleArn: "arn:aws:iam::123:role/r" },
      expiration: "2026-08-11T12:00:00Z",
    });
    expect(record).toEqual({
      type: "credential-mint",
      provider: "aws",
      outcome: "allowed",
      identity: { kind: "user", email: "nehal@example.com" },
      grant: { roleArn: "arn:aws:iam::123:role/r" },
      expiration: "2026-08-11T12:00:00Z",
      rayId: "8f00ba55-SJC",
      colo: undefined,
    });
  });

  it("names service tokens and carries denial reasons", () => {
    const record = mintLogRecord({
      provider: "aws",
      outcome: "denied",
      identity: machine,
      reason: "service tokens get no aws credentials",
    });
    expect(record.identity).toEqual({ kind: "service-token", commonName: "abc.access" });
    expect(record.reason).toBe("service tokens get no aws credentials");
    expect(record.rayId).toBeUndefined();
  });

  it("tolerates a null identity for verification failures", () => {
    const record = mintLogRecord({ provider: "aws", outcome: "denied", identity: null });
    expect(record.identity).toBeNull();
  });
});

describe("logMint", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits one JSON line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logMint({ provider: "aws", outcome: "allowed", identity: user });
    expect(log).toHaveBeenCalledOnce();
    const parsed = JSON.parse(log.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      type: "credential-mint",
      provider: "aws",
      identity: { email: "nehal@example.com" },
    });
  });
});
