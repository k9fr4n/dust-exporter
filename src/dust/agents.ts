import type { DustAPI } from "@dust-tt/client";

import { HttpError } from "../errors";

export interface AgentInfo { sId: string; name: string; description: string }

// Claude Code's model picker drops every id from a gateway's /v1/models that
// does not match this pattern, so an agent named after another provider would
// never be listed. Prefixing those with `anthropic/` keeps them visible;
// matchAgent() strips a `provider/` prefix, so the id still resolves.
const PICKER_KEEPS = /(claude|anthropic)/i;

/** Agent display name with whitespace collapsed to underscores, or the sId when
 *  the agent has no name. */
function baseId(a: AgentInfo): string {
  return (a.name ?? "").trim().replace(/\s+/g, "_") || a.sId;
}

/** Public model id exposed by GET /v1/models: the agent display name with
 *  whitespace collapsed to underscores ("Claude Sonnet 5" -> "Claude_Sonnet_5"),
 *  `anthropic/`-prefixed when it would otherwise be hidden from Claude Code's
 *  picker. matchAgent() resolves either form. */
export function modelId(a: AgentInfo): string {
  return qualify(baseId(a));
}

function qualify(id: string): string {
  return PICKER_KEEPS.test(id) ? id : `anthropic/${id}`;
}

/** Model ids for a list of agents, keyed by sId. Two agents can share a display
 *  name; those fall back to their sId so every id stays unique and resolvable. */
export function modelIds(agents: AgentInfo[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const a of agents) {
    const b = baseId(a);
    seen.set(b, (seen.get(b) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const a of agents) {
    const b = baseId(a);
    out.set(a.sId, qualify((seen.get(b) ?? 0) > 1 ? a.sId : b));
  }
  return out;
}

let cache: { at: number; agents: AgentInfo[] } | null = null;
const TTL_MS = 60_000;

async function fetchView(api: DustAPI, view: "list" | "all"): Promise<AgentInfo[]> {
  const r = await api.getAgentConfigurations({ view });
  if (r.isErr()) throw new HttpError(502, `Failed to list agents (view=${view}): ${r.error.message}`, "api_error");
  return r.value.map((a: any) => ({
    sId: a.sId,
    name: a.name ?? "",
    description: a.description ?? "",
  }));
}

export async function listAgents(api: DustAPI, force = false): Promise<AgentInfo[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.agents;
  // `list` = active agents accessible to the user (incl. own private); `all` =
  // every non-private agent. Neither alone is a superset, so we merge both and
  // dedupe by sId so an agent is resolvable by name whichever scope it lives in.
  const settled = await Promise.allSettled([fetchView(api, "list"), fetchView(api, "all")]);
  const byId = new Map<string, AgentInfo>();
  let ok = false;
  let lastErr: unknown = null;
  for (const s of settled) {
    if (s.status === "fulfilled") {
      ok = true;
      for (const a of s.value) if (!byId.has(a.sId)) byId.set(a.sId, a);
    } else {
      lastErr = s.reason;
    }
  }
  if (!ok) throw lastErr instanceof HttpError ? lastErr : new HttpError(502, "Failed to list agents", "api_error");
  const agents = [...byId.values()];
  cache = { at: Date.now(), agents };
  return agents;
}

/** Resolve a requested model name to a Dust agent sId. Pure + exported for tests.
 *  Match order: exact sId, case-insensitive sId/name, provider-prefix stripped
 *  ("dust/foo" -> "foo"), then the configured default agent. */
/** Normalize to a slug: lowercased, accents stripped, non-alphanumerics removed.
 *  Lets "My Helper", "my-helper" and "myhelper" all collapse to the same key,
 *  so a Dust display name resolves even when the client sends a slug variant. */
function norm(s: string): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function matchAgent(
  agents: AgentInfo[],
  model: string,
  defaultAgent: string | null,
): string | null {
  const want = model.trim();
  const lc = want.toLowerCase();
  const sid = (a: AgentInfo) => (a.sId ?? "").toLowerCase();
  const nm = (a: AgentInfo) => (a.name ?? "").toLowerCase();

  const exact = agents.find((a) => a.sId === want);
  if (exact) return exact.sId;
  const ci = agents.find((a) => sid(a) === lc || nm(a) === lc);
  if (ci) return ci.sId;
  const stripped = want.includes("/") ? want.split("/").pop()!.toLowerCase() : lc;
  const byStripped = agents.find((a) => sid(a) === stripped || nm(a) === stripped);
  if (byStripped) return byStripped.sId;
  // Tolerant pass: slug-normalized comparison on both sId and name.
  const w = norm(stripped);
  if (w) {
    const byNorm = agents.find((a) => norm(a.sId) === w || norm(a.name) === w);
    if (byNorm) return byNorm.sId;
  }
  if (defaultAgent) {
    const d = defaultAgent.toLowerCase();
    const dn = norm(defaultAgent);
    const def = agents.find(
      (a) => sid(a) === d || nm(a) === d || norm(a.sId) === dn || norm(a.name) === dn,
    );
    if (def) return def.sId;
  }
  return null;
}
