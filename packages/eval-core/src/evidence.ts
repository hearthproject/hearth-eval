// Reader-side mirror of the canonical `hearth-evidence/1` contract.
//
// The canonical schema lives in hearth-os (`apps/server/src/evidence/contracts.ts`).
// This module is intentionally an independent reader: the same versions, the
// same canonical JSON rules and the same compatibility fingerprint, guarded by
// golden fixtures in `evidence.test.ts` so the two repositories cannot drift
// silently. Hearth Eval never imports hearth-os source and never opens its DB.
import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_CONTRACT_ID = "hearth-evidence/1" as const;

export interface RepoState {
  role: "hearth-os" | "hearth-eval" | "other";
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  version: string | null;
}

export interface RuntimeModelFact {
  providerId: string | null;
  providerName: string | null;
  protocol: string;
  modelId: string;
  modelVersion: string | null;
  sampling: {
    temperature: number | null;
    maxTokens: number | null;
    reasoningEffort: string | null;
    seed: number | null;
  };
  contextWindowTokens: number | null;
}

export interface RuntimePromptFact {
  registryVersion: string;
  systemPromptHash: string | null;
  finalPromptHash: string | null;
  toolSchemaHash: string | null;
}

export interface RuntimeToolFact {
  catalogDigest: string | null;
  catalogSize: number | null;
  policy: "full" | "deferred" | "unknown";
  directTools: string[];
  mcpVersion: string | null;
}

export interface RuntimeContextFact {
  policyVersion: string | null;
  compactionThreshold: number | null;
  packId: string | null;
  mode: string | null;
}

export interface RuntimeApprovalFact {
  mode: string;
  policyVersion: string | null;
  policyHash: string | null;
  teamMode: boolean;
  recoveryPolicy: string | null;
  retryPolicy: string | null;
}

export interface RuntimeSandboxFact {
  backend: string;
  mode: string;
  networkMode: string;
  image: string | null;
  appContainer: string | null;
}

export interface RuntimeJudgeFact {
  model: string | null;
  promptHash: string | null;
  calibrationVersion: string | null;
}

export interface RuntimePricingFact {
  snapshotId: string;
  version: string;
  asOf: string;
}

export interface RuntimeBudgetFact {
  scope: "task" | "project" | "daily" | "experiment" | "ci" | "none";
  limits: Record<string, number>;
  degradationPolicy: string | null;
}

export interface RuntimeVariantFact {
  harnessVariantId: string;
  effectiveConfigDigest: string;
}

export interface RuntimeDepsFact {
  lockfileDigest: string | null;
}

export interface ManifestCompleteness {
  status: "complete" | "incomplete_provenance";
  missing: string[];
}

export interface RuntimeManifest {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  kind: "hearth-runtime-manifest";
  contract: typeof EVIDENCE_CONTRACT_ID;
  runId: string;
  taskId: string;
  taskTitle: string | null;
  createdAt: string;
  finalizedAt: string | null;
  repos: RepoState[];
  cases: { ids: string[]; versions: Record<string, number>; catalogDigest: string | null } | null;
  model: RuntimeModelFact | null;
  prompt: RuntimePromptFact | null;
  tools: RuntimeToolFact | null;
  context: RuntimeContextFact | null;
  approval: RuntimeApprovalFact | null;
  sandbox: RuntimeSandboxFact | null;
  judge: RuntimeJudgeFact | null;
  pricing: RuntimePricingFact | null;
  budget: RuntimeBudgetFact | null;
  variant: RuntimeVariantFact | null;
  deps: RuntimeDepsFact | null;
  executorId: string | null;
  compatibilityFingerprint: string;
  completeness: ManifestCompleteness;
}

export interface ProvenanceRef {
  kind: "artifact" | "file" | "url" | "text" | "context_pack" | "input";
  ref: string;
  sha256: string | null;
  bytes: number | null;
  label: string | null;
}

