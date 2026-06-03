type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.DUST_PROXY_LOG_LEVEL as Level) || "info"] ?? 20;

function fmt(a: unknown): string {
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}
function emit(level: Level, args: unknown[]) {
  if (order[level] < threshold) return;
  process.stderr.write(`${new Date().toISOString()} [${level}] ${args.map(fmt).join(" ")}\n`);
}
export const log = {
  debug: (...a: unknown[]) => emit("debug", a),
  info: (...a: unknown[]) => emit("info", a),
  warn: (...a: unknown[]) => emit("warn", a),
  error: (...a: unknown[]) => emit("error", a),
};
