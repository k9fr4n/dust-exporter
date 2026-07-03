// CLIENT-TOOLS PASSTHROUGH (experimental): let the *client's own* tools (e.g.
// Claude Code's Read/Edit/Bash) execute on the client, driven by a Dust agent.
//
// Mechanism: the client's tool definitions are registered with Dust as a
// reverse-MCP server. When the Dust agent calls a tool, our MCP handler parks
// and we surface it to the client as an Anthropic `tool_use` block (stop_reason
// tool_use); the client executes it and returns a `tool_result`, which we feed
// back to resume the (still-alive) Dust turn. Sessions are keyed by Claude
// Code's stable session id (metadata.user_id), so one session == one Dust
// conversation held across many HTTP requests.
import type { ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";

import type { DustAPI } from "@dust-tt/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage } from "../errors";
import { log } from "../logger";
import { type AnthropicTool, newMsgId, type ParsedAnthropicFull, type ToolResult } from "../protocols/anthropic";
import { ReverseMcpTransport } from "./mcpFsServer";
import { normalizeEvents } from "./events";
import { deriveTitle, withSystem } from "./planner";
import type { ConversationStore } from "../state/store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SESSION_IDLE_MS = 20 * 60 * 1000;

type SessionEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tooluse"; id: string; name: string; input: unknown }
  | { kind: "done" }
  | { kind: "error"; message: string };

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    while (this.resolvers.length) this.resolvers.shift()!({ value: undefined as any, done: true });
  }
  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
    return new Promise((res) => this.resolvers.push(res));
  }
  /** Like next() but resolves to null after `ms` if nothing arrives, without
   *  consuming a future item (used to batch parallel tool calls). */
  nextWithTimeout(ms: number): Promise<IteratorResult<T> | null> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
    return new Promise((res) => {
      const resolver = (v: IteratorResult<T>) => {
        clearTimeout(timer);
        res(v);
      };
      this.resolvers.push(resolver);
      const timer = setTimeout(() => {
        const i = this.resolvers.indexOf(resolver);
        if (i >= 0) this.resolvers.splice(i, 1);
        res(null);
      }, ms);
    });
  }
}

async function approve(api: DustAPI, ev: any): Promise<void> {
  try {
    await api.validateAction({
      conversationId: ev.conversationId,
      messageId: ev.messageId,
      actionId: ev.actionId,
      approved: "approved",
    });
  } catch (e) {
    log.warn("validateAction failed", errorMessage(e));
  }
}
async function buildContext(api: DustAPI, serverId: string | null) {
  let me: any = { username: "dust-exporter", fullName: "Dust Exporter", email: "proxy@dust-exporter" };
  try {
    const r = await api.me();
    if (r.isOk()) me = r.value;
  } catch {
    /* defaults */
  }
  return {
    origin: "cli",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    username: me.username,
    fullName: me.fullName,
    email: me.email,
    clientSideMCPServerIds: serverId ? [serverId] : null,
  };
}

class Session {
  conversationId: string | null = null;
  private serverId: string | null = null;
  private transport: ReverseMcpTransport | null = null;
  private queue = new AsyncQueue<SessionEvent>();
  private parked = new Map<string, (result: string) => void>();
  private pending: SessionEvent | null = null;
  private static readonly TOOL_BATCH_MS = 150;
  lastActivity = Date.now();

  constructor(
    readonly api: DustAPI,
    readonly agentId: string,
    private readonly tools: AnthropicTool[],
    private readonly firstUserText: string,
    private readonly titlePrefix: string,
    /** Store key under which this session's conversationId is persisted, so the
     *  mapping survives idle teardown and container restarts (see registry). */
    private readonly storeKey: string,
    private readonly store?: ConversationStore,
  ) {}

  touch(): void {
    this.lastActivity = Date.now();
  }

  /** Write-through the session's conversationId so continuity survives idle
   *  teardown and container restarts. Fire-and-forget: a persist failure only
   *  costs a future rehydration, never the live turn. */
  private persistConversationId(): void {
    if (this.store && this.conversationId) {
      void this.store.set(this.storeKey, this.conversationId);
    }
  }

