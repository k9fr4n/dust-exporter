import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mcp = vi.hoisted(() => ({ handlers: [] as ((req: any) => Promise<any>)[], closes: [] as (() => void)[] }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
  setRequestHandler(schema: any, handler: any) { if (schema.shape.method.value === "tools/call") mcp.handlers.push(handler); }
  async connect(transport: any) { await transport.start(); }
} }));
vi.mock("../src/dust/mcpFsServer", () => ({ ReverseMcpTransport: class {
  constructor(_api: any, private registered: (id: string) => void) {}
  async start() { this.registered("mcp-test"); }
  async close() { mcp.closes.push(() => {}); }
} }));

import { handleClientToolsRequestJSON, SessionRegistry } from "../src/dust/clientToolsSession";
import { parseMessagesFull } from "../src/protocols/anthropic";
import { deferred, err, fakeDust, ok } from "./dustHarness";

function parsed(first = "original", last: any = "next") {
  return parseMessagesFull({ model: "m", system: "system rules", metadata: { user_id: "session" },
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: first }, { role: "assistant", content: "prior answer" }, { role: "user", content: last }],
  });
}
const registries: SessionRegistry[] = [];
const dusts: ReturnType<typeof fakeDust>[] = [];
function setup(timeout = 1_200_000, store?: any) {
  const dust = fakeDust(); dusts.push(dust);
  const registry = new SessionRegistry(store, timeout); registries.push(registry);
  const request = (p = parsed(), signal?: AbortSignal) => handleClientToolsRequestJSON({ parsed: p, agentId: "agent", api: dust.api as any, registry, titlePrefix: "", signal });
  return { ...dust, registry, request };
}
beforeEach(() => { mcp.handlers.length = 0; mcp.closes.length = 0; });
afterEach(async () => {
  vi.useRealTimers();
  for (const registry of registries.splice(0)) await registry.close();
  for (const dust of dusts.splice(0)) for (const stream of dust.streams) stream.end();
});

