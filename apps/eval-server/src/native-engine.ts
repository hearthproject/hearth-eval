import type { ExperimentEnvironment, ExperimentRecord } from "@hearth/eval-core";

/** Marker stored in `environment` so experiment lists can tell native runs apart. */
export const NATIVE_ENGINE_MARKER = "native";

export function isNative(experiment: ExperimentRecord): boolean {
  return (experiment.environment as unknown as Record<string, unknown>).nativeEngine === NATIVE_ENGINE_MARKER;
}

export function markNativeEnvironment(environment: ExperimentEnvironment): ExperimentEnvironment {
  return { ...environment, nativeEngine: NATIVE_ENGINE_MARKER } as ExperimentEnvironment;
}