  async ensureMcp(): Promise<void> {
    if (this.serverId) return;
    const server = new Server({ name: "client-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.input_schema as any,
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const id = `toolu_${randomUUID().replace(/-/g, "")}`;
      const result = await new Promise<string>((resolve) => {
        this.parked.set(id, resolve);
        this.queue.push({ kind: "tooluse", id, name: req.params.name, input: req.params.arguments ?? {} });
      });
      return { content: [{ type: "text", text: result }] };
    });
    this.transport = new ReverseMcpTransport(this.api, (sid) => { this.serverId = sid; }, "client-tools");
    await server.connect(this.transport);
    for (let i = 0; i < 50 && !this.serverId; i++) await sleep(100);
    if (!this.serverId) throw new Error("client-tools MCP server failed to register (OAuth required)");
    log.info("client-tools MCP registered", this.serverId, `(${this.tools.length} tools)`);
  }

  /** Begin a new user turn (new Dust message in this session's conversation). */
  async startTurn(content: string, system: string | undefined): Promise<void> {
    this.queue = new AsyncQueue<SessionEvent>();
    const context = await buildContext(this.api, this.serverId);
    const mentions = [{ configurationId: this.agentId }];
    let conversation: any;
    let userMessageId: string | undefined;

    const createFresh = async (): Promise<void> => {
      const res = await this.api.createConversation({
        title: this.titlePrefix ? deriveTitle(this.firstUserText, this.titlePrefix) : undefined,
        visibility: "unlisted",
        message: { content: withSystem(system, content), mentions, context: context as any },
      } as any);
      if (res.isErr()) throw new Error(`createConversation failed: ${res.error.message}`);
      conversation = res.value.conversation;
      userMessageId = res.value.message!.sId;
      this.conversationId = conversation.sId;
      this.persistConversationId();
      log.info("client-tools conversation created", {
        conversationId: this.conversationId,
        title: conversation.title,
      });
    };

    if (!this.conversationId) {
      await createFresh();
    } else {
      // Existing (possibly rehydrated from the store) conversation: append the
      // turn. If Dust no longer has it (deleted/expired), fall back to a fresh
      // conversation instead of failing the whole request.
      const post = await this.api.postUserMessage({
        conversationId: this.conversationId,
        message: { content, mentions, context: context as any },
      });
      if (post.isErr()) {
        log.warn("client-tools postUserMessage failed, recreating conversation", post.error.message);
        this.conversationId = null;
        await createFresh();
      } else {
        userMessageId = post.value.sId;
        const conv = await this.api.getConversation({ conversationId: this.conversationId });
        if (conv.isErr()) throw new Error(`getConversation failed: ${conv.error.message}`);
        conversation = conv.value;
        this.persistConversationId(); // bump updatedAt so the mapping isn't LRU-evicted
      }
    }
    const stream = await this.api.streamAgentAnswerEvents({ conversation, userMessageId: userMessageId! });
    if (stream.isErr()) {
      const err: any = stream.error;
      throw new Error(`stream failed: ${err?.message ?? String(err)}`);
    }
    void this.consume(stream.value.eventStream);
  }

  private async consume(eventStream: AsyncIterable<any>): Promise<void> {
    try {
      const norm = normalizeEvents(eventStream, {
        conversationId: this.conversationId!,
        onApprove: (ev) => approve(this.api, ev),
      });
      for await (const d of norm) {
        if (d.type === "text") this.queue.push({ kind: "text", text: d.text });
        else if (d.type === "reasoning") this.queue.push({ kind: "reasoning", text: d.text });
        else if (d.type === "error") { this.queue.push({ kind: "error", message: d.message }); break; }
        else if (d.type === "done") {
          const a = d.agent;
          log.info("turn resolved", {
            conversationId: this.conversationId,
            requested: this.agentId,
            agent: a?.name,
            agentSId: a?.sId,
            model: a?.providerId && a?.modelId ? `${a.providerId}/${a.modelId}` : undefined,
          });
          this.queue.push({ kind: "done" });
          break;
        }
        // d.type === "tool" ignored: the real tool_use comes from the MCP handler.
      }
    } catch (e) {
      this.queue.push({ kind: "error", message: errorMessage(e) });
    } finally {
      this.queue.close();
    }
  }

