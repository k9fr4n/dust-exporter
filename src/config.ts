import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  host: string;
  port: number;
  proxyApiKey: string | null;
  defaultAgent: string | null;
  withTools: boolean;
  clientTools: boolean;
  ephemeral: boolean;
  /** Prefix prepended to every Dust conversation title created by the proxy.
   *  Empty string disables custom titling (Dust auto-titles instead). */
  titlePrefix: string;
  /** Max number of automatic continuation rounds when a Dust run is cut off by
   *  the agent's `maxStepsPerRun` cap. Each round reposts a "continue" message
   *  on the same (stateful) conversation, getting a fresh step budget. 0 = off. */
  maxContinuations: number;
  workosDomain: string;
  workosClientId: string;
  workosClaimNamespace: string;
  domains: { default: string; us: string; eu: string };
  stateFile: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function bool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] || "").toLowerCase());
}
/** Parse a non-negative integer env var, falling back to `fallback` when unset,
 *  empty, or not a finite number >= 0. */
function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: env("DUST_PROXY_HOST", "127.0.0.1"),
    port: Number(env("DUST_PROXY_PORT", "8787")),
    proxyApiKey: process.env.DUST_PROXY_API_KEY || null,
    defaultAgent: process.env.DUST_PROXY_DEFAULT_AGENT || null,
    withTools: bool("DUST_PROXY_WITH_TOOLS"),
    // Passthrough of the client's own tools (Claude Code) into the Dust agent
    // via dynamically-registered reverse-MCP. Session-keyed (metadata.user_id).
    clientTools: bool("DUST_PROXY_CLIENT_TOOLS"),
    // Default ON: create + replay + delete each turn, so stateless clients
    // (Claude Code, OpenAI SDK) don't accumulate Dust conversations.
    ephemeral: process.env.DUST_PROXY_EPHEMERAL === undefined ? true : bool("DUST_PROXY_EPHEMERAL"),
    titlePrefix: process.env.DUST_PROXY_TITLE_PREFIX ?? "PROXY: ",
    maxContinuations: int("DUST_MAX_CONTINUATIONS", 4),
    workosDomain: env("WORKOS_DOMAIN", "api.workos.com"),
    workosClientId: env("WORKOS_CLIENT_ID", "client_01JGCT55T7FVDG9XF74925R1KT"),
    workosClaimNamespace: env("WORKOS_CLAIM_NAMESPACE", "https://dust.tt/"),
    domains: {
      default: env("DEFAULT_DUST_API_DOMAIN", "https://dust.tt"),
      us: env("DUST_US_URL", "https://dust.tt"),
      eu: env("DUST_EU_URL", "https://eu.dust.tt"),
    },
    stateFile: env(
      "DUST_PROXY_STATE_FILE",
      join(homedir(), ".dust-cli", "dust-exporter-state.json"),
    ),
    ...overrides,
  };
}

export function apiDomainForRegion(region: string | null, cfg: Config): string {
  switch (region) {
    case "europe-west1":
      return cfg.domains.eu;
    case "us-central1":
      return cfg.domains.us;
    default:
      return cfg.domains.default;
  }
}
