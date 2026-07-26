// MOCK — replace with real API data when endpoint exists

import type { ChatMessage } from "@/features/cockpit/types";

/**
 * Mock conversation history demonstrating all message roles.
 */
export const mockMessages: ChatMessage[] = [
  {
    id: "msg-user-01",
    role: "user",
    content: "Analyse le projet ICOS — architecture, dépendances et risques",
    timestamp: "2026-07-26T09:59:00.000Z",
  },
  {
    id: "msg-icos-01",
    role: "icos",
    content:
      "Je lance une analyse complète du projet ICOS. Cela inclut l'architecture, les dépendances et les risques potentiels.",
    timestamp: "2026-07-26T09:59:05.000Z",
  },
  {
    id: "msg-thinking-01",
    role: "thinking",
    timestamp: "2026-07-26T09:59:10.000Z",
  },
  {
    id: "msg-mission-01",
    role: "mission-progress",
    payload: "mission-analyse-001",
    timestamp: "2026-07-26T09:59:15.000Z",
  },
  {
    id: "msg-approval-01",
    role: "approval",
    payload: "action-deploy-001",
    timestamp: "2026-07-26T10:30:00.000Z",
  },
  {
    id: "msg-icos-02",
    role: "icos",
    content:
      "L'analyse est terminée. Voici le résumé :\n\n**Architecture**\n- Stack : Next.js 16, React 19, TypeScript strict\n- Base de données : PostgreSQL via Supabase\n- Modules principaux : D1 (Policy), D2 (Orchestration), D3 (Gateway), D4 (Runtime)\n\n**Dépendances**\n- 45 dépendances directes\n- 120 dépendances transitives\n- Aucune vulnérabilité critique identifiée\n\n**Risques**\n- Aucun risque bloquant détecté",
    timestamp: "2026-07-26T10:05:00.000Z",
  },
  {
    id: "msg-activity-01",
    role: "activity",
    payload: [
      {
        stepIndex: 0,
        label: "Analyse du code source",
        status: "completed",
        durationMs: 150000,
        startedAt: "2026-07-26T10:00:00.000Z",
        completedAt: "2026-07-26T10:02:30.000Z",
      },
      {
        stepIndex: 1,
        label: "Analyse des dépendances",
        status: "in_progress",
        startedAt: "2026-07-26T10:02:31.000Z",
      },
      {
        stepIndex: 2,
        label: "Génération du rapport",
        status: "pending",
      },
    ],
    timestamp: "2026-07-26T10:05:00.000Z",
  },
  {
    id: "msg-result-01",
    role: "result",
    payload: [
      {
        id: "artf-01",
        type: "document",
        displayName: "Rapport d'analyse",
        originalName: "analyse-icos-20260726.md",
        sizeBytes: 24576,
        description: "Rapport complet de l'analyse architecture et dépendances",
      },
      {
        id: "artf-02",
        type: "data",
        displayName: "Graphe de dépendances",
        originalName: "dependency-graph.json",
        sizeBytes: 184320,
        description: "JSON structuré des dépendances du projet",
      },
    ],
    timestamp: "2026-07-26T10:05:00.000Z",
  },
  {
    id: "msg-user-02",
    role: "user",
    content: "Lance un déploiement production de la v3.2.1",
    timestamp: "2026-07-26T10:28:00.000Z",
  },
  {
    id: "msg-icos-03",
    role: "icos",
    content:
      "Cette action nécessite votre approbation explicite car elle est classée comme sensible.",
    timestamp: "2026-07-26T10:28:05.000Z",
  },
  {
    id: "msg-user-03",
    role: "user",
    content: "Génère un rapport de sécurité mensuel",
    timestamp: "2026-07-26T11:00:00.000Z",
  },
];