  /** Feed client tool_results back into the parked Dust tool calls. */
  deliverToolResults(results: ToolResult[]): boolean {
    let delivered = false;
    for (const r of results) {
      const resolve = this.parked.get(r.toolUseId);
      if (resolve) {
        this.parked.delete(r.toolUseId);
        resolve(r.content);
        delivered = true;
      }
    }
    return delivered;
  }

  hasParked(): boolean {
    return this.parked.size > 0;
  }

  /** Drain the current turn until the next stop point (tool_use or end). */
  async pump(sink: {
    onText: (t: string) => void;
    onReasoning: (t: string) => void;
    onToolUse: (tu: { id: string; name: string; input: unknown }) => void;
  }): Promise<{ stop: "tool_use" | "end_turn" | "error"; error?: string }> {
    for (;;) {
      let item: SessionEvent;
      if (this.pending) {
        item = this.pending;
        this.pending = null;
      } else {
        const r = await this.queue.next();
        if (r.done) return { stop: "end_turn" };
        item = r.value;
      }
      switch (item.kind) {
        case "text": sink.onText(item.text); break;
        case "reasoning": sink.onReasoning(item.text); break;
        case "error": return { stop: "error", error: item.message };
        case "done": return { stop: "end_turn" };
        case "tooluse": {
          // Emit this tool call, then briefly collect any sibling calls issued
          // ~concurrently (parallel tools / multiple subagents) into one response.
          sink.onToolUse({ id: item.id, name: item.name, input: item.input });
          const deadline = Date.now() + Session.TOOL_BATCH_MS;
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const r = await this.queue.nextWithTimeout(remaining);
            if (r === null || r.done) break;
            if (r.value.kind === "tooluse") {
              sink.onToolUse({ id: r.value.id, name: r.value.name, input: r.value.input });
            } else {
              this.pending = r.value; // text/done/error: handle on the next pump
              break;
            }
          }
          return { stop: "tool_use" };
        }
      }
    }
  }

  /** Idle teardown: release the reverse-MCP transport (and any parked tool
   *  calls) but KEEP the Dust conversation. Its id is persisted in the store,
   *  so the next request for this key rehydrates and continues it rather than
   *  starting fresh — this is what makes continuity survive long idle gaps. */
  async dispose(): Promise<void> {
    try { await this.transport?.close(); } catch { /* ignore */ }
    for (const resolve of this.parked.values()) resolve("(session closed)");
    this.parked.clear();
  }
}

