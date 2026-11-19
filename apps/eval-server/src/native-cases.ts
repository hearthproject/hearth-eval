import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface NativeCaseInput {
  kind: "file" | "url";
  label: string;
  value: string;
}

/**
 * Copy a case's input files into `<workspace>/inputs/` and rewrite the request
 * into workspace-relative paths, so the native agent only ever touches its own
 * output directory. Files already inside the workspace are left alone.
 */
export function resolveNativeCase(
  repoRoot: string,
  caseId: string | null,
  inputs: Array<{ kind: "file" | "url"; label: string; value: string }>,
  outputDir: string
): { inputs: NativeCaseInput[] } {
  const workspace = resolve(repoRoot, outputDir);
  const caseDir = caseId && /^[A-Za-z0-9_-]+$/.test(caseId)
    ? join(repoRoot, "eval", "catalog", "v2", "cases", caseId)
    : null;
  const copied = new Set<string>();
  const resolved = inputs.map((input): NativeCaseInput => {
    if (input.kind === "url") return input;
    const absolute = isAbsolutePath(input.value)
      ? resolve(input.value)
      : resolve(caseDir ?? workspace, input.value);
    if (isPathInside(workspace, absolute)) {
      return { kind: "file", label: input.label, value: toWorkspaceRelative(workspace, absolute) };
    }
    if (!existsSync(absolute)) return input;
    if (statSync(absolute).isDirectory()) {
      const relativeDir = `inputs/${baseName(absolute)}`;
      if (!copied.has(`${relativeDir}/`)) {
        copyTree(absolute, join(workspace, relativeDir));
        copied.add(`${relativeDir}/`);
      }
      return { kind: "file", label: input.label, value: relativeDir };
    }
    if (!statSync(absolute).isFile()) return input;
    const relative = `inputs/${baseName(absolute)}`;
    if (!copied.has(relative)) {
      mkdirSync(join(workspace, "inputs"), { recursive: true });
      copyFileSync(absolute, join(workspace, relative));
      copied.add(relative);
    }
    return { kind: "file", label: input.label, value: relative };
  });
  return { inputs: resolved };
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile() && statSync(from).size <= 2 * 1024 * 1024) copyFileSync(from, to);
  }
}

function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(value);
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "input";
}

function toWorkspaceRelative(workspace: string, absolute: string): string {
  return resolve(absolute).slice(resolve(workspace).length + 1).replace(/\\/g, "/");
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, "");
  const normalized = resolve(candidate);
  return normalized === normalizedRoot
    || normalized.startsWith(`${normalizedRoot}\\`)
    || normalized.startsWith(`${normalizedRoot}/`);
}
