import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  LLMProviderConfig,
  LLMProviderKind,
  NativeProviderInput,
  NativeProviderTestResult,
  NativeProviderView
} from "@hearth/eval-core";
import { createProviderAdapter, normalizeBaseUrl, ProviderError, type ChatProvider } from "./providers.ts";

export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

interface StoredProviders {
  version: 1;
  providers: LLMProviderConfig[];
}

/**
 * User-supplied model configurations, persisted as JSON (0600 where the
 * platform honors it) next to the eval database. Keys never leave this file.
 */
export class ProviderStore {
  private readonly file: string;
  private readonly timeoutMs: number;
  private readonly testTimeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private state: StoredProviders;

  constructor(options: { file: string; timeoutMs?: number; testTimeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.file = options.file;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.testTimeoutMs = options.testTimeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl;
    this.state = this.load();
  }

  list(): NativeProviderView[] {
    return this.state.providers.map(toView);
  }

  get(id: string): LLMProviderConfig | null {
    return this.state.providers.find((provider) => provider.id === id) ?? null;
  }

  save(input: NativeProviderInput): NativeProviderView {
    const kind: LLMProviderKind = input.kind;
    const baseUrl = normalizeBaseUrl(input.baseUrl?.trim() || DEFAULT_BASE_URL);
    if (!/^https?:\/\//i.test(baseUrl)) throw new ProviderError("PROVIDER_BAD_URL", "Base URL 必须以 http:// 或 https:// 开头");
    const model = input.model.trim();
    if (!model) throw new ProviderError("PROVIDER_BAD_MODEL", "模型名称不能为空");
    const existing = input.id ? this.get(input.id) : null;
    if (input.id && !existing) throw new ProviderError("PROVIDER_NOT_FOUND", `模型配置不存在：${input.id}`);
    const apiKey = input.clearApiKey ? "" : (input.apiKey?.trim() || existing?.apiKey || "");
    const config: LLMProviderConfig = {
      id: existing?.id ?? input.id ?? `llm-${randomUUID().slice(0, 8)}`,
      name: input.name.trim() || model,
      kind,
      baseUrl,
      model,
      apiKey,
      maxSteps: clampInt(input.maxSteps ?? existing?.maxSteps ?? 8, 1, 40),
      temperature: clampNumber(input.temperature ?? existing?.temperature ?? 0.2, 0, 2),
      toolArgumentFormat: input.toolArgumentFormat ?? existing?.toolArgumentFormat ?? "string",
      promptStyle: input.promptStyle ?? existing?.promptStyle ?? "chatml"
    };
    const index = this.state.providers.findIndex((provider) => provider.id === config.id);
    if (index >= 0) this.state.providers[index] = config;
    else this.state.providers.push(config);
    this.persist();
    return toView(config);
  }

  remove(id: string): boolean {
    const before = this.state.providers.length;
    this.state.providers = this.state.providers.filter((provider) => provider.id !== id);
    if (this.state.providers.length === before) return false;
    this.persist();
    return true;
  }

  /** Resolve config plus a ready adapter; throws a user-facing ProviderError when unusable. */
  resolve(id: string, overrides: { maxSteps?: number; temperature?: number; model?: string } = {}): {
    config: LLMProviderConfig;
    provider: ChatProvider;
  } {
    const stored = this.get(id);
    if (!stored) throw new ProviderError("PROVIDER_NOT_FOUND", `模型配置不存在：${id}`);
    if (!stored.apiKey) throw new ProviderError("PROVIDER_NO_KEY", `模型配置「${stored.name}」缺少 API Key`);
    const config: LLMProviderConfig = {
      ...stored,
      model: overrides.model?.trim() || stored.model,
      ...(overrides.maxSteps !== undefined ? { maxSteps: overrides.maxSteps } : {}),
      ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {})
    };
    return { config, provider: createProviderAdapter(config, this.adapterOptions()) };
  }

  async test(input: NativeProviderInput): Promise<NativeProviderTestResult> {
    let config: LLMProviderConfig;
    if (input.id && !input.apiKey) {
      const stored = this.get(input.id);
      if (!stored) throw new ProviderError("PROVIDER_NOT_FOUND", `模型配置不存在：${input.id}`);
      config = { ...stored, model: input.model.trim() || stored.model, baseUrl: normalizeBaseUrl(input.baseUrl?.trim() || stored.baseUrl) };
    } else {
      const apiKey = input.apiKey?.trim() ?? "";
      if (!apiKey) throw new ProviderError("PROVIDER_NO_KEY", "请先填写 API Key");
      config = {
        id: input.id ?? "draft",
        name: input.name,
        kind: input.kind,
        baseUrl: normalizeBaseUrl(input.baseUrl?.trim() || DEFAULT_BASE_URL),
        apiKey,
        model: input.model.trim()
      };
    }
    const provider = createProviderAdapter(config, { timeoutMs: this.testTimeoutMs, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
    return provider.testConnection();
  }

  private adapterOptions(): { timeoutMs: number; fetchImpl?: typeof fetch } {
    return { timeoutMs: this.timeoutMs, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) };
  }

  private load(): StoredProviders {
    if (!existsSync(this.file)) return { version: 1, providers: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoredProviders;
      return { version: 1, providers: Array.isArray(parsed.providers) ? parsed.providers : [] };
    } catch {
      return { version: 1, providers: [] };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

export function maskKey(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`;
}

export function toView(config: LLMProviderConfig): NativeProviderView {
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyHint: maskKey(config.apiKey),
    maxSteps: config.maxSteps ?? 8,
    temperature: config.temperature ?? null,
    toolArgumentFormat: config.toolArgumentFormat ?? "string",
    promptStyle: config.promptStyle ?? "chatml"
  };
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) return min;
  return Math.min(max, Math.max(min, rounded));
}

function clampNumber(value: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}
