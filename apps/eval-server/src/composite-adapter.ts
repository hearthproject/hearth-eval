import type { ArtifactMap, EvalTaskRequest, EvalTrace } from "@hearth/eval-core";
import type { AgentAdapter, AgentArtifactRequest, AgentTask, AgentTaskView } from "./agent-adapter.ts";

type NativeLike = AgentAdapter & { executorOptions?: () => Array<{ id: string }> };

/** Fold the Hearth adapter and the native adapter into one runner boundary. */
export class CompositeAgentAdapter implements AgentAdapter {
  readonly baseUrl: string;
  private readonly primary: AgentAdapter;
  private readonly native: AgentAdapter;

  constructor(options: { primary: AgentAdapter; native: AgentAdapter }) {
    this.primary = options.primary;
    this.native = options.native;
    this.baseUrl = options.primary.baseUrl;
  }

  createTask(body: EvalTaskRequest): Promise<{ task: AgentTask; created: boolean }> {
    // A case runs either against Hearth or against a local model config, never both.
    return this.route(body.executorId).createTask(body);
  }

  getTask(taskId: string): Promise<AgentTaskView> {
    return this.pickTask(taskId).getTask(taskId);
  }

  getArtifacts(request: AgentArtifactRequest): Promise<ArtifactMap> {
    return this.pickTask(request.taskId).getArtifacts(request);
  }

  getTrace(taskId: string): Promise<EvalTrace> {
    return this.pickTask(taskId).getTrace!(taskId);
  }

  cancelTask(taskId: string): Promise<Record<string, unknown>> {
    return this.pickTask(taskId).cancelTask(taskId);
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      ...(await this.primary.health()),
      executors: await this.executors()
    };
  }

  async executors(): Promise<Record<string, unknown>> {
    const hearth = await this.primary.executors?.().catch(() => null);
    const native = (await this.native.executors?.().catch(() => null)) ?? { executors: [] };
    const hearthList = Array.isArray(hearth?.executors) ? hearth.executors as Array<Record<string, unknown>> : [];
    const nativeList = Array.isArray(native.executors) ? native.executors as Array<Record<string, unknown>> : [];
    return { executors: [...hearthList, ...nativeList] };
  }

  private route(executorId: string | undefined): AgentAdapter {
    return executorId && this.nativeOwns(executorId) ? this.native : this.primary;
  }

  private pickTask(taskId: string): AgentAdapter {
    return this.nativeOwnsTask(taskId) ? this.native : this.primary;
  }

  private nativeIds(): Set<string> {
    const known = (this.native as NativeLike).executorOptions;
    return new Set((known?.call(this.native) ?? []).map((item) => item.id));
  }

  private nativeOwns(executorId: string): boolean {
    return this.nativeIds().has(executorId) || executorId.startsWith("llm-");
  }

  private nativeOwnsTask(taskId: string): boolean {
    return taskId.startsWith("native-");
  }
}

