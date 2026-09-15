import { request as httpRequest } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), tool: null as null | ((req: any) => Promise<any>) }));
vi.mock("../src/auth/dustClient", () => ({ getDustClient: mocks.client }));
vi.mock("../src/dust/agents", () => ({ listAgents: async () => [], matchAgent: () => "agent", modelIds: () => new Map() }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
  setRequestHandler(schema: any, handler: any) { if (schema.shape.method.value === "tools/call") mocks.tool = handler; }
  async connect(transport: any) { await transport.start(); }
} }));
vi.mock("../src/dust/mcpFsServer", () => ({ ReverseMcpTransport: class {
  constructor(_api: any, private registered: (id: string) => void) {}
  async start() { this.registered("mcp-http"); }
  async close() {}
} }));

import { createServer, type ProxyServer } from "../src/server";
import { loadConfig } from "../src/config";
import { deferred, fakeDust } from "./dustHarness";

let server: ProxyServer;
let directory: string;
let dust: ReturnType<typeof fakeDust>;
let port: number;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "dust-http-"));
  dust = fakeDust(); mocks.client.mockReset().mockResolvedValue(dust.api); mocks.tool = null;
});
afterEach(async () => {
  for (const stream of dust.streams) stream.end();
  await server?.shutdown();
  await fs.rm(directory, { recursive: true, force: true });
});
async function listen(clientTools = false) {
  server = createServer(loadConfig({ clientTools, withTools: false, ephemeral: false, proxyApiKey: null, stateFile: join(directory, "state.json") }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
}
function post(stream: boolean, path = "/v1/messages") {
  const firstByte = deferred<void>();
  const result = deferred<{ status: number; text: string }>();
  const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
    let text = "";
    res.on("data", (chunk) => { text += chunk.toString(); firstByte.resolve(); });
    res.on("end", () => result.resolve({ status: res.statusCode!, text }));
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.end(JSON.stringify({ model: "m", stream, metadata: { user_id: "session" }, tools: [{ name: "Read", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hello" }] }));
  return { req, result: result.promise, firstByte: firstByte.promise };
}

describe("real HTTP request lifecycle", () => {
  it.each([false, true])("cancels a disconnected standard request (stream=%s)", async (stream) => {
    await listen();
    const client = post(stream);
    await vi.waitFor(() => expect(dust.streams.length).toBe(1));
    if (stream) await client.firstByte;
    client.req.destroy();
    await vi.waitFor(() => expect(dust.api.cancelMessageGeneration).toHaveBeenCalledTimes(1));
    expect(dust.api.cancelMessageGeneration).toHaveBeenCalledWith({ conversationId: "conversation", messageIds: ["agent-user-1"] });
    dust.streams[0].end();
  });

  it.each([false, true])("cancels a disconnected client-tools request (stream=%s)", async (stream) => {
    await listen(true);
    const client = post(stream);
    await vi.waitFor(() => expect(dust.streams.length).toBe(1));
    if (stream) await client.firstByte;
    client.req.destroy();
    await vi.waitFor(() => expect(dust.api.cancelMessageGeneration).toHaveBeenCalledTimes(1));
  });

  it("does not launch a turn if the response closes during authentication", async () => {
    await listen();
    const auth = deferred<any>(); mocks.client.mockReturnValueOnce(auth.promise);
    const client = post(false);
    await vi.waitFor(() => expect(mocks.client).toHaveBeenCalled());
    client.req.destroy();
    // Wait for the server-side close event, not just the local destroy call.
    await vi.waitFor(() => expect(client.req.destroyed).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    auth.resolve(dust.api);
    await server.shutdown();
    expect(dust.api.createConversation).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not cancel normal completion (stream=%s)", async (stream) => {
    await listen();
    const client = post(stream);
    await vi.waitFor(() => expect(dust.streams.length).toBe(1));
    dust.streams[0].text("answer"); dust.streams[0].success();
    const response = await client.result;
    expect(response.status).toBe(200);
    expect(response.text).toContain("answer");
    expect(dust.api.cancelMessageGeneration).not.toHaveBeenCalled();
  });

  it("keeps tool_use alive after a normal HTTP response, then cancels on shutdown", async () => {
    await listen(true);
    const client = post(false);
    await vi.waitFor(() => expect(dust.streams.length).toBe(1));
    const tool = mocks.tool!({ params: { name: "Read" } });
    const response = await client.result;
    expect(JSON.parse(response.text).stop_reason).toBe("tool_use");
    expect(dust.api.cancelMessageGeneration).not.toHaveBeenCalled();
    await server.shutdown();
    expect(dust.api.cancelMessageGeneration).toHaveBeenCalledTimes(1);
    expect((await tool).isError).toBe(true);
  });

  it("returns an error rather than JSON success after partial text", async () => {
    await listen();
    const client = post(false);
    await vi.waitFor(() => expect(dust.streams.length).toBe(1));
    dust.streams[0].text("partial");
    dust.streams[0].push({ type: "agent_error", error: { message: "failed midway" } });
    const response = await client.result;
    expect(response.status).toBe(502);
    expect(JSON.parse(response.text).error.message).toBe("failed midway");
  });

  it("also cancels disconnected OpenAI requests", async () => {
    await listen();
    const client = post(true, "/v1/chat/completions");
    await client.firstByte;
    client.req.destroy();
    await vi.waitFor(() => expect(dust.api.cancelMessageGeneration).toHaveBeenCalledTimes(1));
    dust.streams[0].end();
  });
});
