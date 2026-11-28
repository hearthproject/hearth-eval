export const EVAL_FAMILIES = [
  "email",
  "calendar",
  "documents",
  "research",
  "code",
  "web",
  "desktop",
  "cross-app",
  "operations",
  "memory"
] as const;
export type EvalFamily = (typeof EVAL_FAMILIES)[number];

export const GATE_LAYERS = [
  "result",
  "trajectory",
  "action",
  "knowledge",
  "system",
  "safety"
] as const;
export type GateLayer = (typeof GATE_LAYERS)[number];

export const EVAL_METRIC_KEYS = [
  "task_success",
  "tool_selection",
  "recovery",
  "arguments",
  "knowledge_grounding",
  "latency",
  "cost",
  "security"
] as const;
export type EvalMetricKey = (typeof EVAL_METRIC_KEYS)[number];

export const CASE_LIFECYCLES = ["active", "archived"] as const;
export type CaseLifecycle = (typeof CASE_LIFECYCLES)[number];

export const EVAL_DIFFICULTIES = ["normal", "edge", "failure", "adversarial"] as const;
export type EvalDifficulty = (typeof EVAL_DIFFICULTIES)[number];

export const EVAL_RUN_MODES = ["offline", "live-optional", "live-only"] as const;
export type EvalRunMode = (typeof EVAL_RUN_MODES)[number];

