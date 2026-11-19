export type DiagnosisStatus = "running" | "waiting_approval" | "waiting_rerun" | "completed" | "stopped" | "error";
export type DiagnosisCause = "agent_regression" | "environment" | "grader" | "unknown";
export interface DiagnosisReport {
  summary: string;
  findings: Array<{ cause: DiagnosisCause; claim: string; evidenceIds: string[] }>;
  revision: string;
  limitations: string[];
}
export interface DiagnosisEvidence {
  id: string; tool: string; target: string; path: string; reason: string; at: string; data: string; error: boolean;
}
export interface DiagnosisJob {
  id: string; experimentId: string; status: DiagnosisStatus; createdAt: string; updatedAt: string;
  steps: number; maxSteps: number; rerunBudget: number; rerunsUsed: number;
  pendingRunId: string | null; rerunExperimentId: string | null;
  evidence: DiagnosisEvidence[]; report: DiagnosisReport | null; error: string | null;
}
