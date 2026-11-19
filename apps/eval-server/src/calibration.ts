import { readFileSync } from "node:fs";
import { runCalibration } from "@hearth/eval-core";

export function calibrationReport(path?: string) {
  const source = path ?? new URL("../../../eval/calibration/seed-v1.json", import.meta.url);
  return runCalibration(JSON.parse(readFileSync(source, "utf8")));
}
