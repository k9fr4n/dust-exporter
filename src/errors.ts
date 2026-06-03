export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly type: string = "invalid_request_error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
