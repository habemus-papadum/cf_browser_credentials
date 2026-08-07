import { describe, expect, it } from "vitest";
import { greet, name } from "./index";

describe(name, () => {
  it("greets", () => {
    expect(greet("world")).toBe("Hello, world!");
  });
});
