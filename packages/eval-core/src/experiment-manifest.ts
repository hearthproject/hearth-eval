// ExperimentManifest: the evaluation-side counterpart of RuntimeManifest.
//
// It records everything that decides whether two experiments are comparable:
// case versions and catalog digest, model/prompt/tools/context/policy/sandbox,
// judge, pricing snapshot, budget and harness variant. The compatibility
// fingerprint uses the same canonical payload as the OS contract, so a change
// in any behavioural component changes the fingerprint.
import {
  EVIDENCE_CONTRACT_ID,
  EVIDENCE_SCHEMA_VERSION,
  compatibilityDiff,
  compatibilityFingerprint,
  digestOf,
  fingerprintPayload,
  type CompatibilityDiff,
  type ManifestCompleteness,
  type RepoState,
  type RuntimeApprovalFact,
  type RuntimeBudgetFact,
  type RuntimeContextFact,
  type RuntimeDepsFact,
  type RuntimeJudgeFact,
  type RuntimeManifest,
  type RuntimeModelFact,
  type RuntimePricingFact,
  type RuntimePromptFact,
  type RuntimeSandboxFact,
  type RuntimeToolFact,
  type RuntimeVariantFact
} from "./evidence.ts";
import type { CaseManifest, ExperimentEnvironment } from "./types.ts";

export interface ExperimentManifest {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  kind: "hearth-experiment-manifest";
  contract: typeof EVIDENCE_CONTRACT_ID;
  experimentId: string;
  name: string;
  createdAt: string;
  finalizedAt: string | null;
  repos: RepoState[];
  cases: { ids: string[]; versions: Record<string, number>; catalogDigest: string | null };
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
  environment: ExperimentEnvironment;
  compatibilityFingerprint: string;
  completeness: ManifestCompleteness;
}

export interface BuildExperimentManifestInput {
  experimentId: string;
  name: string;
  createdAt: string;
  finalizedAt?: string | null;
  cases: CaseManifest[];
  environment: ExperimentEnvironment;
  repos?: RepoState[];
  model?: RuntimeModelFact | null;
  prompt?: RuntimePromptFact | null;
  tools?: RuntimeToolFact | null;
  context?: RuntimeContextFact | null;
  approval?: RuntimeApprovalFact | null;
  sandbox?: RuntimeSandboxFact | null;
  judge?: RuntimeJudgeFact | null;
  pricing?: RuntimePricingFact | null;
  budget?: RuntimeBudgetFact | null;
  variant?: RuntimeVariantFact | null;
  deps?: RuntimeDepsFact | null;
}

const REQUIRED_COMPONENTS = ["model", "prompt", "tools", "context", "judge", "pricing", "variant"] as const;

export function buildExperimentManifest(input: BuildExperimentManifestInput): ExperimentManifest {
  const ids = input.cases.map((item) => item.id).sort();
  const versions = Object.fromEntries(input.cases.map((item) => [item.id, item.version]));
  const hashes = input.cases.map((item) => {
    const contentHash = (item as CaseManifest & { contentHash?: string }).contentHash;
    return `${item.id}@${item.version}:${contentHash ?? digestOf(item)}`;
  });
  const manifest: ExperimentManifest = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "hearth-experiment-manifest",
    contract: EVIDENCE_CONTRACT_ID,
    experimentId: input.experimentId,
    name: input.name,
    createdAt: input.createdAt,
    finalizedAt: input.finalizedAt ?? null,
    repos: input.repos ?? [],
    cases: { ids, versions, catalogDigest: digestOf(hashes) },
    model: input.model ?? null,
    prompt: input.prompt ?? null,
    tools: input.tools ?? null,
    context: input.context ?? null,
    approval: input.approval ?? null,
    sandbox: input.sandbox ?? null,
    judge: input.judge ?? null,
    pricing: input.pricing ?? null,
    budget: input.budget ?? null,
    variant: input.variant ?? null,
    deps: input.deps ?? null,
    environment: input.environment,
    compatibilityFingerprint: "",
    completeness: { status: "complete", missing: [] }
  };
  const missing = REQUIRED_COMPONENTS.filter((component) => manifest[component] === null).map((component) => String(component));
  manifest.completeness = missing.length === 0
    ? { status: "complete", missing: [] }
    : { status: "incomplete_provenance", missing };
  manifest.compatibilityFingerprint = experimentFingerprint(manifest);
  return manifest;
}

function asRuntimeManifest(manifest: ExperimentManifest): RuntimeManifest {
  return {
    ...manifest,
    kind: "hearth-runtime-manifest",
    runId: manifest.experimentId,
    taskId: manifest.experimentId,
    taskTitle: manifest.name,
    executorId: null
  };
}

export function experimentFingerprint(manifest: ExperimentManifest): string {
  return compatibilityFingerprint(asRuntimeManifest(manifest));
}

export function fingerprintPayloadOf(manifest: ExperimentManifest) {
  return fingerprintPayload(asRuntimeManifest(manifest));
}

export function experimentDiff(left: ExperimentManifest | null, right: ExperimentManifest | null): CompatibilityDiff {
  return compatibilityDiff(left ? asRuntimeManifest(left) : null, right ? asRuntimeManifest(right) : null);
}

export function parseExperimentManifest(value: unknown): { ok: true; manifest: ExperimentManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["manifest 必须是对象"] };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) errors.push("schemaVersion 必须为 1");
  if (record.kind !== "hearth-experiment-manifest") errors.push("kind 必须是 hearth-experiment-manifest");
  if (record.contract !== EVIDENCE_CONTRACT_ID) errors.push(`contract 必须是 ${EVIDENCE_CONTRACT_ID}`);
  if (typeof record.experimentId !== "string" || !record.experimentId) errors.push("experimentId 必填");
  const manifest = record as unknown as ExperimentManifest;
  if (errors.length === 0 && experimentFingerprint(manifest) !== manifest.compatibilityFingerprint) {
    errors.push("compatibilityFingerprint 与规范化字段不一致");
  }
  return errors.length === 0 ? { ok: true, manifest } : { ok: false, errors };
}
