import { describe, expect, it, vi } from "vitest";

import { cancelRecovered, Generation } from "../src/dust/generation";
import { deferred, err, fakeDust, ok } from "./dustHarness";

const conversation = { sId: "c", content: [] };

describe("remote generation ownership", () => {
  it("cancels only the agent message descended from our POST, exactly once", async () => {
    const { api } = fakeDust();
    const run = new Generation(api as any);
    await run.open(conversation, "u");
    await Promise.all([run.cancel(), run.cancel()]);
    await run.cancel();
    expect(api.cancelMessageGeneration).toHaveBeenCalledTimes(1);
    expect(api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "c", messageIds: ["agent-u"] });
  });

  it("learns the remote id before cancelling an interrupted POST", async () => {
    const { api } = fakeDust();
    const wait = deferred<any>();
    api.waitForAgentMessage.mockImplementationOnce(() => wait.promise);
    const run = new Generation(api as any);
    const opened = run.open(conversation, "u");
    const rejected = expect(opened).rejects.toThrow("interrupted");
    await run.cancel();
    wait.resolve(ok({ sId: "late-agent" }));
    await rejected;
    expect(api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "c", messageIds: ["late-agent"] });
    expect(api.streamAgentMessageEvents).not.toHaveBeenCalled();
  });

  it("does not cancel a confirmed completed turn", async () => {
    const { api, streams } = fakeDust();
    const persisted = vi.fn(async () => {});
    const run = new Generation(api as any, persisted);
    const events = await run.open(conversation, "u");
    streams[0].success(); streams[0].end();
    for await (const _ of events) { /* drain */ }
    await run.cancel();
    expect(run.terminal).toBe(true);
    expect(api.cancelMessageGeneration).not.toHaveBeenCalled();
    expect(persisted).toHaveBeenLastCalledWith(undefined);
  });

  it("does not let late terminal events clear a newer run's persisted state", async () => {
    const { api, streams } = fakeDust();
    const persisted = vi.fn(async () => {});
    const run = new Generation(api as any, persisted);
    const events = await run.open(conversation, "u");
    await run.cancel();
    persisted.mockClear();
    streams[0].success();
    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("interrupted");
    expect(persisted).not.toHaveBeenCalled();
  });

  it("keeps cancellation retryable when Dust refuses it", async () => {
    const { api } = fakeDust();
    api.cancelMessageGeneration.mockResolvedValueOnce(err("internal_server_error") as any);
    const persisted = vi.fn(async () => {});
    const run = new Generation(api as any, persisted);
    await run.open(conversation, "u");
    await expect(run.cancel()).rejects.toThrow("cancellation failed");
    expect(persisted).not.toHaveBeenCalledWith(undefined);
    await run.cancel();
    expect(persisted).toHaveBeenLastCalledWith(undefined);
  });

  it("still identifies and cancels the remote turn when persistence fails", async () => {
    const { api } = fakeDust();
    const persist = vi.fn(async () => { throw new Error("disk full"); });
    const run = new Generation(api as any, persist);
    await expect(run.open(conversation, "u")).rejects.toThrow("disk full");
    expect(api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "c", messageIds: ["agent-u"] });
  });

  it("recovers an interrupted run whose agent id was not persisted yet", async () => {
    const { api } = fakeDust();
    await cancelRecovered(api as any, "c", { userMessageId: "owned-user", messageIds: [] });
    expect(api.waitForAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ parentUserMessageId: "owned-user" }));
    expect(api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "c", messageIds: ["agent-owned-user"] });
  });
});
