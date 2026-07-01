import type { DustAPI } from "@dust-tt/client";

import { HttpError, errorMessage } from "../errors";
import { log } from "../logger";
import type { ConversationStore } from "../state/store";
import type { Delta, NormalizedMessage } from "../types";
import { deleteConversation } from "./conversations";
import { normalizeEvents } from "./events";
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

/** Run one agent turn. Performs all setup eagerly so setup failures surface as
 *  thrown HttpErrors (mapped to a proper status BEFORE any SSE byte is sent);
 *  the returned `deltas` generator then streams the answer. */
export async function startTurn(input: StartTurnInput): Promise<StartedTurn> {
  const {
    api,
    agentId,
    messages,
    system,
    store,
    sessionId,
    clientSideMCPServerIds,
    signal,
    ephemeral,
    titlePrefix,
  } = input;
  const maxContinuations = Math.max(0, input.maxContinuations ?? 0);
  const workspaceId = api.workspaceId();
  const context = await buildContext(api, clientSideMCPServerIds);
  const mentions = [{ configurationId: agentId }];
  const firstUserContent = messages.find((m) => m.role === "user")?.content ?? "";
  const title = titlePrefix ? deriveTitle(firstUserContent, titlePrefix) : undefined;

  if (!ephemeral) await store.load();
  const plan = ephemeral
    ? null
    : planTurn({ messages, system, workspaceId, agentId, sessionId, lookup: (k) => store.get(k) });

  let conversation: any;
  let userMessageId: string | undefined;

  const createFresh = async (content: string) => {
    const res = await api.createConversation({
      title,
      visibility: "unlisted",
      message: { content, mentions, context: context as any },
    } as any);
    if (res.isErr()) {
      throw new HttpError(502, `createConversation failed: ${res.error.message}`, "api_error");
    }
    if (!res.value.conversation || !res.value.message) {
      throw new HttpError(502, "createConversation returned no message", "api_error");
    }
    conversation = res.value.conversation;
    userMessageId = res.value.message.sId;
  };

  if (plan && plan.mode === "continue" && plan.conversationId) {
    const post = await api.postUserMessage({
      conversationId: plan.conversationId,
      message: { content: plan.contentToSend, mentions, context: context as any },
      signal,
    });
    if (post.isErr()) {
      log.warn("postUserMessage failed, recreating conversation", post.error.message);
      await createFresh(renderTranscript(messages, system));
    } else {
      userMessageId = post.value.sId;
      const conv = await api.getConversation({ conversationId: plan.conversationId });
      if (conv.isErr()) {
        throw new HttpError(502, `getConversation failed: ${conv.error.message}`, "api_error");
      }
      conversation = conv.value;
    }
  } else {
    // Ephemeral (or unknown prefix): replay the whole transcript into a fresh conversation.
    await createFresh(plan ? plan.contentToSend : renderTranscript(messages, system));
  }

  const stream = await api.streamAgentAnswerEvents({
    conversation,
    userMessageId: userMessageId!,
    signal,
  });
  if (stream.isErr()) {
    const err: any = stream.error;
    throw new HttpError(502, `stream failed: ${err?.message ?? String(err)}`, "api_error");
  }

  const conversationId = conversation.sId as string;
  const base = normalizeEvents(stream.value.eventStream, {
    conversationId,
    onApprove: (ev) => approve(api, ev),
  });

  // When a run is cut off by `maxStepsPerRun`, we post this follow-up on the
  // SAME (stateful) conversation to resume with a fresh step budget. No replay:
  // the server keeps the full context.
  const CONTINUE_MSG =
    "Continue exactly where you left off, picking up the previous task. " +
    "Do not restart or repeat work already completed.";

  /** Drive the run, transparently chaining continuation runs when Dust truncates
   *  on the step cap. Only the FINAL `done` is emitted to the client; deltas from
   *  every round are streamed contiguously. */
  async function* runRounds(): AsyncGenerator<Delta> {
    const key = ephemeral ? null : plan!.storeKey;
    let stream = base;
    for (let round = 0; ; round++) {
      let last: Delta | undefined;
      for await (const d of stream) {
        if (d.type === "done") {
          last = d;
          break;
        }
        yield d;
      }
      if (last?.type === "done") {
        const a = last.agent;
        log.info("turn resolved", {
          conversationId,
          requested: agentId,
          agent: a?.name,
          agentSId: a?.sId,
          model: a?.providerId && a?.modelId ? `${a.providerId}/${a.modelId}` : undefined,
        });
      }
      if (key && last?.type === "done") await store.set(key, conversationId);

      // Stop unless the run was step-capped AND we still have rounds left.
      if (last?.type !== "done" || last.finishReason !== "max_steps" || round >= maxContinuations) {
        if (last) yield last;
        return;
      }

      log.info("auto-continue: run hit step cap, resuming", {
        round: round + 1,
        of: maxContinuations,
        conversationId,
        stepsUsed: last.stepsUsed,
        maxSteps: last.maxSteps,
      });

      const post = await api.postUserMessage({
        conversationId,
        message: { content: CONTINUE_MSG, mentions, context: context as any },
        signal,
      });
      if (post.isErr()) {
        log.warn("auto-continue postUserMessage failed", post.error.message);
        yield last;
        return;
      }
      const conv = await api.getConversation({ conversationId });
      if (conv.isErr()) {
        log.warn("auto-continue getConversation failed", conv.error.message);
        yield last;
        return;
      }
      conversation = conv.value;
      const next = await api.streamAgentAnswerEvents({
        conversation,
        userMessageId: post.value.sId,
        signal,
      });
      if (next.isErr()) {
        const err: any = next.error;
        log.warn("auto-continue stream failed", err?.message ?? String(err));
        yield last;
        return;
      }
      // Visual separator between chained runs.
      yield { type: "text", text: "\n" };
      stream = normalizeEvents(next.value.eventStream, {
        conversationId,
        onApprove: (ev) => approve(api, ev),
      });
    }
  }

  async function* wrap(): AsyncGenerator<Delta> {
    if (ephemeral) {
      try {
        yield* runRounds();
      } finally {
        // Clean up the throwaway conversation however the stream ended.
        void deleteConversation(api, conversationId);
      }
    } else {
      yield* runRounds();
    }
  }

  log.info("turn started", {
    mode: ephemeral ? "ephemeral" : plan!.mode,
    replay: ephemeral ? true : plan!.isReplay,
    conversationId,
    agentId,
  });
  return { conversationId, deltas: wrap() };
}
