import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConversationStore } from "../src/state/store";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "dust-persistence-")); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });

it("serializes concurrent loads and writes without losing mappings or active runs", async () => {
  const path = join(dir, "state.json");
  const store = new ConversationStore(path);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.set(`key-${i}`, `conv-${i}`, { userMessageId: `u-${i}`, messageIds: [`a-${i}`] })));
  await store.flush();
  const restored = new ConversationStore(path);
  await Promise.all([restored.load(), restored.load()]);
  for (let i = 0; i < 30; i++) {
    expect(restored.get(`key-${i}`)).toBe(`conv-${i}`);
    expect(restored.active(`key-${i}`)?.messageIds).toEqual([`a-${i}`]);
  }
  expect(await fs.readdir(dir)).toEqual(["state.json"]);
});

it("does not silently recreate conversations when the state file is corrupt", async () => {
  const path = join(dir, "state.json");
  await fs.writeFile(path, "broken json");
  const store = new ConversationStore(path);
  await expect(store.load()).rejects.toThrow();
  await expect(store.set("key", "conversation")).rejects.toThrow();
  expect(await fs.readFile(path, "utf-8")).toBe("broken json");
});

it("never evicts a recoverable active generation to satisfy the cache size limit", async () => {
  const path = join(dir, "state.json");
  const store = new ConversationStore(path, 1);
  await store.set("active", "a", { userMessageId: "u", messageIds: ["m"] });
  await store.set("idle", "b");
  expect(store.get("active")).toBe("a");
});

it("guards conditional credential changes and serializes file updates", async () => {
  vi.resetModules();
  vi.stubEnv("DUST_CREDENTIAL_STORE", "file");
  vi.stubEnv("DUST_CREDENTIAL_FILE", join(dir, "credentials.json"));
  const { default: storage } = await import("../src/auth/tokenStorage");
  await storage.saveTokens("old access", "old refresh");
  await Promise.all([storage.saveWorkspaceId("workspace"), storage.saveRegion("region"), storage.saveTokens("new access", "new refresh")]);
  expect(await storage.getAccessToken()).toBe("new access");
  expect(await storage.getWorkspaceId()).toBe("workspace");
  expect(await storage.getRegion()).toBe("region");
  expect(await storage.clearTokensIfRefreshToken("old refresh")).toBe(false);
  expect(await storage.saveTokensIfRefreshToken("old refresh", "stale", "stale")).toBe(false);
  expect(await storage.getAccessToken()).toBe("new access");
  expect(await storage.clearTokensIfRefreshToken("new refresh")).toBe(true);
  expect(await storage.getAccessToken()).toBeNull();
  expect(await fs.readdir(dir)).toEqual(["credentials.json"]);
});
