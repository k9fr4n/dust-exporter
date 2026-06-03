// OPTIONAL / EXPERIMENTAL: expose local filesystem + shell tools to the Dust
// agent using the same "reverse MCP" pattern as the official dust-cli. The
// agent loop runs server-side on Dust; tool *execution* happens here, locally.
// Requires OAuth (MCP registration rejects sk- API keys). Off by default.
import type { DustAPI } from "@dust-tt/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { log } from "../logger";

const execAsync = promisify(exec);
const HEARTBEAT_MS = 15 * 60 * 1000;
const RECONNECT_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ReverseMcpTransport implements Transport {
  private running = false;
  private serverId: string | null = null;
  private lastEventId: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  sessionId?: string;

  constructor(
    private readonly api: DustAPI,
    private readonly onServerId: (id: string) => void,
    private readonly serverName = "fs-cli",
  ) {}

  async start(): Promise<void> {
    const reg = await this.api.registerMCPServer({ serverName: this.serverName });
    if (reg.isErr()) throw new Error(`registerMCPServer failed: ${reg.error.message}`);
    this.serverId = reg.value.serverId;
    this.onServerId(this.serverId);
    this.heartbeat = setInterval(async () => {
      if (!this.serverId) return;
      const r = await this.api.heartbeatMCPServer({ serverId: this.serverId });
      if (r.isErr() || !r.value.success) {
        const re = await this.api.registerMCPServer({ serverName: this.serverName });
        if (re.isOk()) { this.serverId = re.value.serverId; this.onServerId(this.serverId); }
      }
    }, HEARTBEAT_MS);
    this.running = true;
    void this.readLoop();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.serverId) return;
    const r = await this.api.postMCPResults({ serverId: this.serverId, result: message as any });
    if (r.isErr()) this.onerror?.(new Error(`postMCPResults failed: ${r.error.message}`));
  }

  async close(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.onclose?.();
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      try {
        const conn = await this.api.getMCPRequestsConnectionDetails({
          serverId: this.serverId!,
          lastEventId: this.lastEventId,
        });
        if (conn.isErr()) throw new Error(conn.error.message);
        this.abort = new AbortController();
        const res = await fetch(conn.value.url, { headers: conn.value.headers, signal: this.abort.signal });
        if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const e of events) {
            let data = "";
            for (const line of e.split("\n")) if (line.startsWith("data: ")) data += line.slice(6);
            if (!data || data === "done") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.eventId) this.lastEventId = parsed.eventId;
              if (parsed.data) this.onmessage?.(parsed.data);
            } catch { /* ignore keep-alives */ }
          }
        }
      } catch (e) {
        if (!this.running) break;
        // Expected: Dust closes idle SSE connections; we reconnect with lastEventId.
        log.debug("MCP read loop reconnecting", e instanceof Error ? e.message : String(e));
        await sleep(RECONNECT_MS);
      }
    }
  }
}

const MAX_READ = 256 * 1024;
function inside(path: string): string {
  // Resolve against cwd; allow absolute paths but keep them resolved.
  return resolve(path);
}
function ok(text: string) { return { content: [{ type: "text" as const, text }] }; }

function registerTools(server: McpServer) {
  server.registerTool(
    "read_file",
    { description: "Read a UTF-8 text file from the local filesystem.", inputSchema: { path: z.string() } },
    async ({ path }) => {
      const data = await fs.readFile(inside(path), "utf-8");
      return ok(data.length > MAX_READ ? data.slice(0, MAX_READ) + "\n[truncated]" : data);
    },
  );
  server.registerTool(
    "list_files",
    { description: "List entries of a local directory.", inputSchema: { path: z.string() } },
    async ({ path }) => {
      const entries = await fs.readdir(inside(path), { withFileTypes: true });
      return ok(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n"));
    },
  );
  server.registerTool(
    "search_text",
    {
      description: "Recursively search for a substring under a directory (first 100 matches).",
      inputSchema: { path: z.string(), query: z.string() },
    },
    async ({ path, query }) => {
      const matches: string[] = [];
      const walk = async (dir: string, depth: number) => {
        if (depth > 6 || matches.length >= 100) return;
        let entries: any[] = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (matches.length >= 100) break;
          if (e.name === "node_modules" || e.name === ".git") continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full, depth + 1);
          else {
            try {
              const txt = await fs.readFile(full, "utf-8");
              txt.split("\n").forEach((line, i) => {
                if (matches.length < 100 && line.includes(query)) matches.push(`${full}:${i + 1}: ${line.trim()}`);
              });
            } catch { /* skip binary/unreadable */ }
          }
        }
      };
      await walk(inside(path), 0);
      return ok(matches.length ? matches.join("\n") : "No matches.");
    },
  );
  server.registerTool(
    "write_file",
    { description: "Write (create/overwrite) a UTF-8 text file.", inputSchema: { path: z.string(), content: z.string() } },
    async ({ path, content }) => {
      await fs.writeFile(inside(path), content, "utf-8");
      return ok(`Wrote ${content.length} bytes to ${path}`);
    },
  );
  server.registerTool(
    "run_command",
    { description: "Run a shell command and return its output.", inputSchema: { command: z.string(), cwd: z.string().optional() } },
    async ({ command, cwd }) => {
      try {
        const { stdout, stderr } = await execAsync(command, { cwd: cwd ? inside(cwd) : undefined, timeout: 60_000, maxBuffer: MAX_READ });
        return ok(`exit 0\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      } catch (e: any) {
        return ok(`exit ${e?.code ?? 1}\n--- stdout ---\n${e?.stdout ?? ""}\n--- stderr ---\n${e?.stderr ?? e?.message ?? ""}`);
      }
    },
  );
}

let cachedServerId: string | null = null;
let booting: Promise<string | null> | null = null;

/** Boot the local fs MCP server once and return its serverId (or null on
 *  failure, e.g. API-key auth). Safe to call on every request. */
export async function ensureFsServer(api: DustAPI): Promise<string | null> {
  if (cachedServerId) return cachedServerId;
  if (booting) return booting;
  booting = (async () => {
    const apiKey = await api.getApiKey();
    if (apiKey?.startsWith("sk-")) {
      log.warn("local tools require OAuth (sk- API keys cannot register an MCP server) - disabling tools");
      return null;
    }
    try {
      const server = new McpServer({ name: "fs-cli", version: "1.0.0" });
      registerTools(server);
      const transport = new ReverseMcpTransport(api, (id) => { cachedServerId = id; });
      await server.connect(transport);
      for (let i = 0; i < 50 && !cachedServerId; i++) await sleep(100);
      log.info("local fs MCP server registered", cachedServerId);
      return cachedServerId;
    } catch (e) {
      log.error("failed to boot fs MCP server", e instanceof Error ? e.message : String(e));
      return null;
    }
  })();
  return booting;
}
