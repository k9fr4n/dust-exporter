import { describe, expect, it } from "vitest";

import { type AgentInfo, matchAgent } from "../src/dust/agents";

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
});
