import { describe, expect, it } from "vitest";

import { corsHeadersFor, isLoopbackOrigin } from "./index.js";

describe("isLoopbackOrigin", () => {
  it.each([
    ["http://localhost:5173", true],
    ["http://localhost:49152", true],
    ["https://localhost", true],
    ["http://127.0.0.1:3000", true],
    ["http://[::1]:8080", true],
    ["https://example.com", false],
    ["http://localhost.evil.com", false],
    ["ws://localhost:5173", false],
    ["not a url", false],
    ["", false],
  ])("%s → %s", (origin, expected) => {
    expect(isLoopbackOrigin(origin)).toBe(expected);
  });
});

describe("corsHeadersFor", () => {
  it("echoes a loopback origin with credentials allowed", () => {
    expect(corsHeadersFor("http://localhost:5173")).toEqual({
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-allow-credentials": "true",
      vary: "origin",
    });
  });

  it("returns null — never a rejection — for absent or foreign origins", () => {
    expect(corsHeadersFor(null)).toBeNull();
    expect(corsHeadersFor("https://example.com")).toBeNull();
  });
});
