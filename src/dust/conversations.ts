import type { DustAPI } from "@dust-tt/client";

import { errorMessage } from "../errors";
import { log } from "../logger";

/** Delete a conversation via the front API route
 *  (DELETE /api/w/{wId}/assistant/conversations/{cId} - note: no /v1/ prefix,
 *  the public /api/v1 route does not expose deletion). Best-effort. */
export async function deleteConversation(api: DustAPI, conversationId: string): Promise<void> {
  try {
    const apiKey = await api.getApiKey();
    if (!apiKey) return;
    const url = `${api.apiUrl()}/api/w/${api.workspaceId()}/assistant/conversations/${conversationId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) log.warn("deleteConversation non-2xx", res.status, conversationId);
  } catch (e) {
    log.warn("deleteConversation failed", errorMessage(e));
  }
}
