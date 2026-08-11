import { afterEach, describe, expect, it, vi } from "vitest";

import { assumeRole, sessionNameFor } from "./index.js";

const STS_XML = `<AssumeRoleResponse>
  <AssumeRoleResult><Credentials>
    <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
    <SecretAccessKey>secret</SecretAccessKey>
    <SessionToken>session-token</SessionToken>
    <Expiration>2026-08-07T12:00:00Z</Expiration>
  </Credentials></AssumeRoleResult>
</AssumeRoleResponse>`;

const source = { accessKeyId: "AKIASOURCE", secretAccessKey: "sourcesecret" };

describe("assumeRole", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs a regional STS request and parses the credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(STS_XML, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const creds = await assumeRole(source, "arn:aws:iam::123:role/r", 7200, {
      region: "us-west-2",
    });

    expect(creds).toEqual({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      expiration: "2026-08-07T12:00:00Z",
    });
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe("https://sts.us-west-2.amazonaws.com/");
    expect(request.headers.get("authorization")).toMatch(/AWS4-HMAC-SHA256/);
    expect(await request.text()).toContain("DurationSeconds=7200");
  });

  it("throws with status and body on STS errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("<Error>denied</Error>", { status: 403 }));
    await expect(assumeRole(source, "arn:aws:iam::123:role/r", 7200)).rejects.toThrow(
      /403.*denied/s,
    );
  });

  it("passes session name and session tags through to STS", async () => {
    const fetchMock = vi.fn(async () => new Response(STS_XML, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await assumeRole(source, "arn:aws:iam::123:role/r", 7200, {
      sessionName: "nehal@example.com",
      tags: { email: "nehal@example.com", site: "demo" },
    });

    const body = await (fetchMock.mock.calls[0][0] as Request).text();
    const params = new URLSearchParams(body);
    expect(params.get("RoleSessionName")).toBe("nehal@example.com");
    expect(params.get("Tags.member.1.Key")).toBe("email");
    expect(params.get("Tags.member.1.Value")).toBe("nehal@example.com");
    expect(params.get("Tags.member.2.Key")).toBe("site");
    expect(params.get("Tags.member.2.Value")).toBe("demo");
  });
});

describe("sessionNameFor", () => {
  it("uses a user's email verbatim — the STS charset admits it", () => {
    expect(sessionNameFor({ kind: "user", email: "nehal@example.com", claims: {} })).toBe(
      "nehal@example.com",
    );
  });

  it("uses a service token's client id", () => {
    expect(sessionNameFor({ kind: "service-token", commonName: "abc123.access", claims: {} })).toBe(
      "abc123.access",
    );
  });

  it("sanitises and truncates hostile input", () => {
    const name = sessionNameFor({
      kind: "user",
      email: `we ird/${"x".repeat(80)}`,
      claims: {},
    });
    expect(name).toMatch(/^we-ird-x+$/);
    expect(name).toHaveLength(64);
  });
});
