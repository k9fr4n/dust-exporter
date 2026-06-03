import { describe, expect, it } from "vitest";

import { planTurn, renderTranscript, withSystem } from "../src/dust/planner";
import { fingerprint } from "../src/state/fingerprint";
import type { NormalizedMessage } from "../src/types";

const base = { workspaceId: "w", agentId: "agent" };

describe("planTurn", () => {
  it("creates a new conversation for the first user message", () => {
    const messages: NormalizedMessage[] = [{ role: "user", content: "hello" }];
    const plan = planTurn({ ...base, messages, lookup: () => undefined });
    expect(plan.mode).toBe("create");
    expect(plan.isReplay).toBe(false);
    expect(plan.contentToSend).toBe("hello");
  });
  it("prepends the system prompt on a new conversation", () => {
    const messages: NormalizedMessage[] = [{ role: "user", content: "hi" }];
    const plan = planTurn({ ...base, system: "be nice", messages, lookup: () => undefined });
    expect(plan.contentToSend).toContain("be nice");
    expect(plan.contentToSend).toContain("hi");
  });
  it("continues when the prior prefix is known", () => {
    const priorKey = fingerprint("w", "agent", ["u1"]);
    const store = new Map([[priorKey, "conv-123"]]);
    const messages: NormalizedMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];
    const plan = planTurn({ ...base, messages, lookup: (k) => store.get(k) });
    expect(plan.mode).toBe("continue");
    expect(plan.conversationId).toBe("conv-123");
    expect(plan.contentToSend).toBe("u2");
  });
  it("replays the full transcript when the prefix is unknown", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];
    const plan = planTurn({ ...base, messages, lookup: () => undefined });
    expect(plan.mode).toBe("create");
    expect(plan.isReplay).toBe(true);
    expect(plan.contentToSend).toContain("u1");
    expect(plan.contentToSend).toContain("u2");
  });
  it("throws when there is no user message", () => {
    const messages: NormalizedMessage[] = [{ role: "assistant", content: "x" }];
    expect(() => planTurn({ ...base, messages, lookup: () => undefined })).toThrow();
  });
  it("keys on the full user-turn sequence", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ];
    const plan = planTurn({ ...base, messages, lookup: () => undefined });
    expect(plan.fingerprintKey).toBe(fingerprint("w", "agent", ["u1", "u2"]));
  });
});

describe("render helpers", () => {
  it("withSystem wraps only when present", () => {
    expect(withSystem("s", "c")).toContain("<system>");
    expect(withSystem(undefined, "c")).toBe("c");
  });
  it("renderTranscript labels roles", () => {
    const t = renderTranscript(
      [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }],
      "sys",
    );
    expect(t).toContain("User: hi");
    expect(t).toContain("Assistant: yo");
    expect(t).toContain("<system>");
  });
});