export interface ArtifactProvenance {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  kind: "hearth-artifact-provenance";
  contract: typeof EVIDENCE_CONTRACT_ID;
  artifactId: string;
  taskId: string;
  runId: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  producedBy: {
    runId: string;
    stepId: string | null;
    turn: number | null;
    toolCallId: string | null;
    toolName: string | null;
    operationIds: string[];
    checkpointSeq: number | null;
    inference: "explicit" | "inferred" | "unknown";
  };
  inputs: ProvenanceRef[];
  model: { providerId: string | null; modelId: string | null; requestFingerprint: string | null } | null;
  toolSchemaHash: string | null;
  policy: {
    version: string | null;
    hash: string | null;
    ruleId: string | null;
    approvalId: string | null;
    decision: string | null;
    permissionMode: string | null;
  } | null;
  environment: { digest: string | null; sandbox: string | null; workspaceDigest: string | null } | null;
  parents: Array<{ artifactId: string | null; relation: "replaces" | "companion" | "derived_from" | "unknown"; ref: string | null }>;
  lineage: { rootArtifactId: string | null; depth: number; supersedes: string | null };
  completeness: ManifestCompleteness;
}

export type ExchangeKind =
  | "model.request"
  | "model.response"
  | "tool.call"
  | "tool.result"
  | "approval.decision"
  | "context.candidates"
  | "context.selected"
  | "environment.snapshot"
  | "checkpoint"
  | "termination";

export interface ContentDescriptor {
  sha256: string;
  bytes: number;
  summary: string | null;
  mimeType?: string;
}

export interface RuntimeExchange {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  id: string;
  runId: string;
  parentId: string | null;
  kind: ExchangeKind;
  sequence: number;
  stepId: string | null;
  requestFingerprint: string | null;
  environmentDigest: string | null;
  input: ContentDescriptor;
  output: ContentDescriptor;
  latencyMs: number | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    turns?: number;
    toolCalls?: number;
  } | null;
  sideEffectReceipt: unknown;
  simulated: boolean;
  createdAt: string;
}

export interface DivergenceCategory {
  category:
    | "none"
    | "system_prompt"
    | "tool_schema"
    | "model"
    | "sampling"
    | "model_request"
    | "tool_arguments"
    | "tool_result"
    | "missing_step"
    | "extra_step"
    | "step_order"
    | "termination"
    | "environment"
    | "approval_policy"
    | "unknown";
  index: number;
  expected: string | null;
  actual: string | null;
  detail: Record<string, unknown>;
}

export interface DivergenceReport {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  id: string;
  cassetteId: string;
  candidateRunId: string;
  mode: "strict_replay" | "live_on_divergence";
  matched: boolean;
  totalRecordedSteps: number;
  totalCandidateSteps: number;
  firstDivergence: DivergenceCategory | null;
  categories: Record<string, number>;
  providerCalls: number;
  toolExecutions: number;
  simulatedReceipts: number;
  termination: { recorded: Record<string, unknown> | null; candidate: Record<string, unknown> };
  recordedSteps: Array<{ kind: string; fingerprint: string | null; sequence: number; simulated: boolean }>;
  candidateSteps: Array<{ kind: string; fingerprint: string | null; sequence: number; simulated: boolean; detail?: Record<string, unknown> | null }>;
  origin: "replay" | "checkpoint_fork";
  parentRunId: string | null;
  checkpointSeq: number | null;
  reproductionCommand: string;
  generatedAt: string;
}

