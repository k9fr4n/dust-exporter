#!/usr/bin/env node
// Must be first: patches global fetch to work around the Dust SSE redirect bug
// (dust-tt#26472) before the SDK issues any streaming request.
import "./fetchPatch";

import AuthService from "./auth/authService";
import { getDustClient, resetDustClient } from "./auth/dustClient";
import TokenStorage from "./auth/tokenStorage";
import { loadConfig } from "./config";
import { listAgents, modelIds } from "./dust/agents";
import { errorMessage } from "./errors";
import { createServer } from "./server";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const args: Args = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else positionals.push(a);
  }
  return { cmd: positionals[0] || "serve", args };
}

function out(line = ""): void { process.stdout.write(`${line}\n`); }

async function cmdServe(args: Args): Promise<void> {
  const overrides: Partial<ReturnType<typeof loadConfig>> = {};
  if (args.port) overrides.port = Number(args.port);
  if (typeof args.host === "string") overrides.host = args.host;
  if (typeof args.agent === "string") overrides.defaultAgent = args.agent;
  if (args["with-tools"]) overrides.withTools = true;
  if (args["client-tools"]) overrides.clientTools = true;
  if (typeof args["title-prefix"] === "string") overrides.titlePrefix = args["title-prefix"];
  if (args["max-continuations"] !== undefined) overrides.maxContinuations = Number(args["max-continuations"]);
  if (args.ephemeral) overrides.ephemeral = true;
  if (args.persistent) overrides.ephemeral = false;
  if (typeof args["api-key"] === "string") overrides.proxyApiKey = args["api-key"];
  const cfg = loadConfig(overrides);

  const authed = await AuthService.isAuthenticated();
  const server = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    out(`dust-exporter listening on http://${cfg.host}:${cfg.port}`);
    out(`  OpenAI:    POST http://${cfg.host}:${cfg.port}/v1/chat/completions`);
    out(`  Anthropic: POST http://${cfg.host}:${cfg.port}/v1/messages`);
    out(`  Models:    GET  http://${cfg.host}:${cfg.port}/v1/models`);
    out(`  auth: ${authed ? "shared dust-cli session OK" : "NOT authenticated - run `dust login` or `npm run login`"}`);
    out(`  local tools: ${cfg.withTools ? "enabled (reverse-MCP)" : "disabled"}`);
    out(`  client-tools passthrough: ${cfg.clientTools ? "enabled (Claude Code tools -> Dust agent)" : "disabled"}`);
    out(`  conversations: ${cfg.ephemeral ? "ephemeral (auto-deleted each turn)" : "persistent (reused via fingerprint)"}`);
    out(`  title prefix: ${cfg.titlePrefix ? JSON.stringify(cfg.titlePrefix) : "(none, Dust auto-titles)"}`);
    out(`  step-cap auto-continuation: ${cfg.maxContinuations > 0 ? `up to ${cfg.maxContinuations} round(s)` : "disabled"}`);
    if (cfg.proxyApiKey) out("  proxy API key: required on /v1/*");
  });
}

async function cmdLogin(args: Args): Promise<void> {
  const dc = await AuthService.startDeviceFlow();
  out("To authenticate, visit:");
  out(`  ${dc.verification_uri_complete}`);
  out(`and confirm the code: ${dc.user_code}`);
  out("Waiting for confirmation...");
  await AuthService.pollDeviceFlow(dc);
  resetDustClient();

  const api = await getDustClient();
  if (!api) throw new Error("Login completed but no token was stored.");
  const me = await api.me();
  if (me.isErr()) throw new Error(`me() failed: ${me.error.message}`);

  let workspaceId = await TokenStorage.getWorkspaceId();
  if (!workspaceId) {
    const wanted = typeof args.workspace === "string" ? args.workspace : null;
    const ws = me.value.workspaces;
    const chosen = wanted ? ws.find((w: any) => w.sId === wanted || w.name === wanted) : ws[0];
    if (!chosen) throw new Error(`Workspace not found. Available: ${ws.map((w: any) => `${w.sId} (${w.name})`).join(", ")}`);
    await TokenStorage.saveWorkspaceId(chosen.sId);
    workspaceId = chosen.sId;
    resetDustClient();
  }
  out(`Logged in as ${me.value.email} | workspace ${workspaceId}`);
}

