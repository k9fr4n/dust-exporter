import type { DustAPI } from "@dust-tt/client";

import { HttpError } from "../errors";

export interface AgentInfo { sId: string; name: string; description: string }

let cache: { at: number; agents: AgentInfo[] } | null = null;
const TTL_MS = 60_000;

export async function listAgents(api: DustAPI, force = false): Promise<AgentInfo[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.agents;
  const r = await api.getAgentConfigurations({ view: "list" });
  if (r.isErr()) throw new HttpError(502, `Failed to list agents: ${r.error.message}`, "api_error");
  const agents = r.value.map((a: any) => ({
    sId: a.sId,
    name: a.name,
    description: a.description ?? "",
  }));
  cache = { at: Date.now(), agents };
  return agents;
}

/** Resolve a requested model name to a Dust agent sId. Pure + exported for tests.
 *  Match order: exact sId, case-insensitive sId/name, provider-prefix stripped
 *  ("dust/foo" -> "foo"), then the configured default agent. */
export function matchAgent(
  agents: AgentInfo[],
  model: string,
  defaultAgent: string | null,
): string | null {
  const want = model.trim();
  const lc = want.toLowerCase();
  const exact = agents.find((a) => a.sId === want);
  if (exact) return exact.sId;
  const ci = agents.find((a) => a.sId.toLowerCase() === lc || a.name.toLowerCase() === lc);
  if (ci) return ci.sId;
  const stripped = want.includes("/") ? want.split("/").pop()!.toLowerCase() : lc;
  const byStripped = agents.find(
    (a) => a.sId.toLowerCase() === stripped || a.name.toLowerCase() === stripped,
  );
  if (byStripped) return byStripped.sId;
  if (defaultAgent) {
    const d = defaultAgent.toLowerCase();
    const def = agents.find((a) => a.sId.toLowerCase() === d || a.name.toLowerCase() === d);
    if (def) return def.sId;
  }
  return null;
}
