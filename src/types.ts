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
  | { type: "done"; conversationId: string; toolsUsed: string[]; generatedFiles: GeneratedFile[] }
  | { type: "error"; message: string };
