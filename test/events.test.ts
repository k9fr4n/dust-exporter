import { describe, expect, it } from "vitest";

import { normalizeEvents } from "../src/dust/events";
import type { Delta } from "../src/types";

async function* gen(items: any[]) { for (const i of items) yield i; }
async function collect(stream: AsyncIterable<Delta>): Promise<Delta[]> {
  const out: Delta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

describe("normalizeEvents", () => {
  it("maps tokens, reasoning and a terminal done event", async () => {
    const evs = gen([
      { type: "generation_tokens", classification: "chain_of_thought", text: "think" },
      { type: "generation_tokens", classification: "tokens", text: "Hello" },
      { type: "generation_tokens", classification: "tokens", text: " world" },
      { type: "agent_message_success" },
    ]);
    const out = await collect(normalizeEvents(evs, { conversationId: "c1", onApprove: async () => {} }));
    const text = out.filter((d) => d.type === "text").map((d: any) => d.text).join("");
    expect(text).toBe("Hello world");
    expect(out.some((d) => d.type === "reasoning")).toBe(true);
    const done = out.find((d) => d.type === "done") as any;
    expect(done.conversationId).toBe("c1");
  });
  it("auto-approves tool execution and records tools + files", async () => {
    const approved: any[] = [];
    const evs = gen([
      { type: "tool_params", action: { functionCallName: "read_file" } },
      { type: "tool_approve_execution", actionId: "a1" },
      { type: "agent_action_success", action: { generatedFiles: [{ fileId: "f1", title: "t", contentType: "text/plain" }] } },
      { type: "agent_message_success" },
    ]);
    const out = await collect(normalizeEvents(evs, { conversationId: "c", onApprove: async (e) => { approved.push(e); } }));
    expect(approved).toHaveLength(1);
    const done = out.find((d) => d.type === "done") as any;
    expect(done.toolsUsed).toContain("read_file");
    expect(done.generatedFiles[0].fileId).toBe("f1");
  });
  it("emits error and stops on agent_error", async () => {
    const evs = gen([
      { type: "generation_tokens", classification: "tokens", text: "x" },
      { type: "agent_error", error: { message: "boom" } },
      { type: "agent_message_success" },
    ]);
    const out = await collect(normalizeEvents(evs, { conversationId: "c", onApprove: async () => {} }));
    const err = out.find((d) => d.type === "error") as any;
    expect(err.message).toBe("boom");
    expect(out.find((d) => d.type === "done")).toBeUndefined();
  });
});
