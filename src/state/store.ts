import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { ActiveGeneration } from "../dust/generation";

interface Entry { conversationId: string; updatedAt: number; active?: ActiveGeneration }
interface FileShape { schema: "dust-exporter.state.v1"; entries: Record<string, Entry> }

/** One writer per proxy process. Legacy entries without active runs still load. */
export class ConversationStore {
  private entries: Record<string, Entry> = {};
  private loading: Promise<void> | null = null;
  private busy = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly maxEntries = 5000) {}

  load(): Promise<void> {
    if (!this.loading) this.loading = this.read().catch((e) => { this.loading = null; throw e; });
    return this.loading;
  }

  private async read(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, "utf-8")) as FileShape;
      if (parsed?.schema !== "dust-exporter.state.v1" || !parsed.entries) throw new Error("Invalid conversation state file");
      this.entries = parsed.entries;
    } catch (err: any) {
      // A broken state file must not silently fork every conversation.
      if (err?.code !== "ENOENT") throw err;
    }
  }

  acquire(key: string): () => void {
    if (this.busy.has(key)) throw new Error("A request is already using this conversation");
    this.busy.add(key);
    return () => { this.busy.delete(key); };
  }

  get(key: string): string | undefined { return this.entries[key]?.conversationId; }
  active(key: string): ActiveGeneration | undefined { return this.entries[key]?.active; }
  recoveries(): { key: string; conversationId: string; active: ActiveGeneration }[] {
    return Object.entries(this.entries).flatMap(([key, entry]) => entry.active
      ? [{ key, conversationId: entry.conversationId, active: structuredClone(entry.active) }] : []);
  }

  set(key: string, conversationId: string, active?: ActiveGeneration): Promise<void> {
    const write = this.writes.then(async () => {
      await this.load();
      this.entries[key] = { conversationId, updatedAt: Date.now(), ...(active ? { active: structuredClone(active) } : {}) };
      await this.persist();
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async flush(): Promise<void> { await this.writes; }

  private async persist(): Promise<void> {
    const keys = Object.keys(this.entries).filter((key) => !this.entries[key].active);
    const excess = Object.keys(this.entries).length - this.maxEntries;
    if (excess > 0) keys.sort((a, b) => this.entries[a].updatedAt - this.entries[b].updatedAt)
      .slice(0, excess).forEach((key) => delete this.entries[key]);
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const payload: FileShape = { schema: "dust-exporter.state.v1", entries: this.entries };
      await fs.writeFile(tmp, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tmp, this.path);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
}