export const EXPERIMENT_STATUSES = [
  "queued",
  "running",
  "grading",
  "needs_review",
  "completed",
  "failed",
  "cancelled"
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EXPERIMENT_RUN_STATUSES = [
  "queued",
  "created",
  "running",
  "waiting",
  "grading",
  "needs_review",
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "error"
] as const;
export type ExperimentRunStatus = (typeof EXPERIMENT_RUN_STATUSES)[number];

export const REVIEW_TRIGGER_KINDS = [
  "low_confidence",
  "judge_conflict",
  "blocker_anomaly",
  "failed_sample",
  "judge_unavailable",
  "sampled"
] as const;
export type ReviewTriggerKind = (typeof REVIEW_TRIGGER_KINDS)[number];

export const GRADER_KINDS = [
  "file",
  "text",
  "json",
  "csv",
  "artifact_count",
  "state",
  "mail_draft",
  "trace"
] as const;
export type GraderKind = (typeof GRADER_KINDS)[number];

export interface EvalInput {
  kind: "file" | "url" | "text";
  label: string;
  path?: string;
  value?: string;
  optional?: boolean;
}

export interface FileGraderConfig {
  kind: "file";
  path: string;
  minBytes?: number;
}

export interface TextGraderConfig {
  kind: "text";
  path: string;
  includes?: string[];
  excludes?: string[];
  regex?: string[];
}

export interface JsonGraderConfig {
  kind: "json";
  path: string;
  requiredPaths?: string[];
  equals?: Record<string, unknown>;
  minArrayLength?: Record<string, number>;
  /** Exact set of string keys; compare configured fields independently of item order. */
  keyedArrays?: Array<{ path: string; key: string; expected: Record<string, Record<string, unknown>> }>;
}

export interface CsvGraderConfig {
  kind: "csv";
  path: string;
  requiredColumns?: string[];
  minRows?: number;
  requiredValues?: Array<{ column: string; equals: string }>;
}

export interface ArtifactCountGraderConfig {
  kind: "artifact_count";
  prefix?: string;
  suffix?: string;
  min: number;
}

export interface StateGraderConfig {
  kind: "state";
  path: string;
  expected: Record<string, unknown>;
}

export interface MailDraftGraderConfig {
  kind: "mail_draft";
  path: string;
  expected: { To: string; Subject: string; Body: string };
}

export interface TraceGraderConfig {
  kind: "trace";
  maxSteps?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxTokens?: number;
  minApprovals?: number;
  minEffects?: number;
  maxEffects?: number;
  requireNoErrors?: boolean;
}

export type GraderConfig =
  | FileGraderConfig
  | TextGraderConfig
  | JsonGraderConfig
  | CsvGraderConfig
  | ArtifactCountGraderConfig
  | StateGraderConfig
  | MailDraftGraderConfig
  | TraceGraderConfig;

export interface BudgetLimits {
  maxSteps?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface GraderSpec {
  id: string;
  title: string;
  config: GraderConfig;
}

export interface EvalCriterion {
  id: string;
  label: string;
  source: "deterministic" | "judge" | "human";
  points: number;
  severity: "blocker" | "scored";
  layer?: GateLayer;
  metric?: EvalMetricKey;
  graderId?: string;
  rubric?: string;
}

export interface CaseManifest {
  schemaVersion: 1 | 2;
  id: string;
  version: number;
  lifecycle?: CaseLifecycle;
  title: string;
  family: EvalFamily;
  difficulty: EvalDifficulty;
  runModes: EvalRunMode[];
  description: string;
  goal: string;
  tags: string[];
  timeoutMs: number;
  inputs: EvalInput[];
  liveInputs?: EvalInput[];
  networkHosts?: string[];
  expectedOutputs: string[];
  graders: GraderSpec[];
  criteria: EvalCriterion[];
  budgets?: BudgetLimits;
  humanReview: {
    prompt: string;
    sampleRate: number;
  };
}

export interface ExperimentConfig {
  name: string;
  caseIds: string[];
  executorIds: string[];
  repetitions: number;
  runMode: "offline" | "live";
  autoJudge: boolean;
  autoRetry: boolean;
  maxConcurrency: number;
  baselineExperimentId?: string | null;
  /** Harness variant under test; the baseline variant is `baseline`. */
  harnessVariantId?: string;
  /** Optional experiment-level USD budget. */
  maxCostUsd?: number;
}

export interface ExperimentEnvironment {
  hearthUrl: string;
  hearthNow: string | null;
  schemaVersion: number | null;
  instanceId: string | null;
  executorSettings: Record<string, unknown>;
  judgeModel: string | null;
  evalVersion: string;
}

export interface CaseVersionSummary {
  caseKey: string;
  version: number;
  schemaVersion: number;
  lifecycle: CaseLifecycle;
  title: string;
  family: EvalFamily;
  difficulty: EvalDifficulty;
  runModes: EvalRunMode[];
  contentHash: string;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: ExperimentStatus;
  config: ExperimentConfig;
  environment: ExperimentEnvironment;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: ExperimentSummary | null;
}

export interface ExperimentRunRecord {
  id: string;
  experimentId: string;
  caseKey: string;
  caseVersion: number;
  caseContentHash: string;
  executorId: string;
  repetition: number;
  status: ExperimentRunStatus;
  hearthTaskId: string | null;
  outputDir: string;
  externalRef: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  score: number | null;
  error: string | null;
  primaryCause?: AttributionCause | null;
  reviewReasons: ReviewTriggerKind[];
  createdAt: string;
  updatedAt: string;
}

export interface GraderResultRecord {
  id: string;
  runId: string;
  criterionId: string;
  source: "deterministic" | "judge" | "human";
  passed: boolean | null;
  score: number | null;
  confidence: number | null;
  reason: string;
  evidence: string[];
  model: string | null;
  promptHash: string | null;
  createdAt: string;
}

export interface HumanReviewRecord {
  id: string;
  runId: string;
  reviewer: string;
  decision: "pass" | "fail" | "unknown";
  score: number | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FamilySummary {
  family: EvalFamily;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  needsReview: number;
  passRate: number | null;
  avgScore: number | null;
}

export interface ExperimentSummary {
  experimentId: string;
  totalRuns: number;
  passed: number;
  failed: number;
  blocked: number;
  needsReview: number;
  passRate: number | null;
  avgScore: number | null;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  approvals: number;
  families: FamilySummary[];
  metrics: MetricSummary[];
  judgeCalibration: JudgeCalibrationSummary;
  failureDiagnostics: Array<{ kind: string; count: number; runIds: string[] }>;
  generatedAt: string;
  /** Real-USD accounting; null when the experiment has no priced runs. */
  cost?: ExperimentCostSummary | null;
  variant?: VariantExperimentSummary | null;
}

export interface ExperimentCostSummary {
  totalUsd: number;
  pricedRuns: number;
  unpricedRuns: number;
  avgUsdPerRun: number | null;
  costPerVerifiedCompletion: number | null;
  failedUsd: number;
  retryIncrementUsd: number;
  pricingSnapshotIds: string[];
  byExecutor: Array<{ executorId: string; usd: number; runs: number }>;
}

export interface VariantExperimentSummary {
  harnessVariantId: string;
  totalRuns: number;
  passed: number;
  passRate: number | null;
  avgScore: number | null;
  totalUsd: number;
  avgDurationMs: number | null;
  wilson95: { lower: number; upper: number } | null;
}

export interface MetricSummary {
  key: EvalMetricKey;
  label: string;
  score: number | null;
  sampleSize: number;
  detail: string;
}

export interface JudgeCalibrationSummary {
  expectedRuns: number;
  judgedRuns: number;
  coverage: number | null;
  reviewedRuns: number;
  agreement: number | null;
  falsePass: number;
  falseFail: number;
  lowConfidenceRuns: number;
  lowConfidenceRate: number | null;
}

export interface ExperimentComparison {
  leftExperimentId: string;
  rightExperimentId: string;
  aligned: boolean;
  warnings: string[];
  left: ExperimentSummary | null;
  right: ExperimentSummary | null;
  familyDeltas: Array<{ family: EvalFamily; leftPassRate: number | null; rightPassRate: number | null; delta: number | null }>;
}

export interface EvalEventRecord {
  seq: number;
  type: string;
  experimentId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EvalTaskRequest {
  externalRef: string;
  title: string;
  goal: string;
  inputs: Array<{ kind: "file" | "url"; label: string; value: string; sha256?: string }>;
  expectedOutputs: string[];
  executorId?: string;
  runMode: "offline" | "live";
  networkHosts?: string[];
  outputDir: string;
  timeoutMs?: number;
  /** Task-level harness variant; OS applies its overrides to the runtime. */
  harnessVariantId?: string;
}

export interface JudgeCriterionRequest {
  id: string;
  label: string;
  rubric: string;
  points: number;
}

export interface JudgeRequest {
  taskId: string;
  criteria: JudgeCriterionRequest[];
  deterministic: Array<{ criterionId: string; passed: boolean; reason: string }>;
  locale?: string;
}

export interface JudgeCriterionResult {
  id: string;
  passed: boolean;
  confidence: number;
  reason: string;
  evidence: string[];
}

export interface JudgeResponse {
  diagnostics?: Record<string, unknown>;
  model: string;
  promptHash: string;
  criteria: JudgeCriterionResult[];
  overallConfidence: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ScoringOutcome {
  verdict: "passed" | "failed" | "needs_review";
  score: number | null;
  objectiveScore: number | null;
  judgeScore: number | null;
  humanScore: number | null;
  blockerFailures: string[];
  gateWarnings: string[];
  reviewReasons: ReviewTriggerKind[];
  humanOverride: boolean;
}

export const ATTRIBUTION_CAUSES = [
  "none",
  "task_timeout",
  "tool_error",
  "approval_blocked",
  "artifact_missing",
  "grader_failure",
  "judge_unavailable",
  "model_error",
  "policy_denied",
  "trace_unavailable",
  "unknown"
] as const;
export type AttributionCause = (typeof ATTRIBUTION_CAUSES)[number];

export interface EvalTraceEvent {
  seq: number;
  type: string;
  runId: string | null;
  step: number;
  phase: "run" | "approval" | "effect" | "artifact" | "error" | "outbox" | "other";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EvalTrace {
  taskId: string;
  fetchedAt: string;
  events: EvalTraceEvent[];
  truncated: boolean;
  steps: number;
  toolCalls: number;
  approvals: number;
  effects: number;
  artifacts: number;
  errors: Array<{ seq: number; message: string }>;
  primaryCause: AttributionCause;
}

export type ArtifactMap = Record<string, { text: string; bytes: number; mimeType?: string }>;
export interface ScenarioSelfCheck {
  batchId?: string;
  status: "idle" | "running" | "passed" | "failed" | "error";
  output: string;
  markdown: string | null;
  total: number | null;
  passed: number | null;
}
