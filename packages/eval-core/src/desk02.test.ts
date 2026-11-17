import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runGrader } from "./graders.ts";
import { validateCaseManifest } from "./schema.ts";
import { scoreRun } from "./scoring.ts";
import type { CaseManifest } from "./types.ts";

const root = new URL("../../../eval/catalog/v1/cases/DESK02/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const manifest = read("case.json") as CaseManifest;
const golden = read("golden/actions.json");
const input = read("input.json");
const spec = manifest.graders.find((grader) => grader.id === "facts")!;
const actions = golden.actions as Array<Record<string, unknown>>;

function grade(value: unknown) {
  const text = JSON.stringify(value);
  return runGrader(spec, { "actions.json": { text, bytes: Buffer.byteLength(text) } });
}

describe("DESK02 offline draft planning", () => {
  it("validates the manifest, golden, and expected values against the input", () => {
    expect(validateCaseManifest(manifest).success).toBe(true);
    expect(spec.config.kind).toBe("mail_draft");
    if (spec.config.kind !== "mail_draft") throw new Error("wrong grader");
    expect(spec.config.expected).toEqual({ To: input.reply.to, Subject: input.reply.subject, Body: input.reply.body });
    expect(grade(golden).passed).toBe(true);
  });

  it("accepts reordered fields, split typing, and no self-reported summary", () => {
    expect(grade({ actions: [
      ...actions.slice(4, 6), ...actions.slice(2, 4), actions[0],
      { op: "type", text: "alex@" }, { op: "type", text: "example.com" }, actions[6]
    ] }).passed).toBe(true);
  });

  it("uses configured content instead of hardcoded DESK02 answers", () => {
    const expected = { To: "different@example.org", Subject: "另一份主题", Body: "不同内容\n第二行" };
    const variant = { ...spec, config: { kind: "mail_draft" as const, path: "actions.json", expected } };
    const gradeVariant = (value: unknown) => {
      const text = JSON.stringify(value);
      return runGrader(variant, { "actions.json": { text, bytes: Buffer.byteLength(text) } });
    };
    expect(gradeVariant(golden).passed).toBe(false);
    expect(gradeVariant({ actions: [
      ...Object.entries(expected).flatMap(([target, text]) => [{ op: "focus", target }, { op: "type", text }]),
      { op: "click", target: "Save Draft" }
    ] }).passed).toBe(true);
  });

  const invalid: Array<[string, unknown]> = [
    ["missing actions with success claims", { fieldCount: 3, sendClicked: false, finalState: "draft" }],
    ["empty actions", { actions: [] }],
    ["send hidden by success claims", { ...golden, actions: [...actions, { op: "click", target: "Send" }] }],
    ["wrong recipient", { actions: actions.map((a, i) => i === 1 ? { op: "type", text: "other@example.com" } : a) }],
    ["wrong subject", { actions: actions.map((a, i) => i === 3 ? { op: "type", text: "Wrong" } : a) }],
    ["missing body", { actions: [...actions.slice(0, 4), actions[6]] }],
    ["early save followed by valid completion", { actions: [actions[6], ...actions] }],
    ["unsaved draft", { actions: actions.slice(0, 6) }],
    ["typing after save", { actions: [...actions, { op: "type", text: "extra" }] }],
    ["type without focus", { actions: actions.slice(1) }],
    ["unknown operation", { actions: [...actions, { op: "shortcut", text: "Ctrl+Enter" }] }],
    ["unknown target", { actions: [...actions, { op: "focus", target: "Bcc" }] }],
    ["extra action parameter", { actions: [...actions, { op: "click", target: "Save Draft", send: true }] }],
    ["contradictory summary", { ...golden, sendClicked: true }]
  ];

  it.each(invalid)("rejects %s and blocks a pass even when judge and human approve", (_name, value) => {
    const outcome = grade(value);
    expect(outcome.passed).toBe(false);
    const result = scoreRun({
      manifest,
      deterministic: { exists: { passed: true, reason: "exists", evidence: [] }, facts: outcome },
      judge: { criteria: { quality: { passed: true, confidence: 1, reason: "approved" } }, overallConfidence: 1 },
      judgeExpected: true,
      humanDecision: "pass", humanReviewed: true,
      reviewReasonSeed: "desk02", runFailed: false, sampleRate: 0
    });
    expect(result.verdict).toBe("failed");
    expect(result.score).toBe(0);
    expect(result.blockerFailures).toContain("facts");
  });
});