/** Compatibility categories required by the evaluation report. */
export type FirstDivergenceClass =
  | "context_candidate_set"
  | "context_selection"
  | "prompt_serialization"
  | "tool_catalog"
  | "model_request"
  | "model_response"
  | "tool_arguments"
  | "tool_result"
  | "approval_policy"
  | "environment"
  | "unknown";

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    output[key] = canonicalize(item, seen);
  }
  return output;
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export interface FingerprintPayload {
  repos: Array<{ role: string; commit: string | null; dirty: boolean | null }>;
  cases: RuntimeManifest["cases"];
  model: RuntimeModelFact | null;
  prompt: Pick<RuntimePromptFact, "registryVersion" | "systemPromptHash" | "finalPromptHash" | "toolSchemaHash"> | null;
  tools: Pick<RuntimeToolFact, "catalogDigest" | "policy" | "directTools" | "mcpVersion"> | null;
  context: Pick<RuntimeContextFact, "policyVersion" | "compactionThreshold" | "mode"> | null;
  approval: Pick<RuntimeApprovalFact, "mode" | "policyVersion" | "policyHash" | "teamMode"> | null;
  sandbox: Pick<RuntimeSandboxFact, "backend" | "mode" | "networkMode" | "image" | "appContainer"> | null;
  judge: RuntimeJudgeFact | null;
  pricing: Pick<RuntimePricingFact, "snapshotId" | "version"> | null;
  budget: Pick<RuntimeBudgetFact, "limits" | "degradationPolicy"> | null;
  variant: RuntimeVariantFact | null;
  deps: RuntimeDepsFact | null;
}

export function fingerprintPayload(manifest: RuntimeManifest): FingerprintPayload {
  return {
    repos: manifest.repos.map((repo) => ({ role: repo.role, commit: repo.commit, dirty: repo.dirty })),
    cases: manifest.cases,
    model: manifest.model,
    prompt: manifest.prompt
      ? {
        registryVersion: manifest.prompt.registryVersion,
        systemPromptHash: manifest.prompt.systemPromptHash,
        finalPromptHash: manifest.prompt.finalPromptHash,
        toolSchemaHash: manifest.prompt.toolSchemaHash
      }
      : null,
    tools: manifest.tools
      ? {
        catalogDigest: manifest.tools.catalogDigest,
        policy: manifest.tools.policy,
        directTools: manifest.tools.directTools,
        mcpVersion: manifest.tools.mcpVersion
      }
      : null,
    context: manifest.context
      ? {
        policyVersion: manifest.context.policyVersion,
        compactionThreshold: manifest.context.compactionThreshold,
        mode: manifest.context.mode
      }
      : null,
    approval: manifest.approval
      ? {
        mode: manifest.approval.mode,
        policyVersion: manifest.approval.policyVersion,
        policyHash: manifest.approval.policyHash,
        teamMode: manifest.approval.teamMode
      }
      : null,
    sandbox: manifest.sandbox
      ? {
        backend: manifest.sandbox.backend,
        mode: manifest.sandbox.mode,
        networkMode: manifest.sandbox.networkMode,
        image: manifest.sandbox.image,
        appContainer: manifest.sandbox.appContainer
      }
      : null,
    judge: manifest.judge,
    pricing: manifest.pricing ? { snapshotId: manifest.pricing.snapshotId, version: manifest.pricing.version } : null,
    budget: manifest.budget ? { limits: manifest.budget.limits, degradationPolicy: manifest.budget.degradationPolicy } : null,
    variant: manifest.variant,
    deps: manifest.deps
  };
}

export function compatibilityFingerprint(manifest: RuntimeManifest): string {
  return sha256Hex(canonicalJson(fingerprintPayload(manifest)));
}

export interface CompatibilityComponent {
  component: string;
  left: string | null;
  right: string | null;
  status: "same" | "changed" | "missing_left" | "missing_right" | "missing_both";
}

export interface CompatibilityDiff {
  same: boolean;
  leftFingerprint: string | null;
  rightFingerprint: string | null;
  components: CompatibilityComponent[];
}

const COMPONENT_FIELDS: Array<{ component: string; pick: (manifest: RuntimeManifest) => unknown }> = [
  { component: "repos", pick: (m) => m.repos.map((repo) => `${repo.role}:${repo.commit ?? "unknown"}:${repo.dirty ? "dirty" : "clean"}`) },
  { component: "cases", pick: (m) => m.cases },
  { component: "model", pick: (m) => m.model },
  { component: "prompt", pick: (m) => m.prompt },
  { component: "tools", pick: (m) => m.tools },
  { component: "context", pick: (m) => m.context },
  { component: "approval", pick: (m) => m.approval },
  { component: "sandbox", pick: (m) => m.sandbox },
  { component: "judge", pick: (m) => m.judge },
  { component: "pricing", pick: (m) => m.pricing },
  { component: "budget", pick: (m) => m.budget },
  { component: "variant", pick: (m) => m.variant },
  { component: "deps", pick: (m) => m.deps }
];

