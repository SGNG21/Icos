// MOCK — replace with real API data when endpoint exists

import type { Mission } from "@/core/mission";

/**
 * Mock active missions for the cockpit.
 * Each mission includes a plan with steps for progress display.
 */
export const mockMissions: Mission[] = [
  {
    id: "mission-analyse-001",
    tenantId: "icos",
    userRequest: "Analyse ICOS — architecture et dépendances",
    status: "IN_PROGRESS",
    plan: {
      steps: [
        {
          id: "step-plan-01",
          description: "Analyse du code source",
          status: "completed",
          dependsOn: [],
        },
        {
          id: "step-plan-02",
          description: "Analyse des dépendances",
          status: "in_progress",
          dependsOn: ["step-plan-01"],
        },
        {
          id: "step-plan-03",
          description: "Génération du rapport",
          status: "pending",
          dependsOn: ["step-plan-02"],
        },
      ],
      totalSteps: 3,
      description: "Analyse complète du projet ICOS",
    },
    runs: [
      {
        id: "run-analyse-001",
        missionId: "mission-analyse-001",
        stepIndex: 0,
        startedAt: "2026-07-26T10:00:00.000Z",
        completedAt: "2026-07-26T10:02:30.000Z",
        status: "completed",
      },
      {
        id: "run-analyse-002",
        missionId: "mission-analyse-001",
        stepIndex: 1,
        startedAt: "2026-07-26T10:02:31.000Z",
        status: "in_progress",
      },
    ],
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:02:31.000Z",
  },
  {
    id: "mission-deploy-001",
    tenantId: "icos",
    userRequest: "Déploiement production — v3.2.1",
    status: "WAITING_FOR_APPROVAL",
    plan: {
      steps: [
        {
          id: "step-deploy-01",
          description: "Validation des prérequis",
          status: "completed",
          dependsOn: [],
        },
        {
          id: "step-deploy-02",
          description: "Déploiement des services",
          status: "pending",
          dependsOn: ["step-deploy-01"],
        },
      ],
      totalSteps: 2,
      description: "Déploiement production v3.2.1",
    },
    runs: [
      {
        id: "run-deploy-001",
        missionId: "mission-deploy-001",
        stepIndex: 0,
        startedAt: "2026-07-26T09:30:00.000Z",
        completedAt: "2026-07-26T09:31:00.000Z",
        status: "completed",
      },
    ],
    createdAt: "2026-07-26T09:30:00.000Z",
    updatedAt: "2026-07-26T09:31:00.000Z",
  },
  {
    id: "mission-security-001",
    tenantId: "icos",
    userRequest: "Rapport de sécurité — audit mensuel",
    status: "PLANNING",
    plan: {
      steps: [
        {
          id: "step-sec-01",
          description: "Scan des vulnérabilités",
          status: "pending",
          dependsOn: [],
        },
        {
          id: "step-sec-02",
          description: "Analyse des logs d'accès",
          status: "pending",
          dependsOn: [],
        },
        {
          id: "step-sec-03",
          description: "Génération du rapport",
          status: "pending",
          dependsOn: ["step-sec-01", "step-sec-02"],
        },
      ],
      totalSteps: 3,
      description: "Audit de sécurité mensuel",
    },
    runs: [],
    createdAt: "2026-07-26T11:00:00.000Z",
    updatedAt: "2026-07-26T11:00:00.000Z",
  },
];
