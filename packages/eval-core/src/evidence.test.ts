import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceReproduction,
  buildExperimentManifest,
  classifyDivergence,
  compatibilityDiff,
  compatibilityFingerprint,
  compileFailureToCase,
  digestOf,
  experimentDiff,
  parseExperimentManifest,
  parseRuntimeManifest,
  redactText,
  selectStableSubset,
  verifyManifestFingerprint,
  type CaseVersionSummary,
  type RuntimeManifest,
  type VerificationSpec
} from "./index.ts";
import { evaluateRegressionGate, DEFAULT_REGRESSION_GATE } from "./regression-budget.ts";
import { compareVariants } from "./variant-lab.ts";
import { runVerificationSpec } from "./verification.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-eval-core-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows may keep SQLite/WAL handles briefly.
    }
  }
});

function fixtureManifest(): RuntimeManifest {
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    kind: "hearth-runtime-manifest",
    contract: "hearth-evidence/1",
    runId: "run-golden",
    taskId: "task-golden",
    taskTitle: "黄金契约",
    createdAt: "2026-11-27T00:00:00.000Z",
    finalizedAt: "2026-11-27T00:01:00.000Z",
    repos: [{ role: "hearth-os", commit: "abc123", branch: "main", dirty: false, version: "0.9.0" }],
    cases: { ids: ["case-a"], versions: { "case-a": 1 }, catalogDigest: "sha256:catalog" },
    model: {
      providerId: "deepseek",
      providerName: "DeepSeek",
      protocol: "openai-compatible",
      modelId: "deepseek-v4",
      modelVersion: null,
      sampling: { temperature: 0.2, maxTokens: 4096, reasoningEffort: null, seed: null },
      contextWindowTokens: 128000
    },
    prompt: { registryVersion: "prompt-r7", systemPromptHash: "sys", finalPromptHash: "final", toolSchemaHash: "tools" },
    tools: { catalogDigest: "catalog", catalogSize: 12, policy: "full", directTools: ["read_file"], mcpVersion: "1" },
    context: { policyVersion: "context-balanced", compactionThreshold: 0.7, packId: "pack-1", mode: "balanced" },
    approval: { mode: "necessary", policyVersion: "policy/1", policyHash: "ph", teamMode: true, recoveryPolicy: "manual", retryPolicy: "none" },
    sandbox: { backend: "windows-native", mode: "workspace-write", networkMode: "deny", image: null, appContainer: "hearth" },
    judge: { model: "judge-v1", promptHash: "jh", calibrationVersion: "cal-1" },
    pricing: { snapshotId: "pricing:abc", version: "2026-11", asOf: "2026-11-01" },
    budget: { scope: "task", limits: { maxCostUsd: 5 }, degradationPolicy: "quality_aware" },
    variant: { harnessVariantId: "baseline", effectiveConfigDigest: "cfg" },
    deps: { lockfileDigest: "lock" },
    executorId: "native",
    compatibilityFingerprint: "",
    completeness: { status: "complete", missing: [] }
  };
  manifest.compatibilityFingerprint = compatibilityFingerprint(manifest);
  return manifest;
}

describe("hearth-evidence/1 reader contract", () => {
  it("freezes the canonical fingerprint of a full manifest", () => {
    const manifest = fixtureManifest();
    // Golden value: any schema/fingerprint drift changes this assertion.
    expect(manifest.compatibilityFingerprint).toBe("b7bd658cc1b0ba0039a6c0ff27c188052afcba30a0e8be920d551acec6755f4d");
    expect(verifyManifestFingerprint(manifest)).toBe(true);
  });

  it("rejects a manifest whose fingerprint was tampered with", () => {
    const manifest = fixtureManifest();
    manifest.compatibilityFingerprint = "deadbeef";
    const parsed = parseRuntimeManifest(manifest);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toContain("不一致");
  });

  it("marks missing required evidence as incomplete instead of inventing it", () => {
    const manifest = fixtureManifest();
    manifest.model = null;
    manifest.judge = null;
    manifest.compatibilityFingerprint = compatibilityFingerprint(manifest);
    manifest.completeness = { status: "incomplete_provenance", missing: ["model", "judge"] };
    expect(verifyManifestFingerprint(manifest)).toBe(true);
  });

  it("diffs components and ignores run identity", () => {
    const left = fixtureManifest();
    const right = { ...fixtureManifest(), runId: "run-other", compatibilityFingerprint: "" };
    right.compatibilityFingerprint = compatibilityFingerprint(right);
    expect(compatibilityFingerprint(right)).toBe(compatibilityFingerprint(left));
    right.model = null;
    right.compatibilityFingerprint = compatibilityFingerprint(right);
    const diff = compatibilityDiff(left, right);
    expect(diff.same).toBe(false);
    expect(diff.components.find((item) => item.component === "model")?.status).toBe("missing_right");
    expect(diff.components.find((item) => item.component === "prompt")?.status).toBe("same");
  });

  it("maps runtime divergence to evaluation classes", () => {
    expect(classifyDivergence({ firstDivergence: { category: "system_prompt", index: 0, expected: null, actual: null, detail: {} } })).toBe("prompt_serialization");
    expect(classifyDivergence({ firstDivergence: { category: "tool_schema", index: 0, expected: null, actual: null, detail: {} } })).toBe("tool_catalog");
    expect(classifyDivergence({ firstDivergence: { category: "model", index: 0, expected: null, actual: null, detail: {} } })).toBe("model_response");
    expect(classifyDivergence({ firstDivergence: null })).toBe("unknown");
  });
});

