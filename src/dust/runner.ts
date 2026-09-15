import type { DustAPI } from "@dust-tt/client";

import { HttpError, errorMessage } from "../errors";
import { log } from "../logger";
import type { ConversationStore } from "../state/store";
import type { Delta, NormalizedMessage } from "../types";
import { deleteConversation } from "./conversations";
import { normalizeEvents } from "./events";
import { cancelRecovered, conversationMissing, Generation } from "./generation";
import { deriveTitle, planTurn, renderTranscript } from "./planner";

export interface StartTurnInput {
  api: DustAPI;
  agentId: string;
  messages: NormalizedMessage[];
  system?: string;
  store: ConversationStore;
  /** Stable Claude Code session id, when the client sends one (see planner.ts). */
  sessionId?: string | null;
  clientSideMCPServerIds?: string[] | null;
  signal?: AbortSignal;
  /** When true, replay the whole transcript into a throwaway conversation and
   *  delete it once the turn completes (no accumulation, no state lookup). */
  ephemeral?: boolean;
  /** Prefix for the conversation title (empty/undefined = let Dust auto-title). */
  titlePrefix?: string;
  /** Max automatic continuation rounds when a run is cut off by `maxStepsPerRun`.
   *  Each round reposts a follow-up on the same conversation (fresh step budget).
   *  0 / undefined = disabled. */
  maxContinuations?: number;
}

export interface StartedTurn {
  conversationId: string;
  deltas: AsyncGenerator<Delta>;
}

async function buildContext(api: DustAPI, mcpIds?: string[] | null) {
  let me: any = {
    username: "dust-exporter",
    fullName: "Dust Exporter",
    email: "proxy@dust-exporter",
  };
  try {
    const r = await api.me();
    if (r.isOk()) me = r.value;
  } catch {
    /* fall back to defaults */
  }
  return {
    origin: "cli",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    username: me.username,
    fullName: me.fullName,
    email: me.email,
    clientSideMCPServerIds: mcpIds && mcpIds.length ? mcpIds : null,
  };
}

async function approve(api: DustAPI, ev: any): Promise<void> {
  const result = await api.validateAction({ conversationId: ev.conversationId, messageId: ev.messageId, actionId: ev.actionId, approved: "approved" });
  if (result.isErr()) throw new HttpError(502, `validateAction failed: ${result.error.message}`, "api_error");
}

/** Run one agent turn. Performs all setup eagerly so setup failures surface as
 *  thrown HttpErrors (mapped to a proper status BEFORE any SSE byte is sent);
 *  the returned `deltas` generator then streams the answer. */
export async function startTurn(input: StartTurnInput): Promise<StartedTurn> {
  const { api, agentId, messages, system, store, sessionId, clientSideMCPServerIds, signal, ephemeral, titlePrefix } = input;
  signal?.throwIfAborted();
  if (!ephemeral) await store.load();
  const plan = ephemeral ? null : planTurn({ messages, system, workspaceId: api.workspaceId(), agentId, sessionId, lookup: (key) => store.get(key) });
  let release = () => {};
  if (plan) {
    try { release = store.acquire(plan.storeKey); }
    catch { throw new HttpError(409, "Another request is using this conversation", "api_error"); }
  }
  let conversationId = plan?.conversationId ?? "";
  const generation = () => new Generation(api, async (active) => {
    if (plan && conversationId) await store.set(plan.storeKey, conversationId, active);
  });
  let run = generation();
  const abort = () => { void run.cancel().catch((e) => log.error("Dust cancellation failed", errorMessage(e))); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const cleanup = async () => {
    signal?.removeEventListener("abort", abort);
    try { await run.cancel(); }
    finally {
      if (ephemeral && conversationId) await deleteConversation(api, conversationId);
      release();
    }
  };
  try {
    if (plan && conversationId && store.active(plan.storeKey)) {
      await cancelRecovered(api, conversationId, store.active(plan.storeKey)!);
      await store.set(plan.storeKey, conversationId);
    }
    const context = await buildContext(api, clientSideMCPServerIds);
    const mentions = [{ configurationId: agentId }];
    const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
    const title = titlePrefix ? deriveTitle(firstUser, titlePrefix) : undefined;
    const createFresh = async () => {
      run.signal.throwIfAborted();
      const result = await api.createConversation({ title, visibility: "unlisted", message: {
        content: renderTranscript(messages, system), mentions, context: context as any,
      } } as any);
      if (result.isErr()) throw new HttpError(502, `createConversation failed: ${result.error.message}`, "api_error");
      if (!result.value.conversation || !result.value.message) throw new HttpError(502, "Dust returned no conversation/message", "api_error");
      conversationId = result.value.conversation.sId;
      return run.open(result.value.conversation, result.value.message.sId);
    };
    let events: AsyncIterable<any>;
    run.signal.throwIfAborted();
    if (plan?.mode === "continue" && conversationId) {
      const post = await api.postUserMessage({ conversationId, message: { content: plan.contentToSend, mentions, context: context as any } });
      if (post.isErr()) {
        if (!conversationMissing(post.error)) throw new HttpError(502, `postUserMessage failed: ${post.error.message}`, "api_error");
        events = await createFresh();
      } else events = await run.open({ sId: conversationId, content: [] }, post.value.sId);
    } else events = await createFresh();

    async function* rounds(): AsyncGenerator<Delta> {
      try {
        for (let round = 0; ; round++) {
          let last: Extract<Delta, { type: "done" }> | undefined;
          for await (const delta of normalizeEvents(events, { conversationId, onApprove: (ev) => {
            run.signal.throwIfAborted(); return approve(api, ev);
          } })) {
            if (delta.type === "done") last = delta;
            else yield delta;
          }
          if (!last) return;
          log.info("turn resolved", { conversationId, requested: agentId, agent: last.agent?.name });
          if (last.finishReason !== "max_steps" || round >= Math.max(0, input.maxContinuations ?? 0)) {
            yield last;
            return;
          }
          signal?.throwIfAborted();
          run = generation();
          const post = await api.postUserMessage({ conversationId, message: {
            content: "Continue exactly where you left off. Do not restart or repeat work already completed.", mentions, context: context as any,
          } });
          if (post.isErr()) throw new HttpError(502, `Continuation failed: ${post.error.message}`, "api_error");
          events = await run.open({ sId: conversationId, content: [] }, post.value.sId);
          yield { type: "text", text: "\n" };
        }
      } finally { await cleanup(); }
    }
    log.info("turn started", { conversationId, agentId, mode: ephemeral ? "ephemeral" : plan!.mode });
    return { conversationId, deltas: rounds() };
  } catch (e) {
    try { await cleanup(); } catch (cleanupError) { log.error("Dust cleanup failed", errorMessage(cleanupError)); }
    throw e;
  }
}
