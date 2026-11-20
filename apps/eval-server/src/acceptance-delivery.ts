import { createHash } from "node:crypto";
import { closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { AcceptanceJob } from "@hearth/eval-core";
import type { ExecutorArtifact } from "./acceptance-executor.ts";

/** Trusted delivery step: copies executor bytes unchanged; never constructs or repairs content. */
export function deliverArtifact(job: AcceptanceJob, artifact: ExecutorArtifact, previousHash: string | null, resumeHash: string | null) {
  if (dirname(job.targetPath) !== realpathSync(job.desktopRoot) || basename(job.targetPath) !== job.input.fileName) throw new Error("交付目标越界或桌面目录已变化");
  if (artifact.bytes.length > 256_000 || createHash("sha256").update(artifact.bytes).digest("hex") !== artifact.sha256) throw new Error("交付产物哈希或大小无效");
  let stat;
  try { stat = lstatSync(job.targetPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!stat) {
    const fd = openSync(job.targetPath, "wx");
    try { writeFileSync(fd, artifact.bytes); } finally { closeSync(fd); }
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(job.targetPath) !== job.targetPath || stat.size > 256_000) throw new Error("交付目标不是安全的普通文件");
  const fd = openSync(job.targetPath, "r+");
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || opened.size > 256_000) throw new Error("交付目标发生变化");
    const currentHash = createHash("sha256").update(readFileSync(fd)).digest("hex");
    if (resumeHash === artifact.sha256 && currentHash === resumeHash) return;
    if (!previousHash || currentHash !== previousHash) throw new Error("目标文件已被外部修改或新增，停止交付以避免覆盖");
    // Use the validated descriptor, avoiding a second pathname-based open/truncate.
    let offset = 0;
    while (offset < artifact.bytes.length) offset += writeSync(fd, artifact.bytes, offset, artifact.bytes.length - offset, offset);
    ftruncateSync(fd, artifact.bytes.length);
  } finally { closeSync(fd); }
}
