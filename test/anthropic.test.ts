import { describe, expect, it } from "vitest";

import { anthropicCollect, anthropicStream, parseMessagesRequest } from "../src/protocols/anthropic";
import type { Delta } from "../src/types";

async function* deltas(items: Delta[]) { for (const d of items) yield d; }
async function collectStr(g: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const s of g) out.push(s);
  return out;
}
const doneDelta: Delta = { type: "done", conversationId: "c", toolsUsed: [], generatedFiles: [] };

describe("parseMessagesRequest", () => {
  it("flattens a system array and content blocks", () => {
    const p = parseMessagesRequest({
      model: "claude",
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: true,
    });
    expect(p.system).toBe("sys");
    expect(p.messages[0].content).toBe("hi");
    expect(p.stream).toBe(true);
  });
  it("accepts string system and content", () => {
    const p = parseMessagesRequest({ model: "claude", system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(p.system).toBe("s");
    expect(p.messages[0].content).toBe("hi");
  });
});

describe("anthropic serialization", () => {
  it("non-stream returns a text block", async () => {
    const r: any = await anthropicCollect("id", "m", deltas([{ type: "text", text: "hello" }, doneDelta]));
    expect(r.type).toBe("message");
    expect(r.content.find((b: any) => b.type === "text").text).toBe("hello");
    expect(r.stop_reason).toBe("end_turn");
  });
  it("stream emits the full event lifecycle", async () => {
    const out = (await collectStr(anthropicStream("id", "m", deltas([
      { type: "reasoning", text: "t" }, { type: "text", text: "hi" }, doneDelta,
    ])))).join("");
    expect(out).toContain("event: message_start");
    expect(out).toContain("thinking_delta");
    expect(out).toContain("text_delta");
    expect(out).toContain("event: message_stop");
  });
});

import { parseMessagesFull } from "../src/protocols/anthropic";

describe("parseMessagesFull (client-tools mode)", () => {
  it("extracts the Claude Code session id from metadata.user_id", () => {
    const p = parseMessagesFull({
      model: "m",
      metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "sess-123" }) },
      tools: [{ name: "Write", description: "w", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(p.sessionId).toBe("sess-123");
    expect(p.tools).toHaveLength(1);
    expect(p.tools[0].name).toBe("Write");
    expect(p.isResume).toBe(false);
    expect(p.lastUserText).toBe("hi");
  });
  it("detects a resume turn and extracts tool_result", () => {
    const p = parseMessagesFull({
      model: "m",
      messages: [
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Write", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "done" }] },
      ],
    });
    expect(p.isResume).toBe(true);
    expect(p.toolResults).toEqual([{ toolUseId: "toolu_x", content: "done" }]);
  });
  it("folds top-level system and role:system messages", () => {
    const p = parseMessagesFull({
      model: "m",
      system: "top",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "reminder" },
      ],
    });
    expect(p.system).toContain("top");
    expect(p.system).toContain("reminder");
  });
});