async function cmdStatus(): Promise<void> {
  const backend = await TokenStorage.getBackendName();
  const region = await TokenStorage.getRegion();
  const workspace = await TokenStorage.getWorkspaceId();
  const authed = await AuthService.isAuthenticated();
  out(`credential backend: ${backend}`);
  out(`region: ${region ?? "(unset)"}`);
  out(`workspace: ${workspace ?? "(unset)"}`);
  out(`authenticated: ${authed}`);
  if (authed) {
    const api = await getDustClient();
    if (api) {
      const me = await api.me();
      if (me.isOk()) out(`user: ${me.value.email}`);
      try {
        const agents = await listAgents(api, true);
        out(`agents available: ${agents.length}`);
      } catch (e) {
        out(`agents: error (${errorMessage(e)})`);
      }
    }
  }
}

async function cmdModels(): Promise<void> {
  const api = await getDustClient();
  if (!api) throw new Error("Not authenticated with Dust. Run `npm run login` (or `dust login`).");
  const agents = await listAgents(api, true);
  const ids = modelIds(agents);

  const rows = agents
    .map((a) => ({ id: ids.get(a.sId) ?? a.sId, name: a.name || "(unnamed)", sId: a.sId }))
    .sort((x, y) => x.id.localeCompare(y.id));
  const w = Math.max(2, ...rows.map((r) => r.id.length));
  out(`${"id".padEnd(w)}  display name (sId)`);
  for (const r of rows) out(`${r.id.padEnd(w)}  ${r.name} (${r.sId})`);
  out("");
  out(`${rows.length} agent(s). Send any id above as \`model\`.`);
}

async function cmdLogout(): Promise<void> {
  await AuthService.logout();
  resetDustClient();
  out("Logged out (cleared shared dust-cli session).");
}

function cmdHelp(): void {
  out("dust-exporter - OpenAI/Anthropic-compatible proxy for Dust agents");
  out("");
  out("Usage: dust-exporter <command> [options]");
  out("");
  out("Commands:");
  out("  serve     Start the proxy server (default)");
  out("  login     Authenticate via WorkOS device flow (shared with dust-cli)");
  out("  status    Show authentication status");
  out("  models    List the Dust agents exposed as models");
  out("  logout    Clear the shared session");
  out("  help      Show this help");
  out("");
  out("serve options:");
  out("  --port <n>        Port (default 8787)");
  out("  --host <h>        Host (default 127.0.0.1)");
  out("  --agent <id>      Default agent sId/name when model does not match");
  out("  --api-key <k>     Require this key as Bearer/x-api-key on /v1/*");
  out("  --with-tools      Expose local filesystem tools (reverse-MCP, OAuth)");
  out("  --client-tools    Bridge the client's own tools (Claude Code) into the Dust agent");
  out("  --persistent      Reuse Dust conversations across turns (default: ephemeral)");
  out("  --ephemeral       Delete the Dust conversation after each turn (default)");
  out('  --title-prefix <s> Prefix for created conversation titles (default "PROXY: ", "" to disable)');
  out("  --max-continuations <n> Auto-resume runs cut off by the agent step cap (default 4, 0 to disable)");
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "serve": return cmdServe(args);
    case "login": return cmdLogin(args);
    case "status": return cmdStatus();
    case "models": return cmdModels();
    case "logout": return cmdLogout();
    case "help": case "--help": return cmdHelp();
    default:
      out(`Unknown command: ${cmd}`);
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${errorMessage(e)}\n`);
  process.exitCode = 1;
});
