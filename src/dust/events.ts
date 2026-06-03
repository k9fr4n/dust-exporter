import type { Delta, GeneratedFile } from "../types";

export interface NormalizeCtx {
  conversationId: string;
  onApprove: (ev: any) => Promise<void>;
}

/** Translate the raw Dust agent event stream into protocol-agnostic Deltas.
 *  Tool executions are auto-approved through `onApprove`. Pure transformer:
 *  feed it any async iterable of events to unit-test it without the network. */
export async function* normalizeEvents(
  eventStream: AsyncIterable<any>,
  ctx: NormalizeCtx,
): AsyncGenerator<Delta> {
  const tools = new Set<string>();
  const files: GeneratedFile[] = [];
  const done = (): Delta => ({
    type: "done",
    conversationId: ctx.conversationId,
    toolsUsed: [...tools],
    generatedFiles: files,
  });

  for await (const ev of eventStream) {
    switch (ev?.type) {
      case "generation_tokens":
        if (ev.classification === "tokens" && ev.text) {
          yield { type: "text", text: ev.text };
        } else if (ev.classification === "chain_of_thought" && ev.text) {
          yield { type: "reasoning", text: ev.text };
        }
        break;
      case "tool_params": {
        const name = ev.action?.functionCallName;
        if (typeof name === "string" && name && !tools.has(name)) {
          tools.add(name);
          yield { type: "tool", name };
        }
        break;
      }
      case "tool_approve_execution":
        await ctx.onApprove(ev);
        break;
      case "agent_action_success": {
        const generated = ev.action?.generatedFiles;
        if (Array.isArray(generated)) {
          for (const f of generated) {
            if (f && !f.hidden) {
              files.push({ fileId: f.fileId, title: f.title, contentType: f.contentType });
            }
          }
        }
        break;
      }
      case "agent_error":
      case "user_message_error":
        yield { type: "error", message: ev.error?.message || "Agent error" };
        return;
      case "agent_message_success":
      case "agent_message_gracefully_stopped":
      case "agent_generation_cancelled":
        yield done();
        return;
      default:
        break;
    }
  }
  yield done();
}
