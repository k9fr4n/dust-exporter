import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { startTurn } from "../src/dust/runner";
import { sessionKey } from "../src/dust/planner";
import { ConversationStore } from "../src/state/store";
import { err, fakeDust } from "./dustHarness";

let dir: string;
let store: ConversationStore;
let dust: ReturnType<typeof fakeDust>;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "dust-runner-")); store = new ConversationStore(join(dir, "state.json")); dust = fakeDust();
});
afterEach(async () => { for (const stream of dust.streams) stream.end(); await store.flush(); await fs.rm(dir, { recursive: true, force: true }); });
function input(signal?: AbortSignal) {
  return { api: dust.api as any, agentId: "a", messages: [{ role: "user" as const, content: "prompt" }], store, sessionId: "session", ephemeral: false, signal, maxContinuations: 2 };
}
async function drain(events: AsyncIterable<any>) { const out = []; for await (const event of events) out.push(event); return out; }

it("persists the owned generation before completion and clears it after success", async () => {
  const turn = await startTurn(input());
  const key = sessionKey("session", "a", "prompt");
  expect(store.active(key)?.messageIds).toEqual(["agent-user-1"]);
  dust.streams[0].success(); await drain(turn.deltas);
  expect(store.get(key)).toBe("conversation");
  expect(store.active(key)).toBeUndefined();
  expect(dust.api.cancelMessageGeneration).not.toHaveBeenCalled();
});

it("keeps the existing conversation after a transient posting failure", async () => {
  await store.set(sessionKey("session", "a", "prompt"), "existing");
  dust.api.postUserMessage.mockResolvedValueOnce(err("rate_limit_error") as any);
  await expect(startTurn(input())).rejects.toThrow("postUserMessage failed");
  expect(dust.api.createConversation).not.toHaveBeenCalled();
  expect(store.get(sessionKey("session", "a", "prompt"))).toBe("existing");
});

it("cancels a generation if establishing the event stream fails", async () => {
  dust.api.streamAgentMessageEvents.mockResolvedValueOnce(err("unexpected_network_error") as any);
  await expect(startTurn(input())).rejects.toThrow("stream failed");
  expect(dust.api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "conversation", messageIds: ["agent-user-1"] });
});

it("rejects concurrent requests for the same persistent branch", async () => {
  const turn = await startTurn(input());
  await expect(startTurn(input())).rejects.toThrow("Another request");
  dust.streams[0].success(); await drain(turn.deltas);
});

it("does not post automatic continuations after cancellation", async () => {
  const controller = new AbortController();
  const turn = await startTurn(input(controller.signal));
  dust.streams[0].text("partial");
  dust.streams[0].push({ type: "agent_message_success", message: { configuration: { maxStepsPerRun: 1 }, actions: [{ step: 0 }] } });
  expect((await turn.deltas.next()).value).toEqual({ type: "text", text: "partial" });
  controller.abort();
  await expect(turn.deltas.next()).rejects.toThrow("interrupted");
  expect(dust.api.postUserMessage).not.toHaveBeenCalled();
});

it("tracks each automatic continuation as a separate owned generation", async () => {
  const turn = await startTurn(input());
  dust.streams[0].push({ type: "agent_message_success", message: { configuration: { maxStepsPerRun: 1 }, actions: [{ step: 0 }] } });
  const response = drain(turn.deltas);
  await vi.waitFor(() => expect(dust.streams.length).toBe(2));
  expect(store.active(sessionKey("session", "a", "prompt"))?.messageIds).toEqual(["agent-user-2"]);
  dust.streams[1].text("complete"); dust.streams[1].success();
  expect((await response).filter((event) => event.type === "done")).toHaveLength(1);
  expect(dust.api.cancelMessageGeneration).not.toHaveBeenCalled();
});