describe("ExperimentManifest", () => {
  const cases = [{
    schemaVersion: 2,
    id: "case-a",
    version: 1,
    lifecycle: "active",
    title: "A",
    family: "operations",
    difficulty: "normal",
    runModes: ["offline"],
    description: "d",
    goal: "g",
    tags: [],
    timeoutMs: 1000,
    inputs: [],
    expectedOutputs: ["report.md"],
    graders: [],
    criteria: []
  }] as unknown as Parameters<typeof buildExperimentManifest>[0]["cases"];

  it("builds a stable experiment fingerprint and reports incompleteness", () => {
    const manifest = buildExperimentManifest({
      experimentId: "exp-1",
      name: "实验",
      createdAt: "2026-11-27T00:00:00.000Z",
      cases,
      environment: {
        hearthUrl: "http://127.0.0.1:4317",
        hearthNow: null,
        schemaVersion: 1,
        instanceId: "i",
        executorSettings: {},
        judgeModel: "judge",
        evalVersion: "0.9.0"
      }
    });
    expect(manifest.completeness.status).toBe("incomplete_provenance");
    expect(manifest.completeness.missing).toContain("model");
    expect(parseExperimentManifest(manifest).ok).toBe(true);
    const same = buildExperimentManifest({
      experimentId: "exp-2",
      name: "实验2",
      createdAt: "2026-11-27T00:00:00.000Z",
      cases,
      environment: {
        hearthUrl: "http://127.0.0.1:4317",
        hearthNow: null,
        schemaVersion: 1,
        instanceId: "i",
        executorSettings: {},
        judgeModel: "judge",
        evalVersion: "0.9.0"
      }
    });
    expect(same.compatibilityFingerprint).toBe(manifest.compatibilityFingerprint);
    expect(experimentDiff(manifest, same).same).toBe(true);
  });
});

describe("failure to case compiler", () => {
  it("redacts secrets and emits a reproducible regression case", () => {
    const redacted = redactText("key sk-abcdefghijklmnop1234 email a@b.com at C:\\Users\\jason\\secret.txt", "goal");
    expect(redacted.text).not.toContain("sk-abcdefghijklmnop1234");
    expect(redacted.text).toContain("[REDACTED_SECRET]");
    expect(redacted.decisions.length).toBeGreaterThan(0);

    const bundle = compileFailureToCase({
      runId: "run-9",
      taskId: "task-9",
      title: "审批后误删文件",
      goal: "整理目录并保留审批记录",
      primaryCause: "policy_denied",
      artifacts: [{ relativePath: "report.md" }],
      expectedOutputs: ["report.md"],
      observed: { steps: 10, toolCalls: 4, approvals: 1 }
    });
    expect(bundle.manifest.id).toMatch(/^regression-/);
    expect(bundle.manifest.criteria.some((item) => item.layer === "safety")).toBe(true);
    expect(bundle.contract.state).toBe("pending");
    expect(bundle.contract.negativeAssertions.length).toBeGreaterThan(0);
    expect(bundle.provenance.compilerVersion).toBe("failure-to-case/1");
  });

  it("requires baseline fail then patched pass before acceptance", () => {
    const bundle = compileFailureToCase({ runId: "r", taskId: "t", title: "T", goal: "G" });
    let contract = advanceReproduction(bundle.contract, { stage: "baseline", experimentId: "e1", runId: "r1", verdict: "passed" });
    expect(contract.state).toBe("rejected");
    contract = advanceReproduction(bundle.contract, { stage: "baseline", experimentId: "e1", runId: "r1", verdict: "failed" });
    expect(contract.state).toBe("baseline_failed");
    contract = advanceReproduction(contract, { stage: "patched", experimentId: "e2", runId: "r2", verdict: "passed" });
    expect(contract.state).toBe("patched_passed");
    contract = advanceReproduction(contract, { stage: "approve", reviewer: "jason" });
    expect(contract.state).toBe("accepted");
  });
});

