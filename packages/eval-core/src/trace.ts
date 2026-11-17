import type { AttributionCause, EvalTrace, EvalTraceEvent } from "./types.ts";

export interface RawTraceEvent {
  seq: number;
  type: string;
  runId?: string | null;
  payload?: unknown;
  createdAt?: string;
}

export interface TraceContext {
  taskStatus?: string;
  timedOut?: boolean;
  error?: string | null;
  truncated?: boolean;
  fetchedAt?: string;
}

export function buildEvalTrace(taskId: string, events: RawTraceEvent[], context: TraceContext = {}): EvalTrace {
  const unique = new Map<number, RawTraceEvent>();
  for (const event of events) {
    if (!unique.has(event.seq)) unique.set(event.seq, event);
  }
  const ordered = [...unique.values()].sort((left, right) => left.seq - right.seq);
  const normalized = ordered.map((event, index): EvalTraceEvent => ({
    seq: event.seq,
    type: event.type,
    runId: event.runId ?? null,
    step: index + 1,
    phase: phaseOf(event.type),
    payload: asRecord(event.payload),
    createdAt: event.createdAt ?? ""
  }));
  const errors = normalized
    .map((event) => ({ event, message: errorMessage(event) }))
    .filter((item): item is { event: EvalTraceEvent; message: string } => item.message !== null)
    .map((item) => ({ seq: item.event.seq, message: item.message }));
  return {
    taskId,
    fetchedAt: context.fetchedAt ?? new Date().toISOString(),
    events: normalized,
    truncated: context.truncated ?? false,
    steps: normalized.length,
    toolCalls: normalized.filter((event) => event.type.includes("tool")).length,
    approvals: normalized.filter((event) => event.type.startsWith("approval.")).length,
    effects: normalized.filter((event) => event.type.startsWith("effect.")).length,
    artifacts: normalized.filter((event) => event.type.startsWith("artifact.")).length,
    errors,
    primaryCause: attributePrimaryCause(normalized, context)
  };
}

export function attributePrimaryCause(events: EvalTraceEvent[], context: TraceContext = {}): AttributionCause {
  if (events.length === 0) return context.taskStatus === "completed" ? "trace_unavailable" : "unknown";
  const text = events.map((event) => `${event.type} ${JSON.stringify(event.payload)}`).join("\n").toLowerCase();
  if (/(policy|denied|forbidden|权限|禁止)/.test(text) && /(error|denied|rejected)/.test(text)) return "policy_denied";
  if (events.some((event) => /approval\.(rejected|expired)/.test(event.type))
    || events.some((event) => event.type.startsWith("approval.") && ["rejected", "expired"].includes(String(event.payload.status)))) {
    return "approval_blocked";
  }
  if (context.timedOut || /timeout|timed out|超时/.test(text)) return "task_timeout";
  if (events.some((event) => /effect\.failed/.test(event.type) || event.payload.status === "failed")) return "tool_error";
  if (context.error && /产物|artifact|expected output/i.test(context.error)) return "artifact_missing";
  if (context.error && /model|executor|模型|执行器/i.test(context.error)) return "model_error";
  if (context.error) return "unknown";
  return "none";
}

export function phaseOf(type: string): EvalTraceEvent["phase"] {
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("effect.")) return "effect";
  if (type.startsWith("artifact.")) return "artifact";
  if (type.startsWith("outbox.")) return "outbox";
  if (/error|failed/.test(type)) return "error";
  if (type.startsWith("run.") || type.startsWith("task.") || type.startsWith("eval.")) return "run";
  return "other";
}

function errorMessage(event: EvalTraceEvent): string | null {
  const payload = event.payload;
  const message = typeof payload.error === "string"
    ? payload.error
    : typeof payload.message === "string" && /error|failed/.test(event.type)
      ? payload.message
      : null;
  if (message) return message;
  return /error|failed/.test(event.type) ? event.type : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}
