import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseManifest, VerificationSpec } from "@hearth/eval-core";
import { compileCaseVerification, verifyCase } from "./verification-adapter.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-eval-verify-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows keeps the WAL file briefly locked.
    }
  }
});

function caseManifest(): CaseManifest {
  return {
    schemaVersion: 2,
    id: "case-v",
    version: 1,
    lifecycle: "active",
    title: "验证 Case",
    family: "operations",
    difficulty: "normal",
    runModes: ["offline"],
    description: "d",
    goal: "g",
    tags: [],
    timeoutMs: 60_000,
    inputs: [],
    expectedOutputs: ["report.md"],
    graders: [
      { id: "f", title: "file", config: { kind: "file", path: "report.md" } },
      { id: "t", title: "text", config: { kind: "text", path: "report.md", includes: ["通过"], excludes: ["失败"] } },
      { id: "j", title: "json", config: { kind: "json", path: "data.json", requiredPaths: ["/summary/total"] } },
      { id: "c", title: "csv", config: { kind: "csv", path: "table.csv", requiredColumns: ["id"], minRows: 1 } },
      { id: "tr", title: "trace", config: { kind: "trace", maxSteps: 3, minApprovals: 1 } }
    ],
    criteria: [
      { id: "f", label: "file", source: "deterministic", points: 1, severity: "blocker", layer: "result", metric: "task_success", graderId: "f" }
    ],
    humanReview: { prompt: "确认", sampleRate: 0 }
  };
}

describe("VerificationSpec adapter", () => {
  it("compiles file/text/json/csv/trace graders into shared units", () => {
    const spec = compileCaseVerification(caseManifest());
    const types = spec.units.map((unit) => unit.type);
    expect(types).toContain("file_exists");
    expect(types).toContain("text_contains");
    expect(types).toContain("json");
    expect(types).toContain("csv");
    expect(types).toContain("trace");
    // excludes must become a negative regex unit rather than being dropped.
    const excludes = spec.units.filter((unit) => unit.type === "text_contains" && unit.pattern?.startsWith("^(?!"));
    expect(excludes.length).toBe(1);
    expect(spec.aggregate).toEqual({ mode: "all" });
  });

  it("runs locally when no OS client is configured", async () => {
    const dir = tempDir();
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, "report.md"), "关键结论：通过\n", "utf8");
    writeFileSync(join(dir, "data.json"), JSON.stringify({ summary: { total: 42 } }), "utf8");
    writeFileSync(join(dir, "table.csv"), "id,name\n1,a\n", "utf8");
    const outcome = await verifyCase(caseManifest(), { workspaceRoot: dir });
    expect(outcome.source).toBe("local");
    expect(outcome.result.units.every((unit) => unit.id)).toBe(true);
    // Trace invariants cannot run locally without exchanges -> inconclusive,
    // never a silent pass.
    expect(outcome.result.units.find((unit) => unit.type === "trace")?.status).toBe("inconclusive");
  });

  it("prefers the OS executor when a client is available", async () => {
    const specResult = {
      schemaVersion: 1 as const,
      specId: "case:case-v@1",
      mode: "eval" as const,
      verdict: "pass" as const,
      aggregate: { mode: "all" as const },
      counts: { pass: 1, fail: 0, inconclusive: 0, skipped: 0, total: 1 },
      units: [{
        id: "file-1",
        type: "file_exists" as const,
        status: "pass" as const,
        reason: "ok",
        evidence: {},
        durationMs: 1,
        optional: false,
        at: "2026-11-27T00:00:00.000Z"
      }],
      missingArtifacts: [],
      startedAt: "2026-11-27T00:00:00.000Z",
      finishedAt: "2026-11-27T00:00:01.000Z",
      score: 1,
      success: true
    };
    const verify = vi.fn(async (_input: { spec: VerificationSpec }) => ({ result: specResult }));
    const outcome = await verifyCase(caseManifest(), { workspaceRoot: "/tmp/ws" }, { verify });
    expect(verify).toHaveBeenCalledOnce();
    const sent = (verify.mock.calls[0] as unknown as [{ spec: VerificationSpec }])[0];
    expect(sent.spec.id).toBe("case:case-v@1");
    expect(outcome.source).toBe("os");
    expect(outcome.unitVerdicts["file-1"]).toBe("pass");
  });
});