describe("variant lab and regression budget", () => {
  it("computes paired bootstrap intervals deterministically", () => {
    const left = Array.from({ length: 8 }, (_, index) => ({
      caseKey: `c${index % 4}`,
      repetition: Math.floor(index / 4) + 1,
      passed: index % 3 !== 0,
      score: index % 3 !== 0 ? 80 : 40,
      costUsd: 0.02,
      durationMs: 1000
    }));
    const right = left.map((run) => ({ ...run, passed: true, score: 90, costUsd: 0.03, durationMs: 1200 }));
    const first = compareVariants({ leftVariantId: "baseline", rightVariantId: "context-compact", leftRuns: left, rightRuns: right, seed: 7 });
    const second = compareVariants({ leftVariantId: "baseline", rightVariantId: "context-compact", leftRuns: left, rightRuns: right, seed: 7 });
    expect(first.passRateDelta).toEqual(second.passRateDelta);
    expect(first.direction).toBe("better");
    expect(first.alignedPairs).toBe(8);
    expect(first.warnings.some((warning) => warning.includes("成对样本"))).toBe(true);
  });

  it("blocks a regression when pass rate drops", () => {
    const baseline = {
      experimentId: "e1", totalRuns: 20, passed: 18, passRate: 90,
      costPerVerifiedCompletion: 0.1, p95LatencyMs: 1000,
      safetyBlockers: 0, unexpectedNondeterminism: 0,
      failedCaseIds: ["case-x"], manifestChangedComponents: []
    };
    const candidate = {
      ...baseline, experimentId: "e2", passed: 14, passRate: 70,
      failedCaseIds: ["case-y"]
    };
    const report = evaluateRegressionGate(baseline, candidate);
    expect(report.verdict).toBe("block");
    expect(report.blockers.map((item) => item.code)).toContain("regression.pass_rate");
    expect(report.blockers.map((item) => item.code)).toContain("regression.new_failures");
  });

  it("separates flaky cases from the blocking subset", () => {
    const cases = ["a", "b", "c"].map((id) => ({ caseKey: id, version: 1, schemaVersion: 2, lifecycle: "active", title: id, family: "operations", difficulty: "normal", runModes: ["offline"] } as unknown as CaseVersionSummary));
    const history = [
      { caseKey: "a", passed: true }, { caseKey: "a", passed: true }, { caseKey: "a", passed: true },
      { caseKey: "b", passed: true }, { caseKey: "b", passed: false }, { caseKey: "b", passed: true },
      { caseKey: "c", passed: false }, { caseKey: "c", passed: false }, { caseKey: "c", passed: false }
    ];
    const subset = selectStableSubset(cases, history);
    expect(subset.stable.map((item) => item.caseKey)).toEqual(["a", "c"]);
    expect(subset.flaky.map((item) => item.caseKey)).toEqual(["b"]);
  });

  it("keeps the regression gate default budgets explicit", () => {
    expect(DEFAULT_REGRESSION_GATE.maxPassRateDropPct).toBe(2);
    expect(DEFAULT_REGRESSION_GATE.requireNewFailuresFixed).toBe(true);
  });
});

describe("verification executor", () => {
  it("runs the shared units locally and never turns missing evidence into pass", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "work"), { recursive: true });
    writeFileSync(join(dir, "work", "report.md"), "关键结论：通过\n", "utf8");
    const spec: VerificationSpec = {
      schemaVersion: 1,
      id: "spec-local",
      mode: "eval",
      units: [
        { id: "exists", type: "file_exists", path: "work/report.md" },
        { id: "text", type: "text_contains", path: "work/report.md", contains: ["通过"] },
        { id: "missing", type: "file_exists", path: "work/none.md" }
      ],
      aggregate: { mode: "all" }
    };
    const result = await runVerificationSpec(spec, { workspaceRoot: dir, outDir: dir, now: () => new Date("2026-11-27T00:00:00.000Z") });
    expect(result.verdict).toBe("fail");
    expect(result.units.find((unit) => unit.id === "missing")?.status).toBe("fail");
  });

  it("keeps spec digests stable for the same spec", () => {
    const spec: VerificationSpec = { schemaVersion: 1, id: "s", mode: "eval", units: [{ id: "x", type: "human", prompt: "p" }], aggregate: { mode: "all" } };
    expect(digestOf(spec)).toBe(digestOf(JSON.parse(JSON.stringify(spec))));
  });
});