export class SessionRegistry {
  private sessions = new Map<string, Session>();
  /** @param store persists key -> conversationId so a session evicted by the
   *  idle sweep (or lost to a container restart) can be rehydrated and its Dust
   *  conversation continued instead of a new one being created. */
  constructor(private readonly store?: ConversationStore) {
    setInterval(() => this.sweep(), 5 * 60 * 1000).unref?.();
  }
  private sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now - s.lastActivity > SESSION_IDLE_MS) {
        this.sessions.delete(k);
        void s.dispose();
      }
    }
  }
  async get(parsed: ParsedAnthropicFull, agentId: string, api: DustAPI, titlePrefix: string): Promise<Session> {
    // Key on session id + agent + an anchor hash of the first user message, so
    // the main agent and each concurrent (sidechain) subagent — which all share
    // one Claude Code session id — map to distinct Dust conversations. Prefixed
    // ("ct:") in the store to never collide with the standard-path fingerprints.
    const anchor = createHash("sha256").update(parsed.firstUserText).digest("hex").slice(0, 16);
    const key = `${parsed.sessionId}:${agentId}:${anchor}`;
    const storeKey = `ct:${key}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = new Session(api, agentId, parsed.tools, parsed.firstUserText, titlePrefix, storeKey, this.store);
      // Rehydrate: if we still have a Dust conversation for this key, continue
      // it. `get()` never calls Dust — the next startTurn posts to this id.
      let rehydrated: string | undefined;
      if (this.store) {
        await this.store.load();
        rehydrated = this.store.get(storeKey);
        if (rehydrated) s.conversationId = rehydrated;
      }
      this.sessions.set(key, s);
      if (rehydrated) log.info("client-tools session rehydrated", { key, conversationId: rehydrated });
      else log.info("client-tools session created", { key, firstUser: parsed.firstUserText.slice(0, 50) });
    }
    s.touch();
    return s;
  }
}

function ev(res: ServerResponse, type: string, data: Record<string, unknown>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

/** Stream one HTTP response in tools mode: text/thinking blocks, then either a
 *  tool_use block (stop_reason tool_use) or end_turn. */
async function streamToolsSSE(res: ServerResponse, model: string, session: Session): Promise<void> {
  const id = newMsgId();
  ev(res, "message_start", {
    message: {
      id, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let index = -1;
  let current: "text" | "thinking" | null = null;
  const closeBlock = () => {
    if (current !== null) { ev(res, "content_block_stop", { index }); current = null; }
  };
  const openBlock = (type: "text" | "thinking") => {
    if (current === type) return;
    closeBlock();
    index++;
    current = type;
    const block = type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
    ev(res, "content_block_start", { index, content_block: block });
  };
  const sink = {
    onText: (t: string) => {
      openBlock("text");
      ev(res, "content_block_delta", { index, delta: { type: "text_delta", text: t } });
    },
    onReasoning: (t: string) => {
      openBlock("thinking");
      ev(res, "content_block_delta", { index, delta: { type: "thinking_delta", thinking: t } });
    },
    onToolUse: (tu: { id: string; name: string; input: unknown }) => {
      closeBlock();
      index++;
      ev(res, "content_block_start", {
        index,
        content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} },
      });
      ev(res, "content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input ?? {}) },
      });
      ev(res, "content_block_stop", { index });
    },
  };
  const result = await session.pump(sink);
  closeBlock();
  if (result.stop === "error") {
    ev(res, "error", { error: { type: "api_error", message: result.error ?? "agent error" } });
    return;
  }
  ev(res, "message_delta", {
    delta: { stop_reason: result.stop, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  ev(res, "message_stop", {});
}

/** Entry point for a client-tools (passthrough) request. */
export async function handleClientToolsRequest(opts: {
  res: ServerResponse;
  parsed: ParsedAnthropicFull;
  agentId: string;
  api: DustAPI;
  registry: SessionRegistry;
  titlePrefix: string;
}): Promise<void> {
  const { res, parsed, agentId, api, registry, titlePrefix } = opts;
  // DIAGNOSTIC (temporary): capture the signals we'd use to key conversation
  // continuity, so we can see how they behave across Claude Code context
  // compaction and subagent (Task/sidechain) calls. Goal: decide whether the
  // session id alone disambiguates conversations (drop the first-message
  // anchor), or whether we need a compaction-stable discriminator such as the
  // tool-set hash. Enable with DUST_PROXY_LOG_LEVEL=debug. Remove once decided.
  const toolNames = parsed.tools.map((t) => t.name).sort();
  log.debug("cc-session-signal", {
    sessionId: parsed.sessionId,                 // raw metadata.user_id
    firstUserAnchor: createHash("sha256").update(parsed.firstUserText).digest("hex").slice(0, 16),
    firstUserHead: parsed.firstUserText.slice(0, 60),
    toolsHash: createHash("sha256").update(toolNames.join(",")).digest("hex").slice(0, 8),
    toolCount: toolNames.length,
    systemHash: createHash("sha256").update(parsed.system ?? "").digest("hex").slice(0, 8),
    isResume: parsed.isResume,
  });
  const session = await registry.get(parsed, agentId, api, titlePrefix);
  await session.ensureMcp();
  const firstTurn = session.conversationId === null;
  if (parsed.isResume && session.hasParked()) {
    session.deliverToolResults(parsed.toolResults);
  } else {
    const content =
      parsed.lastUserText ||
      parsed.toolResults.map((r) => r.content).join("\n") ||
      "(continue)";
    await session.startTurn(content, firstTurn ? parsed.system : undefined);
  }
  await streamToolsSSE(res, parsed.model, session);
}
