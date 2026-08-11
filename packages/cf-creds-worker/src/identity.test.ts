import { describe, expect, it } from "vitest";

import { AccessVerificationError, verifyAccessIdentity } from "./identity.js";

const te = new TextEncoder();

function base64Url(input: string | Uint8Array): string {
  const binary = typeof input === "string" ? input : String.fromCharCode(...input);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fake Zero Trust team: one RSA signing key, a JWKS fetcher, a signer. */
async function makeTeam() {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const kid = "test-key";
  const jwksCalls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    jwksCalls.push(String(input));
    return Response.json({ keys: [{ ...jwk, kid }] });
  }) as typeof fetch;

  async function sign(claims: Record<string, unknown>): Promise<string> {
    const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const payload = base64Url(JSON.stringify(claims));
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, te.encode(`${header}.${payload}`)),
    );
    return `${header}.${payload}.${base64Url(signature)}`;
  }

  return { fetcher, sign, jwksCalls };
}

function requestWith(token?: string): Request {
  return new Request("https://site.example/api/credentials/aws", {
    headers: token ? { "cf-access-jwt-assertion": token } : {},
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function userClaims(teamDomain: string, extra: Record<string, unknown> = {}) {
  return {
    aud: ["app-aud"],
    email: "nehal@example.com",
    iss: `https://${teamDomain}`,
    sub: "user-uuid",
    exp: nowSeconds() + 300,
    iat: nowSeconds(),
    ...extra,
  };
}

// Team domains are unique per test: the JWKS cache is module-level.
describe("verifyAccessIdentity", () => {
  it("verifies a user JWT and extracts the email", async () => {
    const domain = "t1.cloudflareaccess.com";
    const team = await makeTeam();
    const token = await team.sign(userClaims(domain));

    const identity = await verifyAccessIdentity(requestWith(token), {
      teamDomain: domain,
      audience: "app-aud",
      fetcher: team.fetcher,
    });

    expect(identity).toMatchObject({ kind: "user", email: "nehal@example.com" });
    expect(team.jwksCalls).toEqual([`https://${domain}/cdn-cgi/access/certs`]);
  });

  it("recognises a service token by common_name", async () => {
    const domain = "t2.cloudflareaccess.com";
    const team = await makeTeam();
    const token = await team.sign(
      userClaims(domain, { email: undefined, sub: "", common_name: "abc123.access" }),
    );

    const identity = await verifyAccessIdentity(requestWith(token), {
      teamDomain: domain,
      fetcher: team.fetcher,
    });

    expect(identity).toMatchObject({ kind: "service-token", commonName: "abc123.access" });
  });

  it("caches the JWKS across verifications", async () => {
    const domain = "t3.cloudflareaccess.com";
    const team = await makeTeam();
    await verifyAccessIdentity(requestWith(await team.sign(userClaims(domain))), {
      teamDomain: domain,
      fetcher: team.fetcher,
    });
    await verifyAccessIdentity(requestWith(await team.sign(userClaims(domain))), {
      teamDomain: domain,
      fetcher: team.fetcher,
    });
    expect(team.jwksCalls).toHaveLength(1);
  });

  it("accepts a team domain given as a URL", async () => {
    const domain = "t4.cloudflareaccess.com";
    const team = await makeTeam();
    const token = await team.sign(userClaims(domain));
    await expect(
      verifyAccessIdentity(requestWith(token), {
        teamDomain: `https://${domain}/`,
        fetcher: team.fetcher,
      }),
    ).resolves.toMatchObject({ kind: "user" });
  });

  it("rejects a missing header", async () => {
    await expect(
      verifyAccessIdentity(requestWith(), { teamDomain: "t5.cloudflareaccess.com" }),
    ).rejects.toThrow(AccessVerificationError);
  });

  it("rejects a tampered payload", async () => {
    const domain = "t6.cloudflareaccess.com";
    const team = await makeTeam();
    const token = await team.sign(userClaims(domain));
    const [header, , signature] = token.split(".");
    const forged = base64Url(JSON.stringify(userClaims(domain, { email: "evil@example.com" })));
    await expect(
      verifyAccessIdentity(requestWith(`${header}.${forged}.${signature}`), {
        teamDomain: domain,
        fetcher: team.fetcher,
      }),
    ).rejects.toThrow(/signature/);
  });

  it("rejects an expired JWT", async () => {
    const domain = "t7.cloudflareaccess.com";
    const team = await makeTeam();
    const token = await team.sign(userClaims(domain, { exp: nowSeconds() - 3600 }));
    await expect(
      verifyAccessIdentity(requestWith(token), { teamDomain: domain, fetcher: team.fetcher }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects an audience mismatch when an audience is required", async () => {
    const domain = "t8.cloudflareaccess.com";
    const team = await makeTeam();
    const token = await team.sign(userClaims(domain, { aud: ["other-app"] }));
    await expect(
      verifyAccessIdentity(requestWith(token), {
        teamDomain: domain,
        audience: "app-aud",
        fetcher: team.fetcher,
      }),
    ).rejects.toThrow(/audience/);
  });

  it("rejects a foreign issuer", async () => {
    const domain = "t9.cloudflareaccess.com";
    const team = await makeTeam();
    const token = await team.sign(userClaims(domain, { iss: "https://evil.example" }));
    await expect(
      verifyAccessIdentity(requestWith(token), { teamDomain: domain, fetcher: team.fetcher }),
    ).rejects.toThrow(/issuer/);
  });

  it("rejects non-RS256 algorithms without touching the JWKS", async () => {
    const domain = "t10.cloudflareaccess.com";
    const team = await makeTeam();
    const header = base64Url(JSON.stringify({ alg: "none", kid: "test-key" }));
    const payload = base64Url(JSON.stringify(userClaims(domain)));
    await expect(
      verifyAccessIdentity(requestWith(`${header}.${payload}.`), {
        teamDomain: domain,
        fetcher: team.fetcher,
      }),
    ).rejects.toThrow(/alg/);
    expect(team.jwksCalls).toHaveLength(0);
  });
});
