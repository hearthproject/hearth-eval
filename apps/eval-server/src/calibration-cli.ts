import { calibrationReport } from "./calibration.ts";

try {
  process.stdout.write(`${JSON.stringify(calibrationReport(process.argv[2]), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
