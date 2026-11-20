import type {
  BenchmarkImportInput,
  BenchmarkImportResult,
  BenchmarkJobCandidate,
  BenchmarkRun,
  BenchmarkTaskSummary,
  BenchmarkTrial,
  BenchmarkCompareResult,
  CaseCatalogResponse,
  CodexScoreHistory,
  CaseDetailResponse,
  CompareResponse,
  CreateExperimentRequest,
  DashboardResponse,
  EvalEventRecord,
  EvalEventsResponse,
  EvalSystemResponse,
  ExperimentDetailResponse,
  ExperimentRecord,
  ExperimentsResponse,
  HumanReviewRecord,
  ImportedEvaluation,
  ImportedEvaluationInput,
  ImportedBatchInput,
  ReviewQueueItem,
  RegressionReport,
  ReviewsResponse,
  RunArtifactView,
  RunDetailResponse,
  ScenarioBatchDetail,
  ScenarioBatchSummary,
  ScenarioSelfCheck,
  SubmitReviewRequest
} from "@hearth/eval-core";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) as unknown : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const record = asRecord(payload);
    throw new ApiError(
      response.status,
      typeof record?.error === "string" ? record.error : "REQUEST_FAILED",
      typeof record?.message === "string" ? record.message : `请求失败（HTTP ${response.status}）`,
      payload
    );
  }
  return payload as T;
}

export interface CaseFilters {
  family?: string;
  difficulty?: string;
  runMode?: string;
  search?: string;
}

export interface SubmitReviewResult {
  review: HumanReviewRecord;
  run: RunDetailResponse["run"] | null;
  experiment: ExperimentRecord | null;
}

export interface BenchmarkListResponse {
  runs: BenchmarkRun[];
}

export interface BenchmarkJobsResponse {
  root: string;
  jobs: BenchmarkJobCandidate[];
}

export interface BenchmarkDetailResponse {
  run: BenchmarkRun;
  tasks: BenchmarkTaskSummary[];
}

export interface BenchmarkTrialsResponse {
  trials: BenchmarkTrial[];
  total: number;
  limit: number;
  offset: number;
}

export interface BenchmarkTrialResponse {
  trial: BenchmarkTrial;
}

export interface BenchmarkCompareResponse {
  baselineRun: BenchmarkRun;
  candidateRun: BenchmarkRun;
  comparison: BenchmarkCompareResult;
}

