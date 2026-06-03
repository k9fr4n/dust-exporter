import { describe, expect, it } from "vitest";

import { fingerprint } from "../src/state/fingerprint";

describe("fingerprint", () => {
  it("is deterministic", () => {
    expect(fingerprint("w", "a", ["hi"])).toBe(fingerprint("w", "a", ["hi"]));
  });
  it("is order-sensitive", () => {
    expect(fingerprint("w", "a", ["a", "b"])).not.toBe(fingerprint("w", "a", ["b", "a"]));
  });
  it("varies by workspace and agent", () => {
    expect(fingerprint("w1", "a", ["x"])).not.toBe(fingerprint("w2", "a", ["x"]));
    expect(fingerprint("w", "a1", ["x"])).not.toBe(fingerprint("w", "a2", ["x"]));
  });
});
