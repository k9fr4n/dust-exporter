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

import { errorMessage, HttpError } from "../errors";
import { log } from "../logger";
import { type AnthropicTool, newMsgId, type ParsedAnthropicFull, type ToolResult } from "../protocols/anthropic";
import { ReverseMcpTransport } from "./mcpFsServer";
import { normalizeEvents } from "./events";
import { deriveTitle, renderTranscript, withSystem } from "./planner";
import { cancelRecovered, conversationMissing, Generation } from "./generation";
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
  const result = await api.validateAction({ conversationId: ev.conversationId, messageId: ev.messageId, actionId: ev.actionId, approved: "approved" });
  if (result.isErr()) throw new HttpError(502, `validateAction failed: ${result.error.message}`, "api_error");
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

class Turn {
  readonly queue = new AsyncQueue<SessionEvent>();
  readonly parked = new Map<string, (result: ToolResult) => void>();
  pending: SessionEvent | null = null;
  timer?: NodeJS.Timeout;
  constructor(readonly generation: Generation) {}
}

class Session {
  conversationId: string | null = null;
  private serverId: string | null = null;
  private transport: ReverseMcpTransport | null = null;
  private turn: Turn | null = null;
  private requestActive = false;
  private detachRequest?: () => void;
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
    private readonly toolTimeoutMs = SESSION_IDLE_MS,
  ) {}

  touch(): void {
    this.lastActivity = Date.now();
  }

  beginRequest(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.requestActive) throw new HttpError(409, "Another request is already consuming this Dust turn", "api_error");
    this.requestActive = true;
    const abort = () => { void this.cancelTurn().catch((e) => log.error("client-tools cancellation failed", errorMessage(e))); };
    signal?.addEventListener("abort", abort, { once: true });
    this.detachRequest = () => signal?.removeEventListener("abort", abort);
  }

  endRequest(): void {
    this.detachRequest?.();
    this.detachRequest = undefined;
    this.requestActive = false;
    this.touch();
  }

  isActive(): boolean { return this.requestActive || !!this.turn && !this.turn.generation.signal.aborted && !this.turn.generation.terminal; }
  ownsTool(id: string): boolean { return this.turn?.parked.has(id) ?? false; }

  async recover(): Promise<void> {
    const active = this.store?.active(this.storeKey);
    if (!this.turn && active && this.conversationId) {
      await cancelRecovered(this.api, this.conversationId, active);
      await this.store!.set(this.storeKey, this.conversationId);
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
    const turn = this.turn!;
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (turn.generation.signal.aborted || turn.generation.terminal) throw new Error("Dust turn is no longer active");
      const id = `toolu_${randomUUID().replace(/-/g, "")}`;
      const result = await new Promise<ToolResult>((resolve) => {
        turn.parked.set(id, resolve);
        turn.queue.push({ kind: "tooluse", id, name: req.params.name, input: req.params.arguments ?? {} });
      });
      return { content: [{ type: "text", text: result.content }], isError: !!result.isError };
    });
    this.transport = new ReverseMcpTransport(this.api, (sid) => { this.serverId = sid; }, `client-tools-${randomUUID()}`);
    await server.connect(this.transport);
    for (let i = 0; i < 50 && !this.serverId; i++) await sleep(100);
    if (!this.serverId) throw new Error("client-tools MCP server failed to register (OAuth required)");
    log.info("client-tools MCP registered", this.serverId, `(${this.tools.length} tools)`);
  }

  /** Begin a new user turn (new Dust message in this session's conversation). */
  async startTurn(content: string, system: string | undefined, replay = withSystem(system, content), signal?: AbortSignal): Promise<void> {
    await this.cancelTurn();
    await this.recover();
    signal?.throwIfAborted();
    // A distinct transport per turn prevents late MCP requests from an old
    // generation from being attributed to the new one.
    await this.transport?.close();
    this.transport = null;
    this.serverId = null;
    const generation = new Generation(this.api, async (active) => {
      if (this.store && this.conversationId) await this.store.set(this.storeKey, this.conversationId, active);
    });
    const turn = new Turn(generation);
    this.turn = turn;
    try {
      await this.ensureMcp();
      const context = await buildContext(this.api, this.serverId);
      const mentions = [{ configurationId: this.agentId }];
      signal?.throwIfAborted();
      generation.signal.throwIfAborted();
      let conversation: any;
      let userMessageId: string;
      const createFresh = async () => {
        const res = await this.api.createConversation({
          title: this.titlePrefix ? deriveTitle(this.firstUserText, this.titlePrefix) : undefined,
          visibility: "unlisted",
          message: { content: replay, mentions, context: context as any },
        } as any);
        if (res.isErr()) throw new HttpError(502, `createConversation failed: ${res.error.message}`, "api_error");
        if (!res.value.conversation || !res.value.message) throw new HttpError(502, "Dust returned no conversation/message", "api_error");
        this.conversationId = res.value.conversation.sId;
        log.info("client-tools conversation created with context replay", { conversationId: this.conversationId });
        return { conversation: res.value.conversation, userMessageId: res.value.message.sId };
      };
      if (!this.conversationId) {
        ({ conversation, userMessageId } = await createFresh());
      } else {
        // Do not abort a mutating POST: first learn its result, then cancel the
        // exact accepted generation. Network ambiguity must never trigger replay.
        const post = await this.api.postUserMessage({
          conversationId: this.conversationId, message: { content, mentions, context: context as any },
        });
        if (post.isErr()) {
          if (!conversationMissing(post.error)) throw new HttpError(502, `postUserMessage failed: ${post.error.message}`, "api_error");
          ({ conversation, userMessageId } = await createFresh());
        } else {
          userMessageId = post.value.sId;
          // waitForAgentMessage refreshes this minimal conversation until the
          // descendant of this specific user message appears.
          conversation = { sId: this.conversationId, content: [] };
        }
      }
      const events = await generation.open(conversation, userMessageId);
      void this.consume(turn, events);
    } catch (e) {
      try { await this.cancelTurn(); } catch (cancelError) { log.error("client-tools cleanup failed", errorMessage(cancelError)); }
      await this.closeTransport();
      throw e;
    }
  }

  private async consume(turn: Turn, eventStream: AsyncIterable<any>): Promise<void> {
    try {
      const norm = normalizeEvents(eventStream, {
        conversationId: this.conversationId!,
        onApprove: (ev) => { turn.generation.signal.throwIfAborted(); return approve(this.api, ev); },
      });
      for await (const d of norm) {
        if (d.type === "text") turn.queue.push({ kind: "text", text: d.text });
        else if (d.type === "reasoning") turn.queue.push({ kind: "reasoning", text: d.text });
        else if (d.type === "error") { turn.queue.push({ kind: "error", message: d.message }); break; }
        else if (d.type === "done") {
          const a = d.agent;
          log.info("turn resolved", {
            conversationId: this.conversationId,
            requested: this.agentId,
            agent: a?.name,
            agentSId: a?.sId,
            model: a?.providerId && a?.modelId ? `${a.providerId}/${a.modelId}` : undefined,
          });
          turn.queue.push({ kind: "done" });
          break;
        }
        // d.type === "tool" ignored: the real tool_use comes from the MCP handler.
      }
    } catch (e) {
      turn.queue.push({ kind: "error", message: errorMessage(e) });
    } finally {
      clearTimeout(turn.timer);
      turn.queue.close();
      try { await turn.generation.cancel(); }
      catch (e) { log.error("Dust stream cleanup failed", errorMessage(e)); }
      for (const [id, resolve] of turn.parked) resolve({ toolUseId: id, content: "Dust turn ended", isError: true });
      turn.parked.clear();
    }
  }

  /** Feed client tool_results back into the parked Dust tool calls. */
  deliverToolResults(results: ToolResult[]): void {
    const turn = this.turn;
    const ids = results.map((r) => r.toolUseId);
    if (!turn || turn.generation.signal.aborted || turn.generation.terminal || new Set(ids).size !== ids.length || ids.some((id) => !turn.parked.has(id))) {
      throw new HttpError(409, "Unknown, duplicate or orphaned tool_result; send a new user turn to recover", "api_error");
    }
    // Validate the entire batch before resolving any promise.
    for (const r of results) {
      const resolve = turn.parked.get(r.toolUseId)!;
      turn.parked.delete(r.toolUseId);
      resolve(r);
    }
    if (!turn.parked.size) { clearTimeout(turn.timer); turn.timer = undefined; }
  }

  hasParked(): boolean { return !!this.turn?.parked.size; }

  /** Drain the current turn until the next stop point (tool_use or end). */
  async pump(sink: {
    onText: (t: string) => void;
    onReasoning: (t: string) => void;
    onToolUse: (tu: { id: string; name: string; input: unknown }) => void;
  }): Promise<{ stop: "tool_use" | "end_turn" | "error"; error?: string }> {
    const turn = this.turn;
    if (!turn) throw new HttpError(409, "No active Dust turn", "api_error");
    for (;;) {
      let item: SessionEvent;
      if (turn.pending) {
        item = turn.pending;
        turn.pending = null;
      } else {
        const r = await turn.queue.next();
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
            const r = await turn.queue.nextWithTimeout(remaining);
            if (r === null || r.done) break;
            if (r.value.kind === "tooluse") {
              sink.onToolUse({ id: r.value.id, name: r.value.name, input: r.value.input });
            } else {
              turn.pending = r.value; // text/done/error: handle on the next pump
              break;
            }
          }
          if (!turn.timer) {
            turn.timer = setTimeout(() => {
              if (this.turn === turn) void this.cancelTurn().catch((e) => log.error("tool wait cancellation failed", errorMessage(e)));
            }, this.toolTimeoutMs);
            turn.timer.unref?.();
          }
          return { stop: "tool_use" };
        }
      }
    }
  }

  async cancelTurn(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    clearTimeout(turn.timer);
    turn.queue.push({ kind: "error", message: "Dust turn interrupted" });
    turn.queue.close();
    // Cancel remotely before releasing tools so they cannot resume generation.
    await turn.generation.cancel();
    for (const [id, resolve] of turn.parked) resolve({ toolUseId: id, content: "Turn interrupted", isError: true });
    turn.parked.clear();
    if (this.turn === turn) {
      this.turn = null;
      await this.closeTransport();
    }
  }

  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.serverId = null;
    await transport?.close();
  }

  async dispose(): Promise<void> {
    try { await this.cancelTurn(); }
    finally { await this.transport?.close(); this.endRequest(); }
  }
}

