import { describe, expect, it, vi } from "vitest";
import {
  POLICY_CORPUS,
  comparePolicyPreflights,
  evaluateCorpusWithPreflight,
  runPolicyCorpus,
  type PolicyPreflightClient,
  type PolicySpecLike
} from "./policy-corpus.ts";

function clientFor(decisions: Record<string, string>): PolicyPreflightClient {
  return {
    preflight: vi.fn(async (input: { actions: Array<Record<string, unknown>> }) => {
      const action = input.actions[0] ?? {};
      const tool = String(action.tool ?? "unknown");
      const path = Array.isArray(action.paths) ? String(action.paths[0] ?? "") : "";
      const key = `${tool}:${path}`;
      const decision = decisions[key] ?? decisions[tool] ?? "ask";
      return {
        actions: [{ result: { effectiveDecision: decision, reason: `fake:${key}` } }]
      };
    })
  };
}

describe("policy corpus", () => {
  it("ships attack cases across paths, domains, tools, secrets and effects", () => {
    expect(POLICY_CORPUS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(POLICY_CORPUS.map((item) => item.layer))).toEqual(new Set([
      "path_traversal",
      "domain_confusion",
      "tool_allowlist",
      "secrets",
      "effects",
      "idempotency"
    ]));
  });

  it("reports a blocker when a denied action is allowed", async () => {
    const client = clientFor({
      "read_file:C:/Users/me/.ssh/id_rsa": "allow",
      "write_file:work/report.md": "allow",
      "http_get:api.example.com": "allow",
      "http_get:evil-example.com": "deny",
      "http_get:api.example.com@evil.test": "deny",
      "shell:": "deny",
      "pay:": "ask",
      "delete_file:C:/Temp/report.md": "ask",
      "read_file:work/certs/server.pem": "deny",
      "write_file:C:/Windows/System32/config/SAM": "ask",
      "write_file:work/../../etc/passwd": "ask",
      "http_get:v1.example.com": "allow",
      "write_file:work/out.md": "allow"
    });
    const report = await runPolicyCorpus(client, "task-1");
    expect(report.total).toBe(POLICY_CORPUS.length);
    expect(report.safetyBlockers).toBeGreaterThan(0);
    expect(report.findings.find((item) => item.caseId === "secret-ssh")?.blocked).toBe(true);
  });

  it("turns unavailable OS decisions into an explicit unavailable count", () => {
    const report = evaluateCorpusWithPreflight([
      { caseId: "a", expected: "deny", actual: null, reason: "OS down" },
      { caseId: "b", expected: "deny", actual: "deny", reason: "ok" }
    ]);
    expect(report.unavailable).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(1);
  });

  it("compares two policies on the same actions", async () => {
    const left: PolicySpecLike = {
      schemaVersion: 1, id: "left", version: "1", mode: "enforce",
      defaults: { decision: "ask" },
      rules: [],
      approval: { mode: "necessary", teamMode: "shared", recoveryPolicy: "manual", retryPolicy: "none" }
    };
    const right: PolicySpecLike = { ...left, id: "right" };
    const client = clientFor({ "write_file:work/a.md": "allow", "read_file:work/a.md": "deny" });
    const comparison = await comparePolicyPreflights(client, "task-1", left, right, [
      { tool: "write_file", paths: ["work/a.md"] },
      { tool: "read_file", paths: ["work/a.md"] }
    ]);
    expect(comparison.actions).toBe(2);
    expect(comparison.delta).toEqual({ allow: 0, ask: 0, deny: 0 });
    expect(comparison.changed).toEqual([]);
  });
});
