export interface ImportedTask {
  title: string;
  prompt: string;
  input: string;
  expectedOutput: string;
  requiredText: string[];
}

export interface ImportedSubmission {
  agent: string;
  version: string;
  fileName: string;
  text: string;
  slot?: number;
  runId?: string;
  metadata?: {
    durationMs?: number | undefined;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    log?: string | undefined;
  };
}

export interface ImportedEvaluationInput extends ImportedTask {
  submissions: ImportedSubmission[];
}

export interface ImportedBatchInput extends ImportedTask {
  agents: Array<{ agent: string; version: string }>;
}

export interface CodexScoreRecord {
  id: number;
  createdAt: string;
  score: number;
  checks: Array<{ requiredText: string; passed: boolean; reason: string }>;
}

export interface CodexScoreHistory {
  records: CodexScoreRecord[];
  nextBefore: number | null;
}

export interface ImportedEvaluation extends ImportedEvaluationInput {
  id: string;
  createdAt: string;
  agents?: ImportedBatchInput["agents"];
  results: Array<{
    score: number;
    checks: Array<{ passed: boolean; reason: string; evidence: string[] }>;
  }>;
}