function componentValue(manifest: RuntimeManifest | null, pick: (manifest: RuntimeManifest) => unknown): string | null {
  if (!manifest) return null;
  const value = pick(manifest);
  if (value === null || value === undefined) return null;
  return canonicalJson(value);
}

export function compatibilityDiff(left: RuntimeManifest | null, right: RuntimeManifest | null): CompatibilityDiff {
  const components = COMPONENT_FIELDS.map(({ component, pick }): CompatibilityComponent => {
    const leftValue = componentValue(left, pick);
    const rightValue = componentValue(right, pick);
    if (leftValue === null && rightValue === null) {
      return { component, left: null, right: null, status: "missing_both" };
    }
    if (leftValue === null) return { component, left: null, right: rightValue, status: "missing_left" };
    if (rightValue === null) return { component, left: leftValue, right: null, status: "missing_right" };
    return {
      component,
      left: leftValue,
      right: rightValue,
      status: leftValue === rightValue ? "same" : "changed"
    };
  });
  return {
    same: components.every((item) => item.status === "same" || item.status === "missing_both"),
    leftFingerprint: left?.compatibilityFingerprint ?? null,
    rightFingerprint: right?.compatibilityFingerprint ?? null,
    components
  };
}

/** Validate a manifest received over HTTP; missing evidence stays incomplete. */
export function parseRuntimeManifest(value: unknown): { ok: true; manifest: RuntimeManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["manifest 必须是对象"] };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) errors.push("schemaVersion 必须为 1");
  if (record.kind !== "hearth-runtime-manifest") errors.push("kind 必须是 hearth-runtime-manifest");
  if (record.contract !== EVIDENCE_CONTRACT_ID) errors.push(`contract 必须是 ${EVIDENCE_CONTRACT_ID}`);
  if (typeof record.runId !== "string" || !record.runId) errors.push("runId 必填");
  if (typeof record.compatibilityFingerprint !== "string" || !record.compatibilityFingerprint) errors.push("compatibilityFingerprint 必填");
  const manifest = record as unknown as RuntimeManifest;
  if (errors.length === 0 && compatibilityFingerprint(manifest) !== manifest.compatibilityFingerprint) {
    errors.push("compatibilityFingerprint 与规范化字段不一致");
  }
  return errors.length === 0 ? { ok: true, manifest } : { ok: false, errors };
}

export function verifyManifestFingerprint(manifest: RuntimeManifest): boolean {
  return compatibilityFingerprint(manifest) === manifest.compatibilityFingerprint;
}

/** Map the runtime's fine-grained category to the evaluation vocabulary. */
export function classifyDivergence(report: Pick<DivergenceReport, "firstDivergence">): FirstDivergenceClass {
  const category = report.firstDivergence?.category ?? "unknown";
  switch (category) {
    case "none":
      return "unknown";
    case "system_prompt":
      return "prompt_serialization";
    case "tool_schema":
      return "tool_catalog";
    case "model":
      return "model_response";
    case "sampling":
    case "model_request":
      return "model_request";
    case "tool_arguments":
      return category;
    case "tool_result":
      return category;
    case "environment":
      return "environment";
    case "approval_policy":
      return "approval_policy";
    default:
      return "unknown";
  }
}

export function exchangesOfKind(exchanges: RuntimeExchange[], kind: ExchangeKind): RuntimeExchange[] {
  return exchanges.filter((exchange) => exchange.kind === kind);
}

export function exchangeChain(exchanges: RuntimeExchange[]): RuntimeExchange[] {
  return [...exchanges].sort((left, right) => left.sequence - right.sequence);
}
