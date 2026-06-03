import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConversationStore } from "../src/state/store";

describe("ConversationStore", () => {
  it("persists and reloads across instances", async () => {
    const path = join(tmpdir(), `dust-exporter-${randomUUID()}.json`);
    const s1 = new ConversationStore(path);
    await s1.load();
    expect(s1.get("k")).toBeUndefined();
    await s1.set("k", "conv-1");
    const s2 = new ConversationStore(path);
    await s2.load();
    expect(s2.get("k")).toBe("conv-1");
    await fs.rm(path, { force: true });
  });
});
