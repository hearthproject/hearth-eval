import type { ArtifactMap, JudgeRequest, JudgeResponse } from "@hearth/eval-core";

export interface ArtifactJudgeRequest extends Omit<JudgeRequest, "taskId"> {
  artifacts: ArtifactMap;
  /** Optional source identifier for judges backed by a task-based API. */
  taskId?: string;
}

export interface JudgeAdapter {
  judge(request: ArtifactJudgeRequest): Promise<JudgeResponse>;
}

/** Compatibility adapter for Hearth's API, which reads its own registered artifacts. */
export class HearthJudgeAdapter implements JudgeAdapter {
  constructor(private readonly client: { judge(request: JudgeRequest): Promise<JudgeResponse> }) {}

  judge(request: ArtifactJudgeRequest): Promise<JudgeResponse> {
    if (!request.taskId) throw new Error("Hearth 裁判需要已登记的任务 ID");
    return this.client.judge({
      taskId: request.taskId,
      criteria: request.criteria,
      deterministic: request.deterministic,
      ...(request.locale ? { locale: request.locale } : {})
    });
  }
}
