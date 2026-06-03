import { createHash } from "node:crypto";

/** Stable fingerprint of a conversation prefix. We hash the ORDERED list of
 *  user-turn contents (scoped by workspace + agent) because user turns are
 *  verbatim from the client and append-only, unlike assistant turns which the
 *  client may reformat. Two requests that share the same user-turn prefix are
 *  the same logical Dust conversation. */
export function fingerprint(
  workspaceId: string,
  agentId: string,
  userContents: string[],
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([workspaceId, agentId, userContents]));
  return h.digest("hex");
}
