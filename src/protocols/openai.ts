import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type AgentInfo, modelIds } from "../dust/agents";
import { HttpError } from "../errors";
import type { Delta, NormalizedMessage } from "../types";

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" || part?.type === "input_text") return part.text ?? "";
        if (part?.type === "image_url") return "[image omitted]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

const MessageSchema = z.object({
  role: z.string(),
  content: z.any().optional(),
  name: z.string().optional(),
});
const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema).min(1),
  stream: z.boolean().optional(),
});

export interface ParsedChat {
  model: string;
  system: string;
  messages: NormalizedMessage[];
  stream: boolean;
}

export function parseChatRequest(body: unknown): ParsedChat {
  const r = ChatRequestSchema.safeParse(body);
  if (!r.success) {
    throw new HttpError(400, `Invalid request: ${r.error.issues.map((i) => i.message).join("; ")}`);
  }
  const sys: string[] = [];
  const messages: NormalizedMessage[] = [];
  for (const m of r.data.messages) {
    const text = flatten(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text) sys.push(text);
      continue;
    }
    if (m.role === "assistant" || m.role === "tool") messages.push({ role: m.role, content: text });
    else messages.push({ role: "user", content: text });
  }
  return { model: r.data.model, system: sys.join("\n\n"), messages, stream: !!r.data.stream };
}

export function newId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function chunk(id: string, model: string, delta: any, finish: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: nowSec(),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export async function* openaiStream(
  id: string,
  model: string,
  deltas: AsyncIterable<Delta>,
): AsyncGenerator<string> {
  yield sse(chunk(id, model, { role: "assistant", content: "" }));
  let errored: string | null = null;
  for await (const d of deltas) {
    if (d.type === "text") yield sse(chunk(id, model, { content: d.text }));
    else if (d.type === "reasoning") yield sse(chunk(id, model, { reasoning_content: d.text }));
    else if (d.type === "error") {
      errored = d.message;
      break;
    }
  }
  if (errored) {
    yield sse({ ...chunk(id, model, {}, "stop"), error: { message: errored, type: "server_error" } });
  } else {
    yield sse(chunk(id, model, {}, "stop"));
  }
  yield "data: [DONE]\n\n";
}

export async function openaiCollect(id: string, model: string, deltas: AsyncIterable<Delta>) {
  let content = "";
  let error: string | null = null;
  for await (const d of deltas) {
    if (d.type === "text") content += d.text;
    else if (d.type === "error") error = d.message;
  }
  if (error && !content) throw new HttpError(502, error, "api_error");
  return {
    id,
    object: "chat.completion",
    created: nowSec(),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function modelsList(agents: AgentInfo[]) {
  const ids = modelIds(agents);
  const created = nowSec();
  return {
    object: "list",
    data: agents.map((a) => ({
      id: ids.get(a.sId) ?? a.sId,
      display_name: a.name || a.sId,
      // OpenAI/Anthropic listing fields, kept so both SDKs accept the payload.
      object: "model",
      type: "model",
      created,
      created_at: new Date(created * 1000).toISOString(),
      owned_by: "dust",
      name: a.name,
    })),
  };
}
