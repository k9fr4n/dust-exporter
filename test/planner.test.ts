import { describe, expect, it } from "vitest";

import { planTurn, renderTranscript, sessionKey, withSystem } from "../src/dust/planner";
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

describe("planTurn with sessionId", () => {
  it("continues on the session key even when the content prefix changed", () => {
    // Simulates Claude Code compaction: the prior turn content differs from
    // what was stored, but the session id + first user turn are unchanged.
    const sKey = sessionKey("sess-1", "agent", "u1");
    const store = new Map([[sKey, "conv-abc"]]);
    const messages: NormalizedMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "[compacted summary, not the original u1..a1]" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ];
    const plan = planTurn({ ...base, messages, sessionId: "sess-1", lookup: (k) => store.get(k) });
    expect(plan.mode).toBe("continue");
    expect(plan.conversationId).toBe("conv-abc");
    expect(plan.contentToSend).toBe("u3");
    expect(plan.storeKey).toBe(sKey);
  });
  it("creates and stores under the session key when the session is new", () => {
    const messages: NormalizedMessage[] = [{ role: "user", content: "hello" }];
    const plan = planTurn({ ...base, messages, sessionId: "sess-2", lookup: () => undefined });
    expect(plan.mode).toBe("create");
    expect(plan.storeKey).toBe(sessionKey("sess-2", "agent", "hello"));
  });
  it("falls back to content fingerprint when no sessionId is provided", () => {
    const messages: NormalizedMessage[] = [{ role: "user", content: "hello" }];
    const plan = planTurn({ ...base, messages, sessionId: null, lookup: () => undefined });
    expect(plan.storeKey).toBe(plan.fingerprintKey);
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
