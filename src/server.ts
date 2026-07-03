import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { DustAPI } from "@dust-tt/client";

import { getDustClient } from "./auth/dustClient";
import type { Config } from "./config";
import { listAgents, matchAgent } from "./dust/agents";
import { handleClientToolsRequest, SessionRegistry } from "./dust/clientToolsSession";
import { startTurn } from "./dust/runner";
import { HttpError, errorMessage } from "./errors";
import { log } from "./logger";
import * as anthropic from "./protocols/anthropic";
import * as openai from "./protocols/openai";
import { ConversationStore } from "./state/store";

type Flavor = "openai" | "anthropic";
const BODY_LIMIT = 25 * 1024 * 1024;

export function createServer(cfg: Config): Server {
  const store = new ConversationStore(cfg.stateFile);
  const registry = new SessionRegistry(store);
  let toolServerIds: string[] | null = null;

  async function maybeTools(api: DustAPI): Promise<string[] | null> {
    if (!cfg.withTools) return null;
    if (toolServerIds) return toolServerIds;
    const { ensureFsServer } = await import("./dust/mcpFsServer");
    const id = await ensureFsServer(api);
    toolServerIds = id ? [id] : null;
    return toolServerIds;
  }

  async function clientOrThrow(): Promise<DustAPI> {
    const api = await getDustClient();
    if (!api) {
      throw new HttpError(
        401,
        "Not authenticated with Dust. Run `dust login` (official CLI) or `npm run login`.",
        "authentication_error",
      );
    }
    return api;
  }

  async function resolveAgentOrThrow(api: DustAPI, model: string): Promise<string> {
    const agents = await listAgents(api);
    const id = matchAgent(agents, model, cfg.defaultAgent);
    if (!id) {
      throw new HttpError(404, `No Dust agent matches model "${model}". See GET /v1/models.`, "model_not_found");
    }
    return id;
  }

  async function handleModels(res: ServerResponse): Promise<void> {
    const api = await clientOrThrow();
    json(res, 200, openai.modelsList(await listAgents(api, true)));
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = openai.parseChatRequest(await readJson(req));
    const api = await clientOrThrow();
    const agentId = await resolveAgentOrThrow(api, parsed.model);
    const tools = await maybeTools(api);
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());
    const turn = await startTurn({
      api, agentId, messages: parsed.messages, system: parsed.system,
      store, clientSideMCPServerIds: tools, signal: ctrl.signal, ephemeral: cfg.ephemeral,
      titlePrefix: cfg.titlePrefix, maxContinuations: cfg.maxContinuations,
    });
    const id = openai.newId();
    if (parsed.stream) {
      beginSse(res);
      for await (const s of openai.openaiStream(id, parsed.model, turn.deltas)) res.write(s);
      res.end();
    } else {
      json(res, 200, await openai.openaiCollect(id, parsed.model, turn.deltas));
    }
  }

  async function handleCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = anthropic.parseMessagesRequest(await readJson(req));
    json(res, 200, { input_tokens: anthropic.estimateInputTokens(parsed) });
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const api = await clientOrThrow();

    // Client-tools passthrough: when enabled and the request carries a session
    // id + its own tools (Claude Code), bridge those tools into the Dust agent.
    if (cfg.clientTools) {
      const full = anthropic.parseMessagesFull(body);
      if (full.sessionId && full.tools.length > 0) {
        const agentId = await resolveAgentOrThrow(api, full.model);
        beginSse(res);
        await handleClientToolsRequest({ res, parsed: full, agentId, api, registry, titlePrefix: cfg.titlePrefix });
        res.end();
        return;
      }
    }

    const parsed = anthropic.parseMessagesRequest(body);
    const agentId = await resolveAgentOrThrow(api, parsed.model);
    const tools = await maybeTools(api);
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());
    const turn = await startTurn({
      api, agentId, messages: parsed.messages, system: parsed.system, sessionId: parsed.sessionId,
      store, clientSideMCPServerIds: tools, signal: ctrl.signal, ephemeral: cfg.ephemeral,
      titlePrefix: cfg.titlePrefix, maxContinuations: cfg.maxContinuations,
    });
    const id = anthropic.newMsgId();
    if (parsed.stream) {
      beginSse(res);
      for await (const s of anthropic.anthropicStream(id, parsed.model, turn.deltas)) res.write(s);
      res.end();
    } else {
      json(res, 200, await anthropic.anthropicCollect(id, parsed.model, turn.deltas));
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (path === "/health" || path === "/") {
      json(res, 200, { ok: true, service: "dust-exporter", tools: cfg.withTools });
      return;
    }
    const flavor: Flavor = path.startsWith("/v1/messages") ? "anthropic" : "openai";
    if (!checkAuth(req, cfg)) {
      sendError(res, flavor, new HttpError(401, "Missing or invalid API key.", "authentication_error"));
      return;
    }
    try {
      if (req.method === "GET" && path === "/v1/models") return await handleModels(res);
      if (req.method === "POST" && path === "/v1/chat/completions") return await handleChat(req, res);
      if (req.method === "POST" && path === "/v1/messages/count_tokens") return await handleCountTokens(req, res);
      if (req.method === "POST" && path === "/v1/messages") return await handleMessages(req, res);
      sendError(res, flavor, new HttpError(404, `Not found: ${req.method} ${path}`, "not_found"));
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(500, errorMessage(e), "server_error");
      if (!res.headersSent) sendError(res, flavor, he);
      else { try { writeSseError(res, flavor, he.message); res.end(); } catch { /* socket gone */ } }
    }
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error("unhandled", errorMessage(e));
      if (!res.headersSent) sendError(res, "openai", new HttpError(500, errorMessage(e), "server_error"));
      else try { res.end(); } catch { /* ignore */ }
    });
  });
}

// --- helpers ---
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-api-key, anthropic-version, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}
function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}
function beginSse(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
function checkAuth(req: IncomingMessage, cfg: Config): boolean {
  if (!cfg.proxyApiKey) return true;
  const auth = req.headers["authorization"];
  const xkey = req.headers["x-api-key"];
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return bearer === cfg.proxyApiKey || xkey === cfg.proxyApiKey;
}
function sendError(res: ServerResponse, flavor: Flavor, err: HttpError): void {
  const body =
    flavor === "anthropic"
      ? { type: "error", error: { type: err.type, message: err.message } }
      : { error: { message: err.message, type: err.type, code: null } };
  json(res, err.status, body);
}
function writeSseError(res: ServerResponse, flavor: Flavor, message: string): void {
  if (flavor === "anthropic") {
    res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
}
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new HttpError(413, "Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, "Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
