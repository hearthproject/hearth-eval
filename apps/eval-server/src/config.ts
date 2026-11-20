import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { StorageSettings } from "./storage-settings.ts";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const HOST = process.env.HEARTH_EVAL_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.HEARTH_EVAL_PORT ?? 4318);
export const HEARTH_URL = (process.env.HEARTH_URL ?? "http://127.0.0.1:4317").replace(/\/+$/, "");
export const HEARTH_TIMEOUT_MS = Math.max(1_000, Number(process.env.HEARTH_EVAL_HEARTH_TIMEOUT_MS ?? 120_000));
const storage = new StorageSettings(REPO_ROOT).effective();
export const DATA_DIR = storage.dataDir;
export const DB_PATH = join(DATA_DIR, "eval.sqlite");
export const ARTIFACT_ROOT = storage.artifactRoot;
export const CASES_DIR = resolve(process.env.HEARTH_EVAL_CASES_DIR ?? join(REPO_ROOT, "eval", "catalog", "v2", "cases"));
export const WEB_DIST = join(REPO_ROOT, "apps", "eval-web", "dist");
export const EVAL_VERSION = "0.1.0";
export const RECOVERY_STALE_MS = Math.max(0, Number(process.env.HEARTH_EVAL_RECOVERY_STALE_MS ?? 30 * 60_000));
