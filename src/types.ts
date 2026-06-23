export type Role = "system" | "user" | "assistant" | "tool";

export interface NormalizedMessage {
  role: Role;
  content: string;
}

export interface GeneratedFile {
  fileId: string;
  title: string;
  contentType: string;
}

export type Delta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; name: string }
  | {
      type: "done";
      conversationId: string;
      toolsUsed: string[];
      generatedFiles: GeneratedFile[];
      /** Why the underlying Dust run ended. "max_steps" means the agent hit its
       *  `maxStepsPerRun` cap and was cut off (eligible for auto-continuation). */
      finishReason: "stop" | "max_steps";
      /** Steps consumed by the run (max step index + 1), 0 when unknown. */
      stepsUsed: number;
      /** The agent's `maxStepsPerRun` cap as reported by Dust, 0 when unknown. */
      maxSteps: number;
      /** The agent/model Dust actually resolved and ran, as reported on the
       *  terminal agent message. Lets callers see the real model behind the
       *  requested agent alias. Undefined when Dust sent no configuration. */
      agent?: {
        sId?: string;
        name?: string;
        providerId?: string;
        modelId?: string;
      };
    }
  | { type: "error"; message: string };
