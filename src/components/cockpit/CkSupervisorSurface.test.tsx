import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CockpitUiState } from "./CkCockpitApp";
import type { CockpitJobProjection, CockpitJobStatus } from "@/features/cockpit/clients";

import { CkSupervisorSurface } from "./CkSupervisorSurface";

function snapshot(
  status: CockpitJobStatus,
  overrides: Partial<CockpitJobProjection> = {},
): CockpitJobProjection {
  return {
    jobId: "cockpit-job-safe",
    missionId: "mission-safe",
    objective: "Objectif de supervision",
    status,
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:01.000Z",
    missionState: "IN_PROGRESS",
    planLabel: "Plan contrôlé",
    tasks: [
      { taskId: "task-a", label: "Tâche source", status: "SUCCEEDED" },
      { taskId: "task-b", label: "Tâche active", status: "RUNNING" },
    ],
    workers: ["Worker local A", "Worker local B"],
    blockers: ["Blocage de revue"],
    evidence: [],
    mergePerformed: false,
    productionDeploymentPerformed: false,
    ...overrides,
  };
}

function renderSurface(
  status: CockpitJobStatus,
  uiState: CockpitUiState,
  overrides: Partial<CockpitJobProjection> = {},
  error?: string,
) {
  return renderToStaticMarkup(
    <CkSupervisorSurface
      snapshot={snapshot(status, overrides)}
      uiState={uiState}
      error={error}
      onSubmitObjective={() => {}}
      onRetry={() => {}}
    />,
  );
}

describe("CkSupervisorSurface real projection", () => {
  it.each([
    ["QUEUED", "polling", "En file d’attente"],
    ["RUNNING", "polling", "En cours"],
    ["SUCCEEDED", "succeeded", "Mission réussie"],
    ["BLOCKED", "blocked", "Mission bloquée"],
    ["FAILED", "failed", "Mission échouée"],
  ] as const)("renders %s distinctly", (status, uiState, label) => {
    const html = renderSurface(status, uiState);

    expect(html).toContain(label);
    expect(html).toContain(`ck-job-${status.toLowerCase()}`);
    if (status === "BLOCKED" || status === "FAILED") {
      expect(html).not.toContain("Mission réussie");
    }
  });

  it("renders Mission state, plan, tasks, workers and blockers", () => {
    const html = renderSurface("RUNNING", "polling");

    expect(html).toContain("État Mission");
    expect(html).toContain("IN_PROGRESS");
    expect(html).toContain("Plan contrôlé");
    expect(html).toContain("Tâche source");
    expect(html).toContain("Tâche active");
    expect(html).toContain("Worker local A");
    expect(html).toContain("Worker local B");
    expect(html).toContain("Blocage de revue");
  });

  it("renders sanitized failure and terminal final results", () => {
    const html = renderSurface("FAILED", "failed", {
      sanitizedError: { code: "execution_failed", message: "Échec assaini" },
      finalResult: "Résultat terminal assaini",
    });

    expect(html).toContain("execution_failed");
    expect(html).toContain("Échec assaini");
    expect(html).toContain("Résultat terminal assaini");
    expect(html).toContain('role="alert"');
  });

  it("reports merge and deployment flags honestly", () => {
    const neither = renderSurface("SUCCEEDED", "succeeded");
    const both = renderSurface("SUCCEEDED", "succeeded", {
      mergePerformed: true,
      productionDeploymentPerformed: true,
    });

    expect(neither).toContain("merge non effectué");
    expect(neither).toContain("déploiement production non effectué");
    expect(both).toContain("merge effectué");
    expect(both).toContain("déploiement production effectué");
  });

  it("does not render projection-foreign unsafe fields or unused evidence", () => {
    const unsafe = {
      ...snapshot("RUNNING", { evidence: ["/Users/operator/private"] }),
      tenantId: "tenant-secret",
      requester: "requester-secret",
      executor: "executor-secret",
      credentials: "credential-secret",
      command: "rm unsafe-command",
      stack: "private-stack",
      repositoryPath: "/Users/operator/repository",
      approval: { approved: true },
      executionGrant: { authority: "widened" },
    } as CockpitJobProjection;
    const html = renderToStaticMarkup(
      <CkSupervisorSurface
        snapshot={unsafe}
        uiState="polling"
        onSubmitObjective={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(html).not.toMatch(
      /tenant-secret|requester-secret|executor-secret|credential-secret|unsafe-command|private-stack|Users\/operator|approved|widened/,
    );
  });

  it("announces status and network errors without adding execution controls", () => {
    const html = renderSurface(
      "RUNNING",
      "network-error",
      {},
      "Lecture réseau impossible",
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Lecture réseau impossible");
    expect(html).toContain("Réessayer la lecture");
    expect(html).not.toContain(">Annuler<");
    expect(html).not.toContain(">Approuver<");
    expect(html).not.toContain(">Fusionner<");
    expect(html).not.toContain(">Déployer<");
  });
});
