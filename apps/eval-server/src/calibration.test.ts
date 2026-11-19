import { expect, it } from "vitest";
import { calibrationReport } from "./calibration.ts";

it("exposes known text false positives and false negatives instead of hiding them", () => {
  const report = calibrationReport();
  expect(report.labelStatus).toBe("seed_unreviewed");
  expect(report.summary.total).toBe(18);
  expect(report.groups.find(g => g.id === "legacy-text")).toMatchObject({ falsePass: 1, falseFail: 1, falsePassRate: 50, falseFailRate: 50 });
  for (const group of report.groups.filter(g => g.id !== "legacy-text")) {
    expect(group).toMatchObject({ falsePass: 0, falseFail: 0, graderError: 0, coverage: 100 });
  }
});
