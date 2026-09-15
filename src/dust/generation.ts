import type { DustAPI } from "@dust-tt/client";

import { HttpError } from "../errors";

export interface ActiveGeneration {
  userMessageId: string;
  messageIds: string[];
}

export function conversationMissing(error: { type?: string }): boolean {
  return error.type === "conversation_not_found";
}

/** Owns one remote generation, never all the messages of a conversation. */
export class Generation {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  terminal = false;
  private conversationId: string | null = null;
  private active: ActiveGeneration | null = null;
  private cancellation: Promise<void> | null = null;
  private cancelled = false;

  constructor(
    private readonly api: DustAPI,
    private readonly persist: (active: ActiveGeneration | undefined) => Promise<void> = async () => {},
  ) {}

  async open(conversation: any, userMessageId: string): Promise<AsyncIterable<any>> {
    this.conversationId = conversation.sId;
    this.active = { userMessageId, messageIds: [] };
    let persistError: unknown;
    try { await this.persist(this.active); } catch (e) { persistError = e; }
    // Do not abort discovery on client disconnect: we still need the exact
    // remote message id to cancel a POST that Dust has already accepted.
    const message = await this.api.waitForAgentMessage({
      conversation, parentUserMessageId: userMessageId, signal: AbortSignal.timeout(15_000),
    });
    if (message.isErr() || !message.value) {
      throw new HttpError(502, "Unable to identify the Dust generation; recovery is required", "api_error");
    }
    this.active.messageIds = [message.value.sId];
    try { await this.persist(this.active); } catch (e) { persistError = e; }
    if (persistError) {
      await this.cancel();
      throw persistError;
    }
    if (this.signal.aborted) {
      await this.cancel();
      this.signal.throwIfAborted();
    }
    const stream = await this.api.streamAgentMessageEvents({
      conversationId: conversation.sId, agentMessageId: message.value.sId, signal: this.signal,
      options: { maxReconnectAttempts: 3, reconnectDelay: 1000, autoReconnect: true },
    });
    if (stream.isErr()) throw new HttpError(502, `stream failed: ${stream.error.message}`, "api_error");
    return this.observe(stream.value.eventStream);
  }

  private async *observe(events: AsyncIterable<any>): AsyncGenerator<any> {
    for await (const event of events) {
      this.signal.throwIfAborted();
      if (["agent_message_success", "agent_message_gracefully_stopped", "agent_generation_cancelled", "agent_error", "user_message_error"].includes(event?.type)) {
        await this.finish();
      }
      yield event;
    }
  }

  async finish(): Promise<void> {
    this.terminal = true;
    await this.persist(undefined);
  }

  async cancel(): Promise<void> {
    this.controller.abort(new HttpError(409, "Dust turn interrupted", "api_error"));
    if (this.terminal || this.cancelled || !this.active?.messageIds.length || !this.conversationId) return;
    if (!this.cancellation) {
      this.cancellation = (async () => {
        const result = await this.api.cancelMessageGeneration({
          conversationId: this.conversationId!, messageIds: this.active!.messageIds,
        });
        if (result.isErr()) throw new HttpError(502, `Dust cancellation failed: ${result.error.message}`, "api_error");
        this.cancelled = true;
        await this.persist(undefined);
      })().finally(() => { this.cancellation = null; });
    }
    await this.cancellation;
  }
}

/** Recovery after a process restart: only cancel descendants of our user POST. */
export async function cancelRecovered(api: DustAPI, conversationId: string, active: ActiveGeneration): Promise<void> {
  let messageIds = active.messageIds;
  if (!messageIds.length) {
    const conversation = await api.getConversation({ conversationId });
    if (conversation.isErr()) {
      if (conversationMissing(conversation.error)) return;
      throw new HttpError(502, `Recovery failed: ${conversation.error.message}`, "api_error");
    }
    const message = await api.waitForAgentMessage({
      conversation: conversation.value, parentUserMessageId: active.userMessageId, signal: AbortSignal.timeout(15_000),
    });
    if (message.isErr() || !message.value) throw new HttpError(409, "Cannot identify interrupted Dust turn", "api_error");
    messageIds = [message.value.sId];
  }
  const result = await api.cancelMessageGeneration({ conversationId, messageIds });
  if (result.isErr() && !conversationMissing(result.error)) {
    throw new HttpError(502, `Recovery cancellation failed: ${result.error.message}`, "api_error");
  }
}
