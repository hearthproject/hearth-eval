import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface StoragePaths { dataDir: string; artifactRoot: string }

export class StorageSettings {
  readonly file: string;
  constructor(readonly repoRoot: string) {
    this.file = join(repoRoot, ".hearth", "storage-settings.json");
  }

  read(): Partial<StoragePaths> {
    if (!existsSync(this.file)) return {};
    const value = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoragePaths>;
    for (const path of [value.dataDir, value.artifactRoot]) {
      if (path !== undefined && (typeof path !== "string" || !isAbsolute(path))) throw new Error("存储配置必须使用绝对目录");
    }
    return value;
  }

  effective(env: NodeJS.ProcessEnv = process.env): StoragePaths {
    const saved = this.read();
    return {
      dataDir: resolve(env.HEARTH_EVAL_DATA_DIR ?? saved.dataDir ?? join(this.repoRoot, ".hearth", "eval")),
      artifactRoot: resolve(env.HEARTH_EVAL_ARTIFACT_ROOT ?? saved.artifactRoot ?? join(this.repoRoot, ".hearth", "eval-artifacts"))
    };
  }

  save(paths: StoragePaths): void {
    for (const path of [paths.dataDir, paths.artifactRoot]) {
      if (!isAbsolute(path) || path.includes("\0")) throw new Error("请选择绝对目录");
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`目录不存在：${path}`);
      accessSync(path, constants.R_OK | constants.W_OK);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ dataDir: resolve(paths.dataDir), artifactRoot: resolve(paths.artifactRoot) }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