describe("client-tools lifecycle", () => {
  it("shares one session across concurrent lookups", async () => {
    const gate = deferred<void>();
    const { registry, api } = setup(1000, { load: () => gate.promise, get: () => undefined, flush: async () => {} });
    const a = registry.get(parsed(), "agent", api as any, "");
    const b = registry.get(parsed(), "agent", api as any, "");
    gate.resolve();
    expect(await a).toBe(await b);
  });

  it("replays history and system when compaction forces a new isolated branch", async () => {
    const { request, api, streams } = setup();
    const one = request(); await vi.waitFor(() => expect(streams.length).toBe(1));
    streams[0].success(); await one;
    const two = request(parsed("compacted summary")); await vi.waitFor(() => expect(streams.length).toBe(2));
    streams[1].success(); await two;
    const content = api.createConversation.mock.calls[1][0].message.content;
    expect(content).toContain("system rules");
    expect(content).toContain("compacted summary");
    expect(content).toContain("prior answer");
    expect(content).toContain("next");
  });

  it.each(["rate_limit_error", "internal_server_error", "not_authenticated", "unexpected_network_error"])("never recreates a conversation on %s", async (type) => {
    const { request, api, registry } = setup();
    (await registry.get(parsed(), "agent", api as any, "")).conversationId = "existing";
    api.postUserMessage.mockResolvedValueOnce(err(type) as any);
    await expect(request()).rejects.toThrow("postUserMessage failed");
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("replays context only when Dust explicitly reports a missing conversation", async () => {
    const { request, api, registry, streams } = setup();
    (await registry.get(parsed(), "agent", api as any, "")).conversationId = "deleted";
    api.postUserMessage.mockResolvedValueOnce(err("conversation_not_found") as any);
    const response = request(); await vi.waitFor(() => expect(streams.length).toBe(1));
    streams[0].success(); await response;
    expect(api.createConversation.mock.calls[0][0].message.content).toContain("prior answer");
    expect(api.createConversation.mock.calls[0][0].message.content).toContain("system rules");
  });

  it("cancels on disconnect and cannot deliver the old run into its replacement", async () => {
    const { request, api, streams } = setup();
    const controller = new AbortController();
    const old = request(parsed(), controller.signal);
    const oldRejected = expect(old).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(streams.length).toBe(1));
    controller.abort(); await oldRejected;
    const next = request(); await vi.waitFor(() => expect(streams.length).toBe(2));
    streams[0].text("OLD"); streams[0].success();
    streams[1].text("NEW"); streams[1].success();
    expect((await next).content).toEqual([{ type: "text", text: "NEW" }]);
    expect(api.cancelMessageGeneration).toHaveBeenCalledTimes(1);
  });

  it("rejects simultaneous consumers instead of splitting a response", async () => {
    const { request, streams } = setup();
    const first = request(); await vi.waitFor(() => expect(streams.length).toBe(1));
    await expect(request()).rejects.toThrow("already consuming");
    streams[0].success(); await first;
  });

  it("keeps the Dust run alive after tool_use and routes its result across a changed anchor", async () => {
    const { request, streams, api } = setup();
    const response = request(); await vi.waitFor(() => expect(streams.length).toBe(1));
    const toolResult = mcp.handlers[0]({ params: { name: "Read", arguments: { path: "x" } } });
    const use: any = await response;
    expect(use.stop_reason).toBe("tool_use");
    expect(api.cancelMessageGeneration).not.toHaveBeenCalled();
    const id = use.content[0].id;
    const resumed = request(parsed("summary with a changed anchor", [
      { type: "tool_result", tool_use_id: id, content: "permission denied", is_error: true },
      { type: "text", text: "Do not retry this file" },
    ]));
    const result = await toolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Do not retry this file");
    streams[0].success(); await resumed;
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.postUserMessage).not.toHaveBeenCalled();
  });

  it("rejects unknown and duplicate results without resolving any parked call", async () => {
    const { request, streams } = setup();
    const response = request(); await vi.waitFor(() => expect(streams.length).toBe(1));
    const tool = mcp.handlers[0]({ params: { name: "Read" } });
    const use: any = await response;
    const result = { type: "tool_result", tool_use_id: use.content[0].id, content: "ok" };
    await expect(request(parsed("original", [result, result]))).rejects.toThrow("duplicate");
    await expect(request(parsed("original", [{ ...result, tool_use_id: "unknown" }]))).rejects.toThrow("Unknown");
    const resumed = request(parsed("original", [result]));
    await tool;
    streams[0].success(); await resumed;
  });

  it("recovers a persisted orphan without posting tool output as a new prompt", async () => {
    let active: any = { userMessageId: "owned", messageIds: ["agent-owned"] };
    const store = { load: async () => {}, get: () => "persisted", active: () => active,
      set: async (_key: string, _id: string, next: any) => { active = next; }, flush: async () => {} };
    const { request, api } = setup(1000, store);
    await expect(request(parsed("original", [{ type: "tool_result", tool_use_id: "lost", content: "output" }]))).rejects.toThrow("orphaned");
    expect(api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "persisted", messageIds: ["agent-owned"] });
    expect(api.postUserMessage).not.toHaveBeenCalled();
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("cancels an abandoned tool wait but not a long active stream", async () => {
    vi.useFakeTimers();
    const { request, streams, api } = setup(1000);
    const response = request();
    await vi.waitFor(() => expect(streams.length).toBe(1));
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(api.cancelMessageGeneration).not.toHaveBeenCalled();
    const tool = mcp.handlers[0]({ params: { name: "Read" } });
    await vi.advanceTimersByTimeAsync(200);
    expect((await response).stop_reason).toBe("tool_use");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.cancelMessageGeneration).toHaveBeenCalledTimes(1);
    expect((await tool).isError).toBe(true);
  });

  it("cancels a turn whose POST completes after the HTTP client has left", async () => {
    const { request, api } = setup();
    const created = deferred<any>();
    api.createConversation.mockImplementationOnce(() => created.promise);
    const controller = new AbortController();
    const response = request(parsed(), controller.signal);
    const rejection = expect(response).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(api.createConversation).toHaveBeenCalledTimes(1));
    controller.abort();
    created.resolve(ok({ conversation: { sId: "late", content: [] }, message: { sId: "late-user" } }));
    await rejection;
    expect(api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "late", messageIds: ["agent-late-user"] });
  });
});
