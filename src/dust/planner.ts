import { HttpError } from "../errors";
import { fingerprint } from "../state/fingerprint";
import type { NormalizedMessage } from "../types";

export interface TurnPlan {
  mode: "create" | "continue";
  conversationId?: string;
  contentToSend: string;
  fingerprintKey: string;
  isReplay: boolean;
}

const roleLabel: Record<string, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/** Build a conversation title from a message: strip Claude Code's
 *  <system-reminder> blocks, collapse whitespace, truncate, and prefix. */
export function deriveTitle(text: string, prefix: string): string {
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) t = "conversation";
  const max = 60;
  if (t.length > max) t = `${t.slice(0, max).trimEnd()}…`;
  return `${prefix}${t}`;
}

export function withSystem(system: string | undefined, content: string): string {
  if (!system || !system.trim()) return content;
  return `<system>\n${system.trim()}\n</system>\n\n${content}`;
}

/** Flatten an entire history into a single message. Used as the fallback when
 *  no Dust conversation matches the client prefix (cold cache, edited history),
 *  so context is preserved by replaying everything into a fresh conversation. */
export function renderTranscript(messages: NormalizedMessage[], system?: string): string {
  const parts: string[] = [];
  if (system && system.trim()) parts.push(`<system>\n${system.trim()}\n</system>`);
  for (const m of messages) parts.push(`${roleLabel[m.role] ?? m.role}: ${m.content}`);
  return parts.join("\n\n");
}

/** Decide whether to continue an existing Dust conversation (sending only the
 *  last user turn) or create a new one. Pure: state access is injected via
 *  `lookup`. This is the heart of the stateless<->stateful reconciliation. */
export function planTurn(opts: {
  messages: NormalizedMessage[];
  system?: string;
  workspaceId: string;
  agentId: string;
  lookup: (key: string) => string | undefined;
}): TurnPlan {
  const { messages, system, workspaceId, agentId, lookup } = opts;
  const userContents = messages.filter((m) => m.role === "user").map((m) => m.content);
  if (userContents.length === 0) {
    throw new HttpError(400, "At least one user message is required.");
  }
  const fullKey = fingerprint(workspaceId, agentId, userContents);
  const lastUser = userContents[userContents.length - 1];
  const prior = userContents.slice(0, -1);

  if (prior.length === 0) {
    return {
      mode: "create",
      contentToSend: withSystem(system, lastUser),
      fingerprintKey: fullKey,
      isReplay: false,
    };
  }
  const cid = lookup(fingerprint(workspaceId, agentId, prior));
  if (cid) {
    return {
      mode: "continue",
      conversationId: cid,
      contentToSend: lastUser,
      fingerprintKey: fullKey,
      isReplay: false,
    };
  }
  return {
    mode: "create",
    contentToSend: renderTranscript(messages, system),
    fingerprintKey: fullKey,
    isReplay: true,
  };
}
