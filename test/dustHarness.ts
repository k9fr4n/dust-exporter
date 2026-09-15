import { vi } from "vitest";

export function ok(value: any) { return { isOk: () => true, isErr: () => false, value }; }
export function err(type: string, message = type) { return { isOk: () => false, isErr: () => true, error: { type, message } }; }
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class Events implements AsyncIterable<any> {
  private items: any[] = [];
  private waiting?: (value: IteratorResult<any>) => void;
  private ended = false;
  push(value: any) {
    if (this.ended) return;
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value, done: false }); }
    else this.items.push(value);
  }
  text(text: string) { this.push({ type: "generation_tokens", classification: "tokens", text }); }
  success() { this.push({ type: "agent_message_success", message: {} }); }
  end() { this.ended = true; this.waiting?.({ value: undefined, done: true }); this.waiting = undefined; }
  [Symbol.asyncIterator]() {
    return { next: (): Promise<IteratorResult<any>> => {
      if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
      if (this.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { this.waiting = resolve; });
    } };
  }
}

export function fakeDust() {
  let users = 0;
  const streams: Events[] = [];
  const api = {
    workspaceId: () => "workspace",
    me: vi.fn(async () => ok({ username: "test" })),
    createConversation: vi.fn(async (_body: any) => ok({ conversation: { sId: "conversation", content: [] }, message: { sId: `user-${++users}` } })),
    postUserMessage: vi.fn(async (_body: any) => ok({ sId: `user-${++users}` })),
    getConversation: vi.fn(async ({ conversationId }: any) => ok({ sId: conversationId, content: [] })),
    waitForAgentMessage: vi.fn(async ({ parentUserMessageId }: any) => ok({ sId: `agent-${parentUserMessageId}` })),
    streamAgentMessageEvents: vi.fn(async (_args: any) => {
      const events = new Events();
      streams.push(events);
      return ok({ eventStream: events });
    }),
    cancelMessageGeneration: vi.fn(async (_body: any) => ok({ success: true })),
    validateAction: vi.fn(async () => ok({})),
  };
  return { api, streams };
}