export class SessionRegistry {
  private sessions = new Map<string, Promise<Session>>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly store?: ConversationStore, private readonly toolTimeoutMs = SESSION_IDLE_MS) {
    this.timer = setInterval(() => { void this.sweep().catch((e) => log.error("session sweep failed", errorMessage(e))); }, 5 * 60 * 1000);
    this.timer.unref?.();
  }
  private async sweep(): Promise<void> {
    for (const [key, promise] of this.sessions) {
      const session = await promise;
      if (!session.isActive() && Date.now() - session.lastActivity > SESSION_IDLE_MS) {
        await session.dispose();
        this.sessions.delete(key);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const results = await Promise.allSettled([...this.sessions.values()].map(async (s) => (await s).dispose()));
    await this.store?.flush();
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async get(parsed: ParsedAnthropicFull, agentId: string, api: DustAPI, titlePrefix: string): Promise<Session> {
    if (this.closed) throw new HttpError(503, "Proxy is shutting down", "api_error");
    const prefix = `${parsed.sessionId}:${agentId}:`;
    // Tool ids provide branch identity even when compaction changed the anchor.
    if (parsed.isResume) {
      const candidates = await Promise.all([...this.sessions].filter(([key]) => key.startsWith(prefix)).map(([, s]) => s));
      const owners = candidates.filter((s) => parsed.toolResults.some((r) => s.ownsTool(r.toolUseId)));
      if (owners.length > 1) throw new HttpError(409, "Tool results span multiple Dust branches", "api_error");
      if (owners.length === 1) { owners[0].touch(); return owners[0]; }
    }
    const anchor = createHash("sha256").update(parsed.firstUserText).digest("hex").slice(0, 16);
    const key = `${prefix}${anchor}`;
    const storeKey = `ct:${key}`;
    let promise = this.sessions.get(key);
    if (!promise) {
      // Publish the promise before awaiting disk I/O: concurrent lookups share it.
      promise = (async () => {
        await this.store?.load();
        const session = new Session(api, agentId, parsed.tools, parsed.firstUserText, titlePrefix, storeKey, this.store, this.toolTimeoutMs);
        session.conversationId = this.store?.get(storeKey) ?? null;
        log.info(session.conversationId ? "client-tools session rehydrated" : "client-tools session created; replay required", { key, conversationId: session.conversationId });
        return session;
      })();
      this.sessions.set(key, promise);
      promise.catch(() => { if (this.sessions.get(key) === promise) this.sessions.delete(key); });
    }
    const session = await promise;
    session.touch();
    return session;
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

/** Shared setup: resolve/create the session and kick off (or resume) its turn. */
async function prepareTurn(opts: {
  parsed: ParsedAnthropicFull;
  agentId: string;
  api: DustAPI;
  registry: SessionRegistry;
  titlePrefix: string;
  signal?: AbortSignal;
}): Promise<Session> {
  const { parsed, agentId, api, registry, titlePrefix } = opts;
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
  session.beginRequest(opts.signal);
  try {
    await session.recover();
    opts.signal?.throwIfAborted();
    if (parsed.isResume) {
      const results = parsed.toolResults.map((result, index) => parsed.lastUserText && index === 0
        ? { ...result, content: `${result.content}\n\n[Additional user context]\n${parsed.lastUserText}` }
        : result);
      session.deliverToolResults(results);
    } else {
      await session.startTurn(parsed.lastUserText || "(continue)", parsed.system, renderTranscript(parsed.messages, parsed.system), opts.signal);
    }
    return session;
  } catch (e) {
    session.endRequest();
    throw e;
  }
}

/** Non-streaming variant: run one turn and return the full Anthropic message JSON. */
async function collectToolsJSON(model: string, session: Session): Promise<Record<string, unknown>> {
  const id = newMsgId();
  const content: any[] = [];
  let current: "text" | "thinking" | null = null;
  const openBlock = (type: "text" | "thinking") => {
    if (current === type) return;
    current = type;
    content.push(type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
  };
  const sink = {
    onText: (t: string) => {
      openBlock("text");
      content[content.length - 1].text += t;
    },
    onReasoning: (t: string) => {
      openBlock("thinking");
      content[content.length - 1].thinking += t;
    },
    onToolUse: (tu: { id: string; name: string; input: unknown }) => {
      current = null;
      content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });
    },
  };
  const result = await session.pump(sink);
  if (result.stop === "error") {
    throw new HttpError(502, result.error ?? "agent error", "api_error");
  }
  return {
    id, type: "message", role: "assistant", model, content,
    stop_reason: result.stop, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** Entry point for a client-tools (passthrough) streaming request. */
export async function handleClientToolsRequest(opts: {
  res: ServerResponse;
  parsed: ParsedAnthropicFull;
  agentId: string;
  api: DustAPI;
  registry: SessionRegistry;
  titlePrefix: string;
  signal?: AbortSignal;
}): Promise<void> {
  const session = await prepareTurn(opts);
  try { await streamToolsSSE(opts.res, opts.parsed.model, session); }
  finally { session.endRequest(); }
}

/** Entry point for a client-tools (passthrough) non-streaming request: same
 *  turn logic as `handleClientToolsRequest`, but returns a plain JSON message
 *  instead of writing SSE events, matching the client's requested `stream: false`. */
export async function handleClientToolsRequestJSON(opts: {
  parsed: ParsedAnthropicFull;
  agentId: string;
  api: DustAPI;
  registry: SessionRegistry;
  titlePrefix: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const session = await prepareTurn(opts);
  try { return await collectToolsJSON(opts.parsed.model, session); }
  finally { session.endRequest(); }
}
