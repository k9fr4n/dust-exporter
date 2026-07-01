import { randomUUID } from "node:crypto";

import { z } from "zod";

import { HttpError } from "../errors";
import type { Delta, NormalizedMessage } from "../types";

function flattenBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b?.type === "text" || b?.type === "input_text") return b.text ?? "";
        if (b?.type === "tool_result") {
          return typeof b.content === "string" ? b.content : flattenBlocks(b.content);
        }
        if (b?.type === "image") return "[image omitted]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}
function flattenSystem(system: unknown): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((b: any) => (typeof b === "string" ? b : (b?.text ?? ""))).filter(Boolean).join("\n");
  }
  return String(system);
}

const MsgSchema = z.object({ role: z.string(), content: z.any() });
const ReqSchema = z.object({
  model: z.string(),
  messages: z.array(MsgSchema).min(1),
  system: z.any().optional(),
  stream: z.boolean().optional(),
  max_tokens: z.number().optional(),
});

export interface ParsedAnthropic {
  model: string;
  system: string;
  messages: NormalizedMessage[];
  stream: boolean;
  /** Stable Claude Code session id (from metadata.user_id JSON), or null. */
  sessionId: string | null;
}

export function parseMessagesRequest(body: unknown): ParsedAnthropic {
  const r = ReqSchema.safeParse(body);
  if (!r.success) {
    throw new HttpError(400, `Invalid request: ${r.error.issues.map((i) => i.message).join("; ")}`);
  }
  const messages: NormalizedMessage[] = r.data.messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: flattenBlocks(m.content),
  }));
  return {
    model: r.data.model,
    system: flattenSystem(r.data.system),
    messages,
    stream: !!r.data.stream,
    sessionId: extractSessionId((body as any)?.metadata),
  };
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}
export interface ToolResult {
  toolUseId: string;
  content: string;
}
export interface ParsedAnthropicFull extends ParsedAnthropic {
  /** Stable Claude Code session id (from metadata.user_id JSON), or null. */
  sessionId: string | null;
  tools: AnthropicTool[];
  /** tool_result blocks found in the last user message (a "resume" turn). */
  toolResults: ToolResult[];
  isResume: boolean;
  /** Text of the last user message (the new prompt), excluding tool_result. */
  lastUserText: string;
  /** Text of the FIRST user message — a stable anchor that differs between the
   *  main agent and each (sidechain) subagent even when they share a session id. */
  firstUserText: string;
}

function extractSessionId(metadata: unknown): string | null {
  const uid = (metadata as any)?.user_id;
  if (typeof uid !== "string") return null;
  if (uid.trim().startsWith("{")) {
    try {
      const o = JSON.parse(uid);
      return typeof o.session_id === "string" && o.session_id ? o.session_id : null;
    } catch {
      return uid;
    }
  }
  return uid;
}
function toolResultText(block: any): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Richer parse used in client-tools (passthrough) mode. */
export function parseMessagesFull(body: unknown): ParsedAnthropicFull {
  const base = parseMessagesRequest(body);
  const b = body as any;
  const sessionId = extractSessionId(b?.metadata);
  const tools: AnthropicTool[] = Array.isArray(b?.tools)
    ? b.tools
        .filter((t: any) => t && typeof t.name === "string" && t.input_schema)
        .map((t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    : [];

  // Fold top-level system + any role:"system" messages into the system string.
  const sysParts = [base.system];
  for (const m of b?.messages ?? []) {
    if (m?.role === "system") sysParts.push(flattenBlocks(m.content));
  }
  const system = sysParts.filter(Boolean).join("\n\n");

  // Find the last user message; split its content into tool_result vs text.
  const msgs: any[] = b?.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m?.role === "user");
  const toolResults: ToolResult[] = [];
  let lastUserText = "";
  if (lastUser) {
    if (Array.isArray(lastUser.content)) {
      const textParts: string[] = [];
      for (const blk of lastUser.content) {
        if (blk?.type === "tool_result") {
          toolResults.push({ toolUseId: blk.tool_use_id, content: toolResultText(blk) });
        } else if (blk?.type === "text") {
          textParts.push(blk.text ?? "");
        }
      }
      lastUserText = textParts.filter(Boolean).join("\n");
    } else {
      lastUserText = String(lastUser.content ?? "");
    }
  }
  const firstUser = msgs.find((m) => m?.role === "user");
  const firstUserText = firstUser
    ? Array.isArray(firstUser.content)
      ? firstUser.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text ?? "")
          .join("\n")
      : String(firstUser.content ?? "")
    : "";

  return {
    ...base,
    system,
    sessionId,
    tools,
    toolResults,
    isResume: toolResults.length > 0,
    lastUserText,
    firstUserText,
  };
}

export function newMsgId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

/** Rough input-token estimate (~4 chars/token). Used by the count_tokens
 *  endpoint that Claude Code calls before sending a request. */
export function estimateInputTokens(p: ParsedAnthropic): number {
  const all = [p.system, ...p.messages.map((m) => m.content)].join("\n");
  return Math.max(1, Math.ceil(all.length / 4));
}
function ev(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export async function* anthropicStream(
  id: string,
  model: string,
  deltas: AsyncIterable<Delta>,
): AsyncGenerator<string> {
  yield ev("message_start", {
    message: {
      id, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let index = -1;
  let current: "thinking" | "text" | null = null;
  const queue: string[] = [];
  const open = (type: "thinking" | "text") => {
    if (current === type) return;
    if (current !== null) queue.push(ev("content_block_stop", { index }));
    index++;
    current = type;
    const block = type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
    queue.push(ev("content_block_start", { index, content_block: block }));
  };
  let errored: string | null = null;
  for await (const d of deltas) {
    if (d.type === "reasoning") {
      open("thinking");
      while (queue.length) yield queue.shift()!;
      yield ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: d.text } });
    } else if (d.type === "text") {
      open("text");
      while (queue.length) yield queue.shift()!;
      yield ev("content_block_delta", { index, delta: { type: "text_delta", text: d.text } });
    } else if (d.type === "error") {
      errored = d.message;
      break;
    }
  }
  if (current !== null) yield ev("content_block_stop", { index });
  if (errored) {
    yield ev("error", { error: { type: "api_error", message: errored } });
    return;
  }
  yield ev("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  yield ev("message_stop", {});
}

export async function anthropicCollect(id: string, model: string, deltas: AsyncIterable<Delta>) {
  let text = "";
  let thinking = "";
  let error: string | null = null;
  for await (const d of deltas) {
    if (d.type === "text") text += d.text;
    else if (d.type === "reasoning") thinking += d.text;
    else if (d.type === "error") error = d.message;
  }
  if (error && !text) throw new HttpError(502, error, "api_error");
  const content: any[] = [];
  if (thinking) content.push({ type: "thinking", thinking });
  content.push({ type: "text", text });
  return {
    id, type: "message", role: "assistant", model, content,
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
