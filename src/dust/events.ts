import type { Delta, GeneratedFile } from "../types";

export interface NormalizeCtx {
  conversationId: string;
  onApprove: (ev: any) => Promise<void>;
}

interface FinishInfo {
  finishReason: "stop" | "max_steps";
  stepsUsed: number;
  maxSteps: number;
}

/** Inspect a terminal Dust agent message to decide whether the run finished
 *  naturally or was cut off by the agent's `maxStepsPerRun` cap. Dust numbers
 *  steps from 0, so steps-used = (highest step index seen across actions /
 *  rawContents) + 1. When that reaches the cap, the run was almost certainly
 *  truncated and can be resumed by posting a follow-up on the same conversation. */
function finishInfo(message: any): FinishInfo {
  const maxSteps = Number(message?.configuration?.maxStepsPerRun) || 0;
  const steps: number[] = [];
  for (const a of message?.actions ?? []) {
    if (typeof a?.step === "number") steps.push(a.step);
  }
  for (const r of message?.rawContents ?? []) {
    if (typeof r?.step === "number") steps.push(r.step);
  }
  const stepsUsed = steps.length ? Math.max(...steps) + 1 : 0;
  const finishReason: FinishInfo["finishReason"] =
    maxSteps > 0 && stepsUsed >= maxSteps ? "max_steps" : "stop";
  return { finishReason, stepsUsed, maxSteps };
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
  const done = (fin?: FinishInfo): Delta => ({
    type: "done",
    conversationId: ctx.conversationId,
    toolsUsed: [...tools],
    generatedFiles: files,
    finishReason: fin?.finishReason ?? "stop",
    stepsUsed: fin?.stepsUsed ?? 0,
    maxSteps: fin?.maxSteps ?? 0,
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
        yield done(finishInfo(ev.message));
        return;
      case "agent_generation_cancelled":
        // User/abort-initiated cancellation: never a step-cap, do not continue.
        yield done();
        return;
      default:
        break;
    }
  }
  yield done();
}
