import { afterEach, describe, expect, it, vi } from "vitest";

import { assumeRole } from "./index.js";

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
});
