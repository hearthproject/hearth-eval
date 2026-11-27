// Eval adapter for the shared VerificationSpec.
//
// The spec language and unit executor live in `@hearth/eval-core` as a
// versioned mirror of the OS canonical implementation. When an OS endpoint is
// configured, the same spec is executed by the OS executor and the returned
// unit results are authoritative; the local executor is only a deterministic
// fallback for offline experiment runs.
import type { CaseManifest, VerificationResult, VerificationSpec, VerificationUnit } from "@hearth/eval-core";
import { runVerificationSpec, specDigest } from "@hearth/eval-core";
import type { ArtifactMap } from "@hearth/eval-core";

function unitId(prefix: string, index: number, suffix = ""): string {
  return `${prefix}-${index + 1}${suffix ? `-${suffix}` : ""}`;
}

/** Compile deterministic case graders into the shared verification language. */
export function compileCaseVerification(manifest: CaseManifest): VerificationSpec {
  const units: VerificationUnit[] = [];
  for (const [index, grader] of manifest.graders.entries()) {
    const config = grader.config;
    if (config.kind === "file") {
      units.push({ id: unitId("file", index), type: "file_exists", path: config.path, ...(config.minBytes ? { minBytes: config.minBytes } : {}) });
    } else if (config.kind === "text") {
      units.push({
        id: unitId("text", index),
        type: "text_contains",
        path: config.path,
        ...(config.includes ? { contains: config.includes } : {}),
        ...(config.regex && config.regex.length > 0 ? { pattern: config.regex.join("|") } : {})
      });
      for (const [excludeIndex, exclude] of (config.excludes ?? []).entries()) {
        const escaped = exclude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        units.push({
          id: `${unitId("text-exclude", index)}-${excludeIndex + 1}`,
          type: "text_contains",
          path: config.path,
          pattern: `^(?!.*(?:${escaped}))[\\s\\S]*$`
        });
      }
    } else if (config.kind === "json") {
      for (const pointer of config.requiredPaths ?? []) {
        units.push({ id: `${unitId("json", index)}-${pointer.replace(/[^a-z0-9]+/gi, "_")}`, type: "json", path: config.path, pointer, requiredKeys: [] });
      }
      for (const [pointer, value] of Object.entries(config.equals ?? {})) {
        units.push({ id: `${unitId("json-eq", index)}-${pointer.replace(/[^a-z0-9]+/gi, "_")}`, type: "json", path: config.path, pointer, equals: value });
      }
      for (const [pointer, length] of Object.entries(config.minArrayLength ?? {})) {
        units.push({ id: `${unitId("json-len", index)}-${pointer.replace(/[^a-z0-9]+/gi, "_")}`, type: "json", path: config.path, pointer, minArrayLength: length });
      }
    } else if (config.kind === "csv") {
      units.push({
        id: unitId("csv", index),
        type: "csv",
        path: config.path,
        ...(config.requiredColumns ? { columns: config.requiredColumns } : {}),
        ...(config.minRows !== undefined ? { minRows: config.minRows } : {})
      });
    } else if (config.kind === "state") {
      units.push({ id: unitId("state", index), type: "json", path: config.path, requiredKeys: Object.keys(config.expected) });
    } else if (config.kind === "mail_draft") {
      units.push({
        id: unitId("mail", index),
        type: "text_contains",
        path: config.path,
        contains: [config.expected.Subject, config.expected.To]
      });
    } else if (config.kind === "trace") {
      if (config.maxSteps !== undefined) {
        units.push({ id: `${unitId("trace-steps", index)}`, type: "trace", invariant: "max_model_requests", limit: config.maxSteps });
      }
      if (config.minApprovals !== undefined) {
        units.push({ id: `${unitId("trace-approval", index)}`, type: "trace", invariant: "approval_before_effect", value: "require" });
      }
      if (config.maxEffects !== undefined) {
        units.push({ id: `${unitId("trace-effects", index)}`, type: "trace", invariant: "no_unapproved_side_effect", limit: config.maxEffects });
      }
    } else if (config.kind === "artifact_count") {
      // Count checks stay a local metric; expected outputs are verified as files.
      for (const path of manifest.expectedOutputs) {
        units.push({ id: `${unitId("artifact", index)}-${path.replace(/[^a-z0-9]+/gi, "_")}`, type: "file_exists", path });
      }
    }
  }
  if (units.length === 0) {
    units.push({ id: "no-evidence", type: "human", prompt: "该 Case 没有确定性验证单元，需要人工确认" });
  }
  return {
    schemaVersion: 1,
    id: `case:${manifest.id}@${manifest.version}`,
    title: manifest.title,
    mode: "eval",
    units,
    aggregate: { mode: "all" }
  };
}

export interface EvalVerificationContext {
  workspaceRoot: string;
  outDir?: string;
  artifacts?: ArtifactMap;
}

export interface EvalVerificationOutcome {
  specDigest: string;
  source: "os" | "local";
  result: VerificationResult;
  /** Unit-level agreement token for production-vs-eval comparisons. */
  unitVerdicts: Record<string, string>;
}

export interface OsVerificationClient {
  verify(input: { spec: VerificationSpec; workspaceRoot?: string; taskId?: string | null; runId?: string | null }): Promise<{ result: VerificationResult }>;
}

export async function verifyCase(
  manifest: CaseManifest,
  context: EvalVerificationContext,
  client?: OsVerificationClient | null
): Promise<EvalVerificationOutcome> {
  const spec = compileCaseVerification(manifest);
  if (client) {
    const response = await client.verify({ spec, workspaceRoot: context.workspaceRoot });
    return {
      specDigest: specDigest(spec),
      source: "os",
      result: response.result,
      unitVerdicts: Object.fromEntries(response.result.units.map((unit) => [unit.id, unit.status]))
    };
  }
  const artifacts = context.artifacts
    ? Object.entries(context.artifacts).map(([relativePath, value]) => ({
      relativePath,
      absolutePath: `${context.workspaceRoot}/${relativePath}`,
      sha256: "",
      bytes: value.bytes,
      mimeType: value.mimeType ?? "application/octet-stream"
    }))
    : [];
  const result = await runVerificationSpec(spec, {
    workspaceRoot: context.workspaceRoot,
    outDir: context.outDir ?? context.workspaceRoot,
    artifacts,
    now: () => new Date()
  });
  return {
    specDigest: specDigest(spec),
    source: "local",
    result,
    unitVerdicts: Object.fromEntries(result.units.map((unit) => [unit.id, unit.status]))
  };
}
