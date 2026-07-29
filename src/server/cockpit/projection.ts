import type { CockpitJobProjection, CockpitJobRecord } from "./job-registry";

const ABSOLUTE_PATH =
  /(?:^|[^A-Za-z0-9._])(?:\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+)/g;
const SENSITIVE_ASSIGNMENT =
  /\b(?:password|passwd|secret|token|api[_-]?key|credential|authorization)\s*[:=]\s*[^\s,;]+/gi;

export function sanitizeCockpitText(value: string): string {
  return value
    .replace(ABSOLUTE_PATH, (match) => `${match[0] ?? ""}[redacted-path]`)
    .replace(SENSITIVE_ASSIGNMENT, "[redacted-credential]");
}

/**
 * Pure browser-safe projection. Trusted requester provenance and every
 * composition/executor detail remain server-internal.
 */
export function projectCockpitJob(record: CockpitJobRecord): CockpitJobProjection {
  return {
    jobId: record.jobId,
    ...(record.missionId ? { missionId: sanitizeCockpitText(record.missionId) } : {}),
    objective: sanitizeCockpitText(record.objective),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.requestKind ? { requestKind: record.requestKind } : {}),
    ...(record.missionState ? { missionState: sanitizeCockpitText(record.missionState) } : {}),
    ...(record.planLabel ? { planLabel: sanitizeCockpitText(record.planLabel) } : {}),
    tasks: record.tasks.map((task) => ({
      ...task,
      taskId: sanitizeCockpitText(task.taskId),
      label: sanitizeCockpitText(task.label),
    })),
    workers: record.workers.map(sanitizeCockpitText),
    blockers: record.blockers.map(sanitizeCockpitText),
    evidence: record.evidence.map(sanitizeCockpitText),
    ...(record.sanitizedError
      ? {
          sanitizedError: {
            code: sanitizeCockpitText(record.sanitizedError.code),
            message: sanitizeCockpitText(record.sanitizedError.message),
          },
        }
      : {}),
    ...(record.finalResult ? { finalResult: sanitizeCockpitText(record.finalResult) } : {}),
    // No canonical repository-evidence contract exists in PHASE 3.
    mergePerformed: false,
    productionDeploymentPerformed: false,
  };
}
