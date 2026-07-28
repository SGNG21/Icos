import type {
  CapabilitySnapshotClient,
  CapabilityViewSnapshot,
  CockpitSupervisorSnapshot,
  MissionEntryClient,
  MissionEntrySnapshot,
  SupervisorStateClient,
} from "@/features/cockpit/clients";

const INITIAL_MISSION_ID = "local-mission-supervision-001";

const capabilityFixture: readonly CapabilityViewSnapshot[] = [
  {
    capabilityId: "repository.read",
    available: true,
    permissionState: "ALLOWED",
    scope: "Dépôt local courant",
    reason: "Fixture locale de lecture seule.",
    constraints: ["Aucune écriture externe"],
  },
  {
    capabilityId: "release.prepare",
    available: true,
    permissionState: "APPROVAL_REQUIRED",
    scope: "Préparation de livraison",
    reason: "Une approbation externe au Cockpit serait requise.",
    constraints: ["Aucune approbation possible depuis cette surface"],
  },
  {
    capabilityId: "repository.merge",
    available: true,
    permissionState: "DENIED",
    scope: "Branche protégée",
    reason: "La fusion n’est pas autorisée dans ce mode local.",
    constraints: ["Lecture seule", "Aucune élévation de permission"],
  },
  {
    capabilityId: "production.deploy",
    available: false,
    permissionState: "UNAVAILABLE",
    scope: "Production",
    reason: "Aucun fournisseur de déploiement n’est connecté.",
    constraints: ["Aucun déploiement automatique"],
  },
];

const initialSupervisorFixture: CockpitSupervisorSnapshot = {
  missionId: INITIAL_MISSION_ID,
  objective: "Superviser la préparation locale du Cockpit V1",
  missionState: "IN_PROGRESS",
  planLabel: "Plan local de démonstration — état déclaré, sans exécution",
  tasks: [
    {
      taskId: "task-inspect",
      label: "Inspecter le dépôt",
      status: "completed",
      dependsOn: [],
    },
    {
      taskId: "task-present",
      label: "Présenter l’état de supervision",
      status: "in_progress",
      dependsOn: ["task-inspect"],
    },
    {
      taskId: "task-review",
      label: "Attendre la revue indépendante",
      status: "pending",
      dependsOn: ["task-present"],
    },
  ],
  workers: [
    {
      workerId: "worker-ui",
      label: "Worker UI local",
      status: "running",
      taskIds: ["task-present"],
    },
    {
      workerId: "worker-inspection",
      label: "Worker inspection",
      status: "passed",
      taskIds: ["task-inspect"],
    },
    {
      workerId: "worker-report",
      label: "Worker rapport",
      status: "failed",
      taskIds: ["task-present"],
    },
    {
      workerId: "worker-review",
      label: "Worker revue",
      status: "blocked",
      taskIds: ["task-review"],
    },
  ],
  blockers: ["Revue indépendante non démarrée"],
  errors: ["Connecteur de production indisponible (fixture locale)"],
  finalResult: "Aucun résultat final : mission locale encore en cours.",
  mergePerformed: false,
  productionDeploymentPerformed: false,
};

export interface DevelopmentCockpitClients {
  missionEntryClient: MissionEntryClient;
  capabilityClient: CapabilitySnapshotClient;
  supervisorClient: SupervisorStateClient;
  initialMissionId: string;
  dataLabel: string;
}

export function createDevelopmentCockpitClients(): DevelopmentCockpitClients {
  const missions = new Map<string, CockpitSupervisorSnapshot>([
    [INITIAL_MISSION_ID, initialSupervisorFixture],
  ]);
  let sequence = 1;

  const missionEntryClient: MissionEntryClient = {
    async submit(objective: string): Promise<MissionEntrySnapshot> {
      if (objective.trim().length === 0) {
        throw new Error("Un objectif non vide est requis.");
      }

      const missionId = `local-mission-${sequence++}`;
      missions.set(missionId, {
        missionId,
        objective,
        missionState: "CREATED",
        tasks: [],
        workers: [],
        blockers: [],
        errors: [],
        finalResult: "Aucun résultat final : mission locale créée, sans exécution.",
        mergePerformed: false,
        productionDeploymentPerformed: false,
      });

      return {
        missionId,
        state: "CREATED",
        readiness: "READY",
      };
    },
  };

  const capabilityClient: CapabilitySnapshotClient = {
    async read(): Promise<readonly CapabilityViewSnapshot[]> {
      return capabilityFixture;
    },
  };

  const supervisorClient: SupervisorStateClient = {
    async read(missionId: string): Promise<CockpitSupervisorSnapshot> {
      const snapshot = missions.get(missionId);
      if (!snapshot) {
        throw new Error(`Mission locale introuvable : ${missionId}`);
      }
      return snapshot;
    },
  };

  return {
    missionEntryClient,
    capabilityClient,
    supervisorClient,
    initialMissionId: INITIAL_MISSION_ID,
    dataLabel: "Données locales simulées — aucune autorité d’exécution",
  };
}
