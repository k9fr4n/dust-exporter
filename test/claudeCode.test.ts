import { describe, expect, it } from "vitest";

import type { AgentInfo } from "../src/dust/agents";
import { claudeCodeSettings } from "../src/protocols/claudeCode";

const agents: AgentInfo[] = [
  { sId: "s1", name: "Claude Sonnet 5", description: "" },
  { sId: "s2", name: "GPT 5.6 Sol", description: "" },
  { sId: "s3", name: "", description: "" },
];

describe("claudeCodeSettings", () => {
  const s: any = claudeCodeSettings(agents, { baseUrl: "http://127.0.0.1:8787/", apiKey: "sk-local" });

  it("lists every agent, including non-Claude ones", () => {
    expect(s.inferenceModels.map((m: any) => m.name)).toEqual(["Claude_Sonnet_5", "GPT_5.6_Sol", "s3"]);
  });
  it("labels each entry with the Dust display name", () => {
    expect(s.inferenceModels[1]).toEqual({ name: "GPT_5.6_Sol", labelOverride: "GPT 5.6 Sol" });
  });
  it("omits labelOverride when it would repeat the id", () => {
    expect(s.inferenceModels[2]).toEqual({ name: "s3" });
  });
  it("disables discovery so the list is not filtered", () => {
    expect(s.modelDiscoveryEnabled).toBe(false);
  });
  it("points at the proxy with a trimmed base URL", () => {
    expect(s.inferenceProvider).toBe("gateway");
    expect(s.inferenceGatewayBaseUrl).toBe("http://127.0.0.1:8787");
    expect(s.inferenceGatewayAuthScheme).toBe("bearer");
    expect(s.inferenceGatewayApiKey).toBe("sk-local");
  });
  it("omits the key when the proxy needs none", () => {
    const bare: any = claudeCodeSettings(agents, { baseUrl: "http://h:1", apiKey: null });
    expect("inferenceGatewayApiKey" in bare).toBe(false);
  });
  it("honours the x-api-key scheme", () => {
    const x: any = claudeCodeSettings(agents, { baseUrl: "http://h:1", authScheme: "x-api-key" });
    expect(x.inferenceGatewayAuthScheme).toBe("x-api-key");
  });
});
