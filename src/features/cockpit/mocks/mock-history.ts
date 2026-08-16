// MOCK — replace with real API data when endpoint exists

import type { MissionHistoryItem } from "@/features/cockpit/types";

/**
 * Mock mission history — completed, failed, and cancelled missions.
 * Includes diverse durations and relative times.
 */
export const mockHistory: MissionHistoryItem[] = [
  {
    id: "mission-hist-01",
    status: "COMPLETED",
    userRequest: "Mise à jour des dépendances — npm audit fix",
    totalSteps: 2,
    completedSteps: 2,
    createdAt: "2026-07-25T14:00:00.000Z",
    updatedAt: "2026-07-25T14:05:30.000Z",
    completedAt: "2026-07-25T14:05:30.000Z",
  },
  {
    id: "mission-hist-02",
    status: "COMPLETED",
    userRequest: "Configuration CI/CD — GitHub Actions",
    totalSteps: 4,
    completedSteps: 4,
    createdAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T09:45:00.000Z",
    completedAt: "2026-07-24T09:45:00.000Z",
  },
  {
    id: "mission-hist-03",
    status: "FAILED",
    userRequest: "Déploiement staging — v3.2.0-beta",
    totalSteps: 3,
    completedSteps: 2,
    error: "Échec lors de l'étape 3 : tests d'intégration — 5 tests en échec",
    createdAt: "2026-07-23T16:00:00.000Z",
    updatedAt: "2026-07-23T16:12:00.000Z",
    completedAt: "2026-07-23T16:12:00.000Z",
  },
  {
    id: "mission-hist-04",
    status: "FAILED",
    userRequest: "Migration base de données — ajout colonnes",
    totalSteps: 1,
    completedSteps: 0,
    error: "La migration nécessite une révision du plan",
    createdAt: "2026-07-22T11:00:00.000Z",
    updatedAt: "2026-07-22T11:01:30.000Z",
    completedAt: "2026-07-22T11:01:30.000Z",
  },
  {
    id: "mission-hist-05",
    status: "CANCELLED",
    userRequest: "Refonte page d'accueil — nouveau design",
    totalSteps: 5,
    completedSteps: 1,
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T09:30:00.000Z",
  },
  {
    id: "mission-hist-06",
    status: "CANCELLED",
    userRequest: "Intégration API Dolibarr — phase 1",
    totalSteps: 3,
    completedSteps: 0,
    createdAt: "2026-07-20T13:00:00.000Z",
    updatedAt: "2026-07-20T13:15:00.000Z",
  },
];
