import type { ExperimentsResponse, NativeProviderView, RunDetailResponse } from "@hearth/eval-core/browser";

/** Same-origin JSON client for the native console (`apps/eval-web/native.html`). */

export class NativeApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NativeApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Only announce JSON when there is a body: Fastify rejects an empty body
  // that still carries `content-type: application/json` (e.g. DELETE).
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
    throw new NativeApiError(
      response.status,
      typeof record.error === "string" ? record.error : "REQUEST_FAILED",
      typeof record.message === "string" ? record.message : `请求失败（HTTP ${response.status}）`
    );
  }
  return payload as T;
}

export const nativeApi = {
  providers: () => request<{ providers: NativeProviderView[] }>("/api/providers"),
  saveProvider: (body: Record<string, unknown>) => request<NativeProviderView>("/api/providers", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  deleteProvider: (id: string) => request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testProvider: (body: Record<string, unknown>) => request<NativeProviderTestResult>("/api/providers/test", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  cases: () => request<NativeCasesResponse>("/api/native/cases"),
  caseDetail: (caseKey: string) => request<{ case: unknown; manifest: unknown }>(`/api/native/cases/${encodeURIComponent(caseKey)}`),
  run: (body: { caseId: string; providerId: string }) => request<RunDetailResponse>("/api/native/run", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  experiments: () => request<ExperimentsResponse>("/api/native/runs"),
  experiment: (id: string) => request<NativeExperimentDetail>(`/api/native/experiments/${encodeURIComponent(id)}`),
  runDetail: (id: string) => request<RunDetailResponse>(`/api/native/runs/${encodeURIComponent(id)}`),
  review: (id: string, decision: "pass" | "fail" | "unknown") => request<{ review: unknown; run: unknown }>(
    `/api/native/runs/${encodeURIComponent(id)}/review`,
    { method: "POST", body: JSON.stringify({ decision, reviewer: "local" }) }
  )
};

export type { NativeProviderView };

export interface NativeProviderTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  message: string;
  baseUrl: string;
}

export interface NativeCaseSummary {
  caseKey: string;
  title: string;
  family: string;
  difficulty: string;
  runModes: string[];
  hasJudge: boolean;
  inputKinds: string[];
}

export interface NativeCasesResponse {
  cases: NativeCaseSummary[];
  counts: Record<string, number>;
  generatedAt: string;
}

export interface NativeExperimentDetail {
  experiment: { id: string; name: string; status: string; createdAt: string };
  runs: Array<{ id: string; caseKey: string; status: string; score: number | null }>;
  events: Array<{ seq: number; type: string; createdAt: string }>;
}
