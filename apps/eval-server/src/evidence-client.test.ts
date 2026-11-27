import { describe, expect, it, vi } from "vitest";
import { EvidenceClient, EvidenceClientError } from "./evidence-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("EvidenceClient", () => {
  it("calls versioned OS endpoints and never the database", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("/manifest")) {
        return jsonResponse({ manifest: { runId: "run-1", compatibilityFingerprint: "f" }, fingerprintValid: true });
      }
      if (String(url).includes("/api/cost/tasks/")) {
        return jsonResponse({ taskId: "task-1", entries: [], statuses: [] });
      }
      return jsonResponse({ ok: true });
    });
    const client = new EvidenceClient({ baseUrl: "http://127.0.0.1:4317/", fetchImpl: fetchImpl as typeof fetch });
    const manifest = await client.manifest("run-1");
    const cost = await client.cost("task-1");
    expect(manifest.runId).toBe("run-1");
    expect(cost.taskId).toBe("task-1");
    expect(calls).toEqual([
      "http://127.0.0.1:4317/api/evidence/runs/run-1/manifest",
      "http://127.0.0.1:4317/api/cost/tasks/task-1"
    ]);
  });

  it("surfaces the OS status and message instead of swallowing it", async () => {
    const fetchImpl = vi.fn(async () => new Response("{\"error\":\"REPORT_NOT_FOUND\"}", { status: 404 }));
    const client = new EvidenceClient({ baseUrl: "http://os", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.replayReport("missing")).rejects.toMatchObject({ status: 404 });
    await expect(client.replayReport("missing")).rejects.toBeInstanceOf(EvidenceClientError);
  });

  it("posts replay and fork bodies unchanged", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({ report: { id: "r" }, runId: "run-2" });
    });
    const client = new EvidenceClient({ baseUrl: "http://os", fetchImpl: fetchImpl as typeof fetch });
    await client.replay({ cassetteId: "cassette:run-1", mode: "strict_replay", replacement: { exchangeId: "e", output: { x: 1 } } });
    await client.fork({ runId: "run-1", checkpointSeq: 2, label: "lab" });
    expect(bodies[0]).toEqual({ cassetteId: "cassette:run-1", mode: "strict_replay", replacement: { exchangeId: "e", output: { x: 1 } } });
    expect(bodies[1]).toEqual({ runId: "run-1", checkpointSeq: 2, label: "lab" });
  });
});
