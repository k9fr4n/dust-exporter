import { describe, expect, it } from "vitest";

import { modelsList, newId, openaiCollect, openaiStream, parseChatRequest } from "../src/protocols/openai";
import type { Delta } from "../src/types";

async function* deltas(items: Delta[]) { for (const d of items) yield d; }
async function collectStr(g: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const s of g) out.push(s);
  return out;
}
const doneDelta: Delta = { type: "done", conversationId: "c", toolsUsed: [], generatedFiles: [], finishReason: "stop", stepsUsed: 0, maxSteps: 0 };

describe("parseChatRequest", () => {
  it("extracts system and flattens array content", () => {
    const p = parseChatRequest({
      model: "gpt-5",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "x" } }] },
      ],
      stream: true,
    });
    expect(p.model).toBe("gpt-5");
    expect(p.system).toBe("sys");
    expect(p.stream).toBe(true);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toEqual({ role: "user", content: "hi\n[image omitted]" });
  });
  it("rejects empty messages", () => {
    expect(() => parseChatRequest({ model: "x", messages: [] })).toThrow();
  });
});

describe("openai serialization", () => {
  it("non-stream accumulates content", async () => {
    const r: any = await openaiCollect("id", "m", deltas([
      { type: "text", text: "a" }, { type: "text", text: "b" }, doneDelta,
    ]));
    expect(r.choices[0].message.content).toBe("ab");
    expect(r.object).toBe("chat.completion");
  });
  it("stream emits role, content and [DONE]", async () => {
    const out = await collectStr(openaiStream("id", "m", deltas([{ type: "text", text: "hi" }, doneDelta])));
    const joined = out.join("");
    expect(joined).toContain('"role":"assistant"');
    expect(joined).toContain('"content":"hi"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(out[out.length - 1]).toBe("data: [DONE]\n\n");
  });
  it("models list maps sId to id", () => {
    const l: any = modelsList([{ sId: "a", name: "A", description: "" }]);
    expect(l.data[0].id).toBe("a");
    expect(l.object).toBe("list");
  });
  it("newId is prefixed", () => expect(newId().startsWith("chatcmpl-")).toBe(true));
});
