import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { LocalJudge } from "./local-judge.ts";
import { ProviderStore } from "./provider-store.ts";
import { StorageSettings } from "./storage-settings.ts";
import { registerSystemSettingsRoutes } from "./system-settings-routes.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
function root() { const path = mkdtempSync(join(tmpdir(), "eval-settings-")); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path; }
const input = { providerName: "Judge", baseUrl: "https://judge.invalid/v1", model: "judge-one", apiKey: "secret-test-key" };
const request = { artifacts: { "answer.md": { text: "Evidence", bytes: 8 } }, criteria: [{ id: "quality", label: "Quality", rubric: "Evidence", points: 30 }], deterministic: [] };
const verdict = { criteria: [{ id: "quality", passed: true, confidence: 0.9, reason: "Evidence found", evidence: ["answer.md"] }], overallConfidence: 0.9 };
function makeJudge(path: string, response: unknown = verdict) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] })));
  const file = join(path, "judge.json");
  const judge = new LocalJudge(new ProviderStore({ file, fetchImpl }));
  return { judge, fetchImpl, file };
}

it("persists the independent judge, preserves blank keys, and uses edited model for real grading", async () => {
  const { judge, fetchImpl, file } = makeJudge(root());
  expect((await judge.modelSettings()).configured).toBe(false);
  await judge.saveModelSettings(input);
  const saved = await judge.saveModelSettings({ model: "judge-two", apiKey: "" });
  expect(saved.configured).toBe(true);
  expect(JSON.stringify(saved)).not.toContain(input.apiKey);
  const restored = new LocalJudge(new ProviderStore({ file, fetchImpl }));
  const result = await restored.judge(request);
  expect(result).toMatchObject({ model: "judge-two", criteria: verdict.criteria });
  expect(result.promptHash).toHaveLength(64);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://judge.invalid/v1/chat/completions");
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "judge-two" });
  expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${input.apiKey}` });
});

it("accepts echoed criterion metadata without retaining it as evaluation evidence", async () => {
  const { judge } = makeJudge(root(), { ...verdict, criteria: verdict.criteria.map(item => ({ ...item, label: "Quality", points: 30 })) });
  await judge.saveModelSettings(input);
  expect((await judge.judge(request)).criteria).toEqual(verdict.criteria);
});

it.each([
  { ...verdict, criteria: [] },
  { ...verdict, criteria: [verdict.criteria[0], verdict.criteria[0]] },
  { ...verdict, criteria: [{ ...verdict.criteria[0], id: "invented" }] },
  { ...verdict, overallConfidence: 2 }
])("rejects malformed, missing or fabricated judge results", async (response) => {
  const { judge } = makeJudge(root(), response);
  await judge.saveModelSettings(input);
  await expect(judge.judge(request)).rejects.toThrow();
});

it("does not claim connectivity for a 200 response without a model message", async () => {
  const judge = new LocalJudge(new ProviderStore({ file: join(root(), "judge.json"), fetchImpl: async () => new Response("{}") }));
  await expect(judge.testModelSettings(input)).resolves.toMatchObject({ ok: false });
  expect((await judge.modelSettings()).configured).toBe(false);
});

it("saves paths for next startup without moving live data and respects environment overrides", () => {
  const directory = root();
  const storage = new StorageSettings(directory);
  const dataDir = join(directory, "new-data");
  const artifactRoot = join(directory, "new-artifacts");
  mkdirSync(dataDir); mkdirSync(artifactRoot);
  const old = storage.effective({});
  mkdirSync(old.dataDir, { recursive: true });
  writeFileSync(join(old.dataDir, "eval.sqlite"), "existing-data");
  storage.save({ dataDir, artifactRoot });
  expect(new StorageSettings(directory).effective({})).toEqual({ dataDir, artifactRoot });
  expect(storage.effective({ HEARTH_EVAL_DATA_DIR: old.dataDir }).dataDir).toBe(old.dataDir);
  expect(readFileSync(join(old.dataDir, "eval.sqlite"), "utf8")).toBe("existing-data");
  expect(() => storage.save({ dataDir: "relative", artifactRoot })).toThrow();
  expect(() => storage.save({ dataDir: join(directory, "missing"), artifactRoot })).toThrow();
});

it("provides local directory selection, pending restart state and protected configuration routes", async () => {
  vi.stubEnv("HEARTH_EVAL_DATA_DIR", undefined); vi.stubEnv("HEARTH_EVAL_ARTIFACT_ROOT", undefined);
  const directory = root();
  const { judge } = makeJudge(directory);
  const app = Fastify(); cleanup.push(() => app.close());
  await registerSystemSettingsRoutes(app, { repoRoot: directory, current: { dataDir: directory, artifactRoot: directory }, modelClient: judge });
  const created = await app.inject({ method: "PUT", url: "/api/system/judge", payload: input });
  expect(created.statusCode).toBe(200); expect(created.body).not.toContain(input.apiKey);
  expect((await app.inject({ method: "POST", url: "/api/system/judge/test", payload: {} })).json().ok).toBe(true);
  const next = join(directory, "next"); mkdirSync(next);
  const listing = await app.inject(`/api/system/directories?path=${encodeURIComponent(directory)}`);
  expect(listing.json().directories).toContainEqual({ name: "next", path: next });
  const saved = await app.inject({ method: "PUT", url: "/api/system/storage", payload: { dataDir: next, artifactRoot: directory } });
  expect(saved.json()).toMatchObject({ restartRequired: true, current: { dataDir: directory }, next: { dataDir: next } });
  expect((await app.inject({ url: "/api/system/storage", remoteAddress: "10.0.0.1" })).statusCode).toBe(403);
  expect((await app.inject({ url: "/api/system/directories", headers: { origin: "https://untrusted.invalid" } })).statusCode).toBe(403);
  vi.stubEnv("HEARTH_EVAL_DATA_DIR", directory);
  expect((await app.inject({ method: "PUT", url: "/api/system/storage", payload: { dataDir: next, artifactRoot: directory } })).statusCode).toBe(400);
});
