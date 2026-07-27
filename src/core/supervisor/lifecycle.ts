import type { TaskNodeStatus, TaskNode, TaskDag, DagStatus } from "./contract";
import {
  TERMINAL_NODE_STATUSES,
  TERMINAL_DAG_STATUSES,
  SUSPENDED_NODE_STATUSES,
} from "./contract";

// ─────────────────────────────────────
// Node-level transitions
// ─────────────────────────────────────

/**
 * Matrice des transitions autorisées pour un nœud.
 * La clé est l'état source, la valeur est l'ensemble des états cibles autorisés.
 *
 * INVARIANT : les états terminaux n'ont aucune transition sortante.
 */
const NODE_TRANSITIONS: Record<TaskNodeStatus, readonly TaskNodeStatus[]> = {
  PENDING: ["READY", "BLOCKED", "CANCELLED"],
  // FAILED autorisé : le provisioning (worktree, spawn) peut échouer entre
  // READY et ASSIGNED. Sans cette transition, un échec de provisioning laisse
  // le nœud bloqué en READY (zombie) au lieu d'atteindre un état terminal.
  READY: ["ASSIGNED", "BLOCKED", "CANCELLED", "FAILED"],
  ASSIGNED: ["RUNNING", "WAITING_FOR_HUMAN", "FAILED", "CANCELLED", "READY"],
  RUNNING: ["REVIEWING", "FAILED", "CANCELLED"],
  REVIEWING: ["SUCCEEDED", "CHANGES_REQUIRED", "FAILED_REVIEW", "FAILED"],
  CHANGES_REQUIRED: ["READY", "FAILED"],
  FAILED_REVIEW: ["READY", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  BLOCKED: ["PENDING", "CANCELLED"],
  WAITING_FOR_HUMAN: ["READY", "CANCELLED"],
};

/**
 * Vérifie si une transition de nœud est autorisée.
 *
 * @returns true si la transition est valide, false sinon.
 */
export function isNodeTransitionAllowed(
  from: TaskNodeStatus,
  to: TaskNodeStatus,
): boolean {
  const allowed = NODE_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Retourne les transitions autorisées depuis un état donné.
 */
export function allowedNodeTransitionsFrom(
  status: TaskNodeStatus,
): readonly TaskNodeStatus[] {
  return NODE_TRANSITIONS[status] ?? [];
}

/**
 * Vrai si l'état du nœud est terminal.
 */
export function isNodeTerminal(status: TaskNodeStatus): boolean {
  return (TERMINAL_NODE_STATUSES as readonly string[]).includes(status);
}

/**
 * Vrai si l'état du nœud est suspendu (en attente d'événement externe).
 */
export function isNodeSuspended(status: TaskNodeStatus): boolean {
  return (SUSPENDED_NODE_STATUSES as readonly string[]).includes(status);
}

/**
 * Vrai si le nœud peut être retryé.
 * Un retry est possible si le nœud n'a pas dépassé son maxRetries
 * et n'est pas dans un état définitif (SUCCEEDED, CANCELLED).
 *
 * FAILED et BLOCKED sont retryables : ils représentent un échec
 * temporaire qui peut être surmonté par une nouvelle exécution.
 */
export function canRetryNode(node: TaskNode): boolean {
  if (node.status === "SUCCEEDED" || node.status === "CANCELLED") return false;
  return node.retryCount < node.maxRetries;
}

// ─────────────────────────────────────
// DAG-level transitions
// ─────────────────────────────────────

const DAG_TRANSITIONS: Record<DagStatus, readonly DagStatus[]> = {
  CREATED: ["SCHEDULING", "FAILED", "CANCELLED"],
  SCHEDULING: ["EXECUTING", "FAILED", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * Vérifie si une transition du DAG est autorisée.
 */
export function isDagTransitionAllowed(
  from: DagStatus,
  to: DagStatus,
): boolean {
  const allowed = DAG_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Vrai si le statut DAG est terminal.
 */
export function isDagTerminal(status: DagStatus): boolean {
  return (TERMINAL_DAG_STATUSES as readonly string[]).includes(status);
}

// ─────────────────────────────────────
// Dependency graph utilities
// ─────────────────────────────────────

/**
 * Détecte un cycle dans le graph de dépendances.
 * Utilise DFS avec détection de back-edge.
 *
 * @param nodes Map des nœuds indexés par ID
 * @param dependsOnFn Fonction retournant les dépendances d'un nœud
 * @returns Le premier cycle trouvé, ou null si le graph est acyclique
 */
export function detectCycle(
  nodes: Map<string, { id: string; dependsOn: readonly string[] }>,
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parent = new Map<string, string>();

  function dfs(nodeId: string, path: string[]): string[] | null {
    visited.add(nodeId);
    inStack.add(nodeId);

    const node = nodes.get(nodeId);
    if (!node) return null;

    for (const depId of node.dependsOn) {
      if (!nodes.has(depId)) continue; // Ignorer les dépendances inconnues

      if (!visited.has(depId)) {
        parent.set(depId, nodeId);
        const cycle = dfs(depId, [...path, depId]);
        if (cycle) return cycle;
      } else if (inStack.has(depId)) {
        // Back-edge détecté → cycle
        const cyclePath = path.slice(path.indexOf(depId));
        return [...cyclePath, depId];
      }
    }

    inStack.delete(nodeId);
    return null;
  }

  for (const nodeId of nodes.keys()) {
    if (!visited.has(nodeId)) {
      const cycle = dfs(nodeId, [nodeId]);
      if (cycle) return cycle;
    }
  }

  return null;
}

/**
 * Calcule les nœuds prêts à être exécutés.
 * Un nœud est "ready" si :
 * 1. Il est en état PENDING
 * 2. Toutes ses dépendances sont SUCCEEDED
 * 3. Aucun bloqueur actif
 *
 * @returns Liste des IDs des nœuds ready
 */
export function computeReadyNodes(dag: TaskDag): string[] {
  const ready: string[] = [];
  const nodes = dag.nodes;

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.status !== "PENDING") continue;

    // Toutes les dépendances doivent être SUCCEEDED
    const allDepsSucceeded = node.dependsOn.every((depId) => {
      const depNode = nodes[depId];
      return depNode && depNode.status === "SUCCEEDED";
    });

    if (!allDepsSucceeded) continue;

    // Aucun bloqueur actif
    const noActiveBlockers = node.blockedBy.every((blockerId) => {
      const blocker = nodes[blockerId];
      return !blocker || blocker.status === "SUCCEEDED" || blocker.status === "CANCELLED";
    });

    if (!noActiveBlockers) continue;

    ready.push(nodeId);
  }

  return ready;
}

/**
 * Vérifie si l'ajout d'une dépendance créerait un cycle.
 * Utile pour la validation avant mutation.
 */
export function wouldCreateCycle(
  nodes: Map<string, { id: string; dependsOn: readonly string[] }>,
  fromNodeId: string,
  toNodeId: string,
): boolean {
  // Simuler l'ajout de la dépendance
  const simulated = new Map(nodes);
  const existing = simulated.get(fromNodeId);
  if (existing) {
    simulated.set(fromNodeId, {
      id: fromNodeId,
      dependsOn: [...existing.dependsOn, toNodeId],
    });
  }

  return detectCycle(simulated) !== null;
}

/**
 * Calcule l'ordre topologique du DAG (Kahn's algorithm).
 * Utile pour l'intégration ordonnée.
 *
 * @returns Liste des IDs dans l'ordre topologique, ou null si cycle détecté
 */
export function topologicalSort(dag: TaskDag): string[] | null {
  const nodes = dag.nodes;
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialiser
  for (const nodeId of Object.keys(nodes)) {
    inDegree.set(nodeId, 0);
    adjacency.set(nodeId, []);
  }

  // Construire le graph et calculer les in-degrees
  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const depId of node.dependsOn) {
      if (!nodes[depId]) continue;
      adjacency.get(depId)?.push(nodeId);
      inDegree.set(nodeId, (inDegree.get(nodeId) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) queue.push(nodeId);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    sorted.push(nodeId);

    for (const neighbor of adjacency.get(nodeId) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // Si le tri n'a pas inclus tous les nœuds → cycle
  if (sorted.length !== Object.keys(nodes).length) return null;

  return sorted;
}

/**
 * Valide un DAG complet.
 *
 * Vérifications :
 * 1. Tous les nœuds ont des IDs uniques
 * 2. Pas de cycle dans les dépendances
 * 3. Toutes les dépendances référencent des nœuds existants
 * 4. Au moins un nœud sans dépendance (root)
 *
 * @returns Liste des erreurs de validation (vide si valide)
 */
export function validateDag(nodes: TaskNode[]): string[] {
  const errors: string[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Vérifier les IDs uniques
  if (nodeMap.size !== nodes.length) {
    errors.push("Des nœuds ont des IDs en double");
  }

  // Vérifier que toutes les dépendances existent
  for (const node of nodes) {
    for (const depId of node.dependsOn) {
      if (!nodeMap.has(depId)) {
        errors.push(`Le nœud "${node.id}" dépend de "${depId}" qui n'existe pas`);
      }
    }
  }

  // Détecter les cycles
  const cycle = detectCycle(nodeMap);
  if (cycle) {
    errors.push(`Cycle détecté dans les dépendances : ${cycle.join(" → ")}`);
  }

  // Vérifier qu'il y a au moins un nœud racine
  const hasRoot = nodes.some((n) => n.dependsOn.length === 0);
  if (!hasRoot) {
    errors.push("Aucun nœud racine (tous les nœuds ont des dépendances)");
  }

  return errors;
}
