import { describe, expect, it } from "vitest";

import { type AgentInfo, matchAgent, modelId, modelIds } from "../src/dust/agents";

const agents: AgentInfo[] = [
  { sId: "claude-4.5-sonnet", name: "claude-sonnet", description: "" },
  { sId: "gpt-5", name: "gpt5.5", description: "" },
  { sId: "abc123", name: "My Helper", description: "" },
  { sId: "xyz789", name: "Café Définir", description: "" },
];

describe("matchAgent", () => {
  it("matches exact sId", () => expect(matchAgent(agents, "gpt-5", null)).toBe("gpt-5"));
  it("matches sId case-insensitively", () => expect(matchAgent(agents, "GPT-5", null)).toBe("gpt-5"));
  it("matches by name", () => expect(matchAgent(agents, "My Helper", null)).toBe("abc123"));
  it("matches by name case-insensitively", () => expect(matchAgent(agents, "my helper", null)).toBe("abc123"));
  it("strips a provider prefix", () => expect(matchAgent(agents, "dust/gpt-5", null)).toBe("gpt-5"));
  it("matches a slug variant of the display name", () =>
    expect(matchAgent(agents, "my-helper", null)).toBe("abc123"));
  it("matches ignoring accents and spaces", () =>
    expect(matchAgent(agents, "cafe definir", null)).toBe("xyz789"));
  it("falls back to the default agent", () => expect(matchAgent(agents, "nope", "gpt-5")).toBe("gpt-5"));
  it("returns null when nothing matches", () => expect(matchAgent(agents, "nope", null)).toBeNull());
  it("resolves the id advertised by GET /v1/models", () => {
    const listed = { sId: "s1", name: "Claude Sonnet 5", description: "" };
    expect(matchAgent([...agents, listed], modelId(listed), null)).toBe("s1");
  });
});

describe("modelId", () => {
  it("underscores the display name of a Claude agent", () =>
    expect(modelId({ sId: "s1", name: "Claude Sonnet 5", description: "" })).toBe("Claude_Sonnet_5"));
  it("collapses runs of whitespace", () =>
    expect(modelId({ sId: "s1", name: "  Claude  B ", description: "" })).toBe("Claude_B"));
  it("qualifies ids Claude Code's picker would drop", () =>
    expect(modelId({ sId: "s1", name: "GPT 5.6 Sol", description: "" })).toBe("anthropic/GPT_5.6_Sol"));
  it("qualifies the sId fallback when the agent has no name", () =>
    expect(modelId({ sId: "s1", name: "", description: "" })).toBe("anthropic/s1"));
  it("leaves an already-matching id unprefixed, case-insensitively", () =>
    expect(modelId({ sId: "s1", name: "my claude helper", description: "" })).toBe("my_claude_helper"));
  it("keeps ambiguous names on their sId", () => {
    const dup: AgentInfo[] = [
      { sId: "s1", name: "Dup", description: "" },
      { sId: "s2", name: "Dup", description: "" },
      { sId: "s3", name: "Claude_Uniq", description: "" },
    ];
    const ids = modelIds(dup);
    expect(ids.get("s1")).toBe("anthropic/s1");
    expect(ids.get("s2")).toBe("anthropic/s2");
    expect(ids.get("s3")).toBe("Claude_Uniq");
  });
  it("round-trips every id back to its agent", () => {
    const all: AgentInfo[] = [
      { sId: "s1", name: "Claude Sonnet 5", description: "" },
      { sId: "s2", name: "GPT 5.6 Sol", description: "" },
      { sId: "s3", name: "GLM-5.2", description: "" },
      { sId: "s4", name: "Café Définir", description: "" },
    ];
    const ids = modelIds(all);
    for (const a of all) expect(matchAgent(all, ids.get(a.sId)!, null)).toBe(a.sId);
  });
});
