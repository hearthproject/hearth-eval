export interface AcceptanceInput {
  requestId: string;
  fileName: string;
  title: string;
  requiredText: string[];
  maxRepairs: number;
  memoryKey?: string | undefined;
  memoryRevision?: number | undefined;
  semanticRequirements?: string | undefined;
}
export interface SharedMemory { key: string; revision: number; content: string; sha256: string; updatedAt: string; source: "user" }
export interface ContextSnapshot extends SharedMemory { capturedAt: string }
export interface AcceptanceMemoryView {
  memory: SharedMemory | null;
  outcomes: Array<{ jobId: string; status: AcceptanceStatus; snapshotHash: string; revision: number; fileName: string; artifactHash: string | null; updatedAt: string; failures: string[] }>;
}
export interface AcceptanceSemanticReview {
  checkedAt: string; snapshotHash: string; artifactHash: string;
  model: string; promptHash: string; passed: boolean;
  criteria: Array<{ id: string; passed: boolean; confidence: number; reason: string; evidence: string[] }>;
}
export type AcceptanceStatus = "running" | "waiting_approval" | "waiting_input" | "passed" | "failed" | "error" | "stopped" | "interrupted";
export interface AcceptanceCheck { id: string; passed: boolean; reason: string }
export interface AcceptanceEvidence {
  checkedAt: string;
  targetPath: string;
  sha256: string | null;
  bytes: number | null;
  checks: AcceptanceCheck[];
  passed: boolean;
  safeToRepair: boolean;
}
export interface AcceptanceAttempt {
  number: number;
  taskId: string | null;
  taskStatus: string;
  startedAt: string;
  finishedAt: string | null;
  feedback: string | null;
  delivery?: { artifactId: string; sha256: string; bytes: number; deliveredAt: string | null };
  evidence: AcceptanceEvidence | null;
  semantic?: AcceptanceSemanticReview;
}
export interface AcceptanceJob {
  id: string;
  input: AcceptanceInput;
  targetPath: string;
  desktopRoot: string;
  executor: "hearth";
  executorUrl: string;
  status: AcceptanceStatus;
  createdAt: string;
  updatedAt: string;
  attempts: AcceptanceAttempt[];
  error: string | null;
  contextSnapshot?: ContextSnapshot;
}
export interface AcceptanceDefaults { desktopRoot: string; fileName: string; title: string; requiredText: string[]; hearthUrl: string }
