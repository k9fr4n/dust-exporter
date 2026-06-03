import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { log } from "../logger";

interface Entry { conversationId: string; updatedAt: number }
interface FileShape { schema: "dust-exporter.state.v1"; entries: Record<string, Entry> }

/** Persistent fingerprint -> conversationId map. Write-through JSON with an
 *  in-memory cache. Used to map a stateless client history onto a stateful
 *  Dust conversation. Safe to lose: a miss simply creates a fresh conversation. */
export class ConversationStore {
  private entries: Record<string, Entry> = {};
  private loaded = false;
  constructor(private readonly path: string, private readonly maxEntries = 5000) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as FileShape;
      if (parsed?.schema === "dust-exporter.state.v1") this.entries = parsed.entries || {};
    } catch (err: any) {
      if (err?.code !== "ENOENT") log.warn("state load failed", err?.message);
    }
    this.loaded = true;
  }

  get(key: string): string | undefined {
    return this.entries[key]?.conversationId;
  }

  async set(key: string, conversationId: string): Promise<void> {
    this.entries[key] = { conversationId, updatedAt: Date.now() };
    await this.persist();
  }

  private async persist(): Promise<void> {
    const keys = Object.keys(this.entries);
    if (keys.length > this.maxEntries) {
      keys
        .sort((a, b) => this.entries[a].updatedAt - this.entries[b].updatedAt)
        .slice(0, keys.length - this.maxEntries)
        .forEach((k) => delete this.entries[k]);
    }
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      const payload: FileShape = { schema: "dust-exporter.state.v1", entries: this.entries };
      await fs.writeFile(tmp, JSON.stringify(payload), "utf-8");
      await fs.rename(tmp, this.path);
    } catch (err: any) {
      log.warn("state persist failed", err?.message);
    }
  }
}
