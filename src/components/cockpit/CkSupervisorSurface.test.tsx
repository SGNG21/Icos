import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CapabilityViewSnapshot, CockpitSupervisorSnapshot } from "@/features/cockpit/clients";

import { CkSupervisorSurface } from "./CkSupervisorSurface";

const snapshot: CockpitSupervisorSnapshot = {
  missionId: "mission-test",
  objective: "Objectif de supervision",
  missionState: "IN_PROGRESS",
  planLabel: "Plan contrôlé",
  tasks: [
    {
      taskId: "task-a",
      label: "Tâche source",
      status: "completed",
      dependsOn: [],
    },
    {
      taskId: "task-b",
      label: "Tâche dépendante",
      status: "in_progress",
      dependsOn: ["task-a"],
    },
  ],
  workers: [
    {
      workerId: "worker-a",
      label: "Worker A",
      status: "running",
      taskIds: ["task-b"],
    },
    {
      workerId: "worker-b",
      label: "Worker B",
      status: "passed",
      taskIds: ["task-a"],
    },
    {
      workerId: "worker-c",
      label: "Worker C",
      status: "failed",
      taskIds: ["task-b"],
    },
    {
      workerId: "worker-d",
      label: "Worker D",
      status: "blocked",
      taskIds: [],
    },
  ],
  blockers: ["Blocage de revue"],
  errors: ["Erreur de connecteur"],
  finalResult: "Résultat final déclaré",
  mergePerformed: false,
  productionDeploymentPerformed: false,
};

const capabilities: readonly CapabilityViewSnapshot[] = [
  {
    capabilityId: "cap.allowed",
    available: true,
    permissionState: "ALLOWED",
    scope: "local",
    reason: "Lecture disponible",
    constraints: [],
  },
  {
    capabilityId: "cap.approval",
    available: true,
    permissionState: "APPROVAL_REQUIRED",
    scope: "externe",
    reason: "Approbation requise",
    constraints: ["Lecture seule"],
  },
  {
    capabilityId: "cap.denied",
    available: true,
    permissionState: "DENIED",
    scope: "protégé",
    reason: "Refus politique déclaré",
    constraints: [],
  },
  {
    capabilityId: "cap.unavailable",
    available: false,
    permissionState: "UNAVAILABLE",
    scope: "production",
    reason: "Fournisseur absent",
    constraints: [],
  },
];

function renderSurface() {
  return renderToStaticMarkup(
    <CkSupervisorSurface
      snapshot={snapshot}
      capabilities={capabilities}
      dataLabel="Données locales simulées — aucune autorité d’exécution"
      onSubmitObjective={() => {}}
    />,
  );
}

describe("CkSupervisorSurface", () => {
  it("renders mission state, task statuses, DAG dependencies and worker associations", () => {
    const html = renderSurface();

    expect(html).toContain("IN_PROGRESS");
    expect(html).toContain("Tâche dépendante");
    expect(html).toContain("in_progress");
    expect(html).toContain("Dépend de : task-a");
    expect(html).toContain("Worker A");
    expect(html).toContain("Tâches : task-b");
    expect(html).toContain("running");
    expect(html).toContain("passed");
    expect(html).toContain("failed");
    expect(html).toContain("blocked");
  });

  it("renders every permission state distinctly and as read-only information", () => {
    const html = renderSurface();

    expect(html).toContain("ck-permission-allowed");
    expect(html).toContain(">ALLOWED<");
    expect(html).toContain("ck-permission-approval_required");
    expect(html).toContain("APPROVAL_REQUIRED — approbation externe requise");
    expect(html).toContain("ck-permission-denied");
    expect(html).toContain("DENIED — refusé");
    expect(html).toContain("ck-permission-unavailable");
    expect(html).toContain("UNAVAILABLE — indisponible");
    expect(html).toContain("UI ≠ permission, approbation ou autorité");
  });

  it("renders blockers, errors, final result and explicit non-actions", () => {
    const html = renderSurface();

    expect(html).toContain("Blocage de revue");
    expect(html).toContain("Erreur de connecteur");
    expect(html).toContain("Résultat final déclaré");
    expect(html).toContain("merge non effectué");
    expect(html).toContain("déploiement production non effectué");
  });

  it("visibly labels local data and empty-input validation", () => {
    const html = renderSurface();

    expect(html).toContain("Données locales simulées — aucune autorité d’exécution");
    expect(html).toContain("Un objectif non vide est requis.");
    expect(html).toContain('aria-live="polite"');
  });

  it("offers no approval mutation, merge or production action", () => {
    const html = renderSurface();

    expect(html).not.toContain(">Approuver<");
    expect(html).not.toContain(">Rejeter<");
    expect(html).not.toContain(">Fusionner<");
    expect(html).not.toContain(">Déployer<");
    expect(html).not.toContain("resolveApproval");
  });
});