export const api = {
  csvLabels: (id:string, artifact:{id:string;name:string}) => request<{title:string;headers:string[];idLabel:string;amountLabel:string;idColumn:string;amountColumn:string;warning?:string}>(`/api/acceptance/hearth/tasks/${encodeURIComponent(id)}/csv-labels`,{method:"POST",body:JSON.stringify({name:artifact.name,artifactId:artifact.id})}),
  cleanOrderCsv: (id:string, input:{name:string;artifactId:string;idColumn:string;amountColumn:string;repair:boolean;review?:{memoryKey:string;revision:number;requirements:string}}) => request<{repaired:boolean;review:string|null;retained:number;removed:Array<{record:number;id:string;reason:string}>;csv:string;sha256:string;directory:string}>(`/api/acceptance/hearth/tasks/${encodeURIComponent(id)}/orders`, { method:"POST",body:JSON.stringify(input) }),
  submitAccuracy: (entries:{id:string;correct:boolean}[]) => request<{correct:number;total:number}>("/api/acceptance/metrics/accuracy",{method:"POST",body:JSON.stringify(entries)}),
  verdictAccuracy: () => request<{correct:number;reviewed:number;total:number}>("/api/acceptance/metrics/accuracy"),
  setReference: (id:string,verdict:"passed"|"failed") => request<import("@hearth/eval-core").AcceptanceJob>(`/api/acceptance/${encodeURIComponent(id)}/reference`,{method:"PUT",body:JSON.stringify({verdict})}),
  hearthTasks: () => request<Array<{id:string; title:string; status:string}>>("/api/acceptance/hearth/tasks"),
  hearthOutputs: (id:string) => request<{goal:string; artifacts:Array<{id:string;name:string}>}>(`/api/acceptance/hearth/tasks/${encodeURIComponent(id)}`),
  checkHearthOutput: (id:string,input:{name:string;artifactId:string;required:string;memoryKey:string}) => request<{passed:boolean;missing:string[];sha256:string;semantic:import("@hearth/eval-core").AcceptanceSemanticReview|null;snapshot:import("@hearth/eval-core").ContextSnapshot|null}>(`/api/acceptance/hearth/tasks/${encodeURIComponent(id)}/check`, {method:"POST",body:JSON.stringify(input)}),
  acceptanceDefaults: () => request<import("@hearth/eval-core").AcceptanceDefaults>("/api/acceptance/defaults"),
  acceptanceMemory: (key: string) => request<import("@hearth/eval-core").AcceptanceMemoryView>(`/api/acceptance/memory/${encodeURIComponent(key)}`),
  saveAcceptanceMemory: (key: string, content: string, expectedRevision: number) => request<import("@hearth/eval-core").SharedMemory>(`/api/acceptance/memory/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ content, expectedRevision }) }),
  acceptances: () => request<import("@hearth/eval-core").AcceptanceJob[]>("/api/acceptance"),
  acceptance: (id: string) => request<import("@hearth/eval-core").AcceptanceJob>(`/api/acceptance/${encodeURIComponent(id)}`),
  startAcceptance: (input: import("@hearth/eval-core").AcceptanceInput) => request<import("@hearth/eval-core").AcceptanceJob>("/api/acceptance", { method: "POST", body: JSON.stringify(input) }),
  controlAcceptance: (id: string, action: "resume" | "stop") => request<import("@hearth/eval-core").AcceptanceJob>(`/api/acceptance/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" }),
  diagnoses: () => request<Array<Omit<import("@hearth/eval-core").DiagnosisJob, "evidence">>>("/api/diagnoses"),
  diagnosis: (id: string) => request<import("@hearth/eval-core").DiagnosisJob>(`/api/diagnoses/${encodeURIComponent(id)}`),
  startDiagnosis: (experimentId: string, rerunBudget: number) => request<import("@hearth/eval-core").DiagnosisJob>("/api/diagnoses", { method: "POST", body: JSON.stringify({ experimentId, rerunBudget }) }),
  controlDiagnosis: (id: string, action: "approve" | "resume" | "stop", approved?: boolean) => request<import("@hearth/eval-core").DiagnosisJob>(`/api/diagnoses/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(action === "approve" ? { approved } : {}) }),
  calibration: () => request<import("@hearth/eval-core").CalibrationReport>("/api/evaluation/calibration"),
  codexSetup: () => request<{ hook: string; rules: string }>("/api/codex/setup"),
  generateCodexRules: (description: string) => request<{ requiredText: string[]; unsupported: string[] }>(
    "/api/codex/generate-rules", { method: "POST", body: JSON.stringify({ description }) }
  ),
  codexScores: (before: number | null) => request<CodexScoreHistory>(
    before === null ? "/api/codex/scores" : `/api/codex/scores?before=${before}`
  ),
  importedEvaluations: () => request<Array<Pick<ImportedEvaluation, "id" | "title" | "createdAt">>>("/api/imported-evaluations"),
  importedEvaluation: (id: string) => request<ImportedEvaluation>(`/api/imported-evaluations/${encodeURIComponent(id)}`),
  createImportedEvaluation: (input: ImportedEvaluationInput) => request<ImportedEvaluation>("/api/imported-evaluations", {
    method: "POST", body: JSON.stringify(input)
  }),
  createImportedBatch: (input: ImportedBatchInput) => request<{ evaluation: ImportedEvaluation; token: string }>(
    "/api/imported-evaluations/batches", { method: "POST", body: JSON.stringify(input) }
  ),
  scenarioCatalog: () => request<Array<{ id: string; title: string }>>("/api/scenarios/catalog"),
  scenarioSelfCheck: () => request<ScenarioSelfCheck>("/api/scenarios/self-check"),
  startScenarioSelfCheck: (scenarioId?: string) => request<ScenarioSelfCheck>("/api/scenarios/self-check", {
    method: "POST", body: JSON.stringify(scenarioId ? { scenarioId } : {})
  }),
  scenarioBatches: () => request<ScenarioBatchSummary[]>("/api/scenarios"),
  scenarioBatch: (id: string) => request<ScenarioBatchDetail>(`/api/scenarios/${encodeURIComponent(id)}`),
  scenarioEvidence: (id: string, scenarioId: string, repetition: number) => request<unknown>(
    `/api/scenarios/${encodeURIComponent(id)}/${encodeURIComponent(scenarioId)}/${repetition}/evidence`
  ),
  dashboard: () => request<DashboardResponse>("/api/dashboard"),
  system: () => request<EvalSystemResponse>("/api/system"),
  judgeSettings: () => request<import("@hearth/eval-core").JudgeSettingsResponse>("/api/system/judge"),
  saveJudgeSettings: (input: import("@hearth/eval-core").JudgeSettingsInput) => request<import("@hearth/eval-core").JudgeSettingsResponse>("/api/system/judge", { method: "PUT", body: JSON.stringify(input) }),
  testJudge: (input: import("@hearth/eval-core").JudgeSettingsInput) => request<import("@hearth/eval-core").JudgeTestResult>("/api/system/judge/test", { method: "POST", body: JSON.stringify(input) }),
  storageSettings: () => request<import("@hearth/eval-core").StorageSettingsResponse>("/api/system/storage"),
  saveStorageSettings: (input: { dataDir: string; artifactRoot: string }) => request<import("@hearth/eval-core").StorageSettingsResponse>("/api/system/storage", { method: "PUT", body: JSON.stringify(input) }),
  directories: (path?: string) => request<import("@hearth/eval-core").DirectoryListing>(`/api/system/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  cases: (filters: CaseFilters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value);
    }
    return request<CaseCatalogResponse>(`/api/cases${query.size > 0 ? `?${query.toString()}` : ""}`);
  },
  caseDetail: (caseKey: string) => request<CaseDetailResponse>(`/api/cases/${encodeURIComponent(caseKey)}`),
  experiments: () => request<ExperimentsResponse>("/api/experiments"),
  experiment: (id: string) => request<ExperimentDetailResponse>(`/api/experiments/${encodeURIComponent(id)}`),
  createExperiment: (body: CreateExperimentRequest) => request<ExperimentRecord>("/api/experiments", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  cancelExperiment: (id: string) => request<ExperimentRecord>(`/api/experiments/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}"
  }),
  run: (id: string) => request<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}?includeTask=false`),
  runTask: (id: string) => request<Record<string, unknown> | null>(`/api/runs/${encodeURIComponent(id)}/task`),
  reviews: () => request<ReviewsResponse>("/api/reviews"),
  submitReview: (id: string, body: SubmitReviewRequest) => request<SubmitReviewResult>(`/api/runs/${encodeURIComponent(id)}/review`, {
    method: "POST",
    body: JSON.stringify(body)
  }),
  compare: (left: string, right: string) => {
    const query = new URLSearchParams({ left, right });
    return request<CompareResponse>(`/api/compare?${query.toString()}`);
  },
  regression: (id: string) => request<RegressionReport>(`/api/experiments/${encodeURIComponent(id)}/regression`),
  events: (input: { after?: number; limit?: number; experimentId?: string; runId?: string } = {}) => {
    const query = new URLSearchParams();
    if (input.after !== undefined) query.set("after", String(input.after));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.experimentId) query.set("experimentId", input.experimentId);
    if (input.runId) query.set("runId", input.runId);
    return request<EvalEventsResponse>(`/api/events${query.size > 0 ? `?${query.toString()}` : ""}`);
  },
  artifact: (runId: string, path: string) => {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return request<RunArtifactView>(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodedPath}`);
  },
  benchmarks: () => request<BenchmarkListResponse>("/api/benchmarks"),
  benchmarkJobs: () => request<BenchmarkJobsResponse>("/api/benchmarks/jobs"),
  importBenchmark: (input: BenchmarkImportInput) => request<BenchmarkImportResult>("/api/benchmarks/import", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  benchmark: (id: string) => request<BenchmarkDetailResponse>(`/api/benchmarks/${encodeURIComponent(id)}`),
  benchmarkTrials: (id: string, filters: { taskKey?: string; status?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<BenchmarkTrialsResponse>(`/api/benchmarks/${encodeURIComponent(id)}/trials${query.size > 0 ? `?${query.toString()}` : ""}`);
  },
  benchmarkTrial: (id: string, trialId: string) => request<BenchmarkTrialResponse>(
    `/api/benchmarks/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}`
  ),
  reimportBenchmark: (id: string, jobDir?: string) => request<BenchmarkImportResult>(
    `/api/benchmarks/${encodeURIComponent(id)}/reimport`,
    { method: "POST", body: JSON.stringify(jobDir ? { jobDir } : {}) }
  ),
  benchmarkExportUrl: (id: string) => `/api/benchmarks/${encodeURIComponent(id)}/export?format=csv`,
  compareBenchmarks: (candidate: string, baseline: string) => {
    const query = new URLSearchParams({ baseline });
    return request<BenchmarkCompareResponse>(`/api/benchmarks/${encodeURIComponent(candidate)}/compare?${query.toString()}`);
  }
};

export function latestEventSeq(events: EvalEventRecord[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

export function reviewItemRunId(item: ReviewQueueItem): string {
  return item.run.id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
