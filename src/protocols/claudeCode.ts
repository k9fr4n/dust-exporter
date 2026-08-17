// Claude Code's `/model` picker does not simply show what GET /v1/models
// returns. Its gateway discovery path (enabled by
// CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) filters the response down to ids
// matching /(claude|anthropic)/i, so Dust agents named after other providers
// never appear. Setting `modelDiscoveryEnabled: false` and listing the agents
// in `inferenceModels` bypasses that filter entirely: the picker then shows the
// list verbatim, `labelOverride` supplying the human-readable label.
import { type AgentInfo, modelIds } from "../dust/agents";

export interface ClaudeSettingsOptions {
  /** Base URL Claude Code should talk to, i.e. where this proxy listens. */
  baseUrl: string;
  /** Proxy API key, when `serve --api-key` requires one. */
  apiKey?: string | null;
  /** How the key travels: `Authorization: Bearer` or the `x-api-key` header. */
  authScheme?: "bearer" | "x-api-key";
}

export interface InferenceModel { name: string; labelOverride?: string }

/** Settings.json fragment pointing Claude Code at this proxy with a fixed model
 *  list built from the live Dust agents. Every agent is listed, unfiltered. */
export function claudeCodeSettings(agents: AgentInfo[], opts: ClaudeSettingsOptions) {
  const ids = modelIds(agents);
  const inferenceModels: InferenceModel[] = agents
    .map((a) => {
      const name = ids.get(a.sId) ?? a.sId;
      const label = a.name || a.sId;
      return label === name ? { name } : { name, labelOverride: label };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: opts.baseUrl.replace(/\/+$/, ""),
    inferenceGatewayAuthScheme: opts.authScheme ?? "bearer",
    ...(opts.apiKey ? { inferenceGatewayApiKey: opts.apiKey } : {}),
    // Discovery off: the list below is used as-is, no id filtering. Aliases
    // like `sonnet` no longer resolve, so `serve --agent <id>` should stay set
    // to catch the internal model names Claude Code sends for its own tasks.
    modelDiscoveryEnabled: false,
    inferenceModels,
  };
}
