import { describe, expect, it } from "vitest";
import { parseBenchmarkCliArgs } from "./benchmark-import-cli.ts";

describe("benchmark import CLI", () => {
  it("parses job, metadata, pricing, and flags", () => {
    const options = parseBenchmarkCliArgs([
      "--job", "harbor-job-mini",
      "--dataset", "terminal-bench/terminal-bench-2-1",
      "--version", "2.1",
      "--harness", "hearth-native",
      "--harness-version", "0.1.0",
      "--model", "test-model",
      "--jobs-root", "./harbor-jobs",
      "--db", "./tmp/eval.sqlite",
      "--pricing-input", "3",
      "--pricing-output", "15",
      "--pricing-cached", "0.3",
      "--dry-run",
      "--json"
    ]);
    expect(options.job).toBe("harbor-job-mini");
    expect(options.datasetName).toBe("terminal-bench/terminal-bench-2-1");
    expect(options.datasetVersion).toBe("2.1");
    expect(options.pricing).toEqual({
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      cachedPerMillionUsd: 0.3
    });
    expect(options.dryRun).toBe(true);
    expect(options.json).toBe(true);
  });

  it("allows help without a job", () => {
    const options = parseBenchmarkCliArgs(["--help"]);
    expect(options.help).toBe(true);
    expect(options.job).toBeNull();
  });

  it("rejects incomplete pricing and unknown flags", () => {
    expect(() => parseBenchmarkCliArgs(["--job", "job", "--pricing-cached", "1"])).toThrow("requires --pricing-input");
    expect(() => parseBenchmarkCliArgs(["--unknown"])).toThrow();
  });
});
