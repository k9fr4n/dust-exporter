import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionRegistry } from "../src/dust/clientToolsSession";
import type { ParsedAnthropicFull } from "../src/protocols/anthropic";
import { ConversationStore } from "../src/state/store";

// registry.get() never touches Dust — a bare stub is enough.
const api = {} as any;

function parsed(overrides: Partial<ParsedAnthropicFull> = {}): ParsedAnthropicFull {
  return {
    model: "claude",
    system: "",
    messages: [],
    stream: false,
    sessionId: "sess-1",
    tools: [{ name: "Read", input_schema: {} }],
    toolResults: [],
    isResume: false,
    lastUserText: "hi",
    firstUserText: "first prompt",
    ...overrides,
  } as ParsedAnthropicFull;
}

describe("SessionRegistry rehydration", () => {
  it("continues the persisted Dust conversation for a known key instead of creating a new one", async () => {
    const path = join(tmpdir(), `ct-${randomUUID()}.json`);
    // Simulate a session whose conversationId was persisted before an idle sweep.
    const seed = new ConversationStore(path);
    await seed.load();
    // Key mirrors registry.get(): `ct:${sessionId}:${agentId}:${anchorOfFirstUser}`.
    const { createHash } = await import("node:crypto");
    const anchor = createHash("sha256").update("first prompt").digest("hex").slice(0, 16);
    await seed.set(`ct:sess-1:agent-1:${anchor}`, "conv-persisted");

    const registry = new SessionRegistry(new ConversationStore(path));
    const s = await registry.get(parsed(), "agent-1", api, "PROXY: ");
    expect(s.conversationId).toBe("conv-persisted");

    await fs.rm(path, { force: true });
  });

  it("returns a fresh (unbound) session when nothing is persisted", async () => {
    const path = join(tmpdir(), `ct-${randomUUID()}.json`);
    const registry = new SessionRegistry(new ConversationStore(path));
    const s = await registry.get(parsed(), "agent-1", api, "PROXY: ");
    expect(s.conversationId).toBeNull();
    await fs.rm(path, { force: true });
  });

  it("reuses the same in-memory session for repeated requests on one key", async () => {
    const registry = new SessionRegistry();
    const a = await registry.get(parsed(), "agent-1", api, "");
    const b = await registry.get(parsed(), "agent-1", api, "");
    expect(a).toBe(b);
  });
});
