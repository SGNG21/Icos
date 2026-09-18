/**
 * Test E2E de la boucle opérationnelle ICOS (usage LOCAL uniquement).
 *
 * Prouve, sans lecture manuelle de Temporal :
 *   user authentifié → POST /api/tasks → Task PostgreSQL → workflow Temporal
 *   → Hermes → OmniRoute → modèle → résultat → ICOS PostgreSQL
 *   → Task succeeded → result/evidence lisible via API ICOS.
 *
 * Et le chemin d'échec :
 *   échec worker → Temporal failure → ICOS ne marque JAMAIS succeeded
 *   → Task failed → erreur exploitable via API ICOS.
 *
 * SÉCURITÉ : aucun secret, cookie, token ou hash n'est affiché. Le mot de passe
 * de l'utilisateur de test est éphémère et fourni par l'environnement.
 */
import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";

const BASE_URL = process.env.ICOS_BASE_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.E2E_EMAIL ?? "e2e-runner@icos.local";
const TEST_PASSWORD = process.env.E2E_PASSWORD;

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} — ${step} :: ${detail}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Crée (ou réinitialise) l'utilisateur de test et lui donne le rôle owner. */
async function ensureTestUser(): Promise<void> {
  const env = loadEnv();
  const container = await createContainer({ env });
  try {
    if (!container.auth || !container.roles) {
      throw new Error("auth indisponible");
    }
    const existing = await container.auth.readHumanUserByEmail(TEST_EMAIL);
    if (existing) {
      await container.auth.deleteHumanUser(existing.id);
    }
    const created = await container.auth.createHumanUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD!,
      name: "E2E Runner",
    });
    if (!created.ok) {
      throw new Error(`création utilisateur impossible : ${created.reason}`);
    }
    await container.roles.grantRole(created.userId, "owner");
  } finally {
    await container.close();
  }
}

/** Ouvre une session Better Auth et retourne le cookie (jamais journalisé). */
async function login(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // La route d'auth impose une mutation same-origin.
      origin: BASE_URL,
    },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`login refusé (HTTP ${response.status})`);
  }
  const cookie = response.headers.getSetCookie?.().join("; ") ?? "";
  if (!cookie) {
    throw new Error("aucun cookie de session émis");
  }
  return cookie;
}

interface TaskPayload {
  task: { id: string; status: string; title: string };
  workflowId: string;
}

async function createTask(cookie: string, title: string): Promise<TaskPayload> {
  const response = await fetch(`${BASE_URL}/api/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: BASE_URL,
    },
    body: JSON.stringify({ title }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`POST /api/tasks → HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload as TaskPayload;
}

async function readTask(cookie: string, taskId: string) {
  const response = await fetch(`${BASE_URL}/api/tasks`, { headers: { cookie } });
  const payload = await response.json();
  const tasks = (payload.tasks ?? []) as Array<{ id: string; status: string }>;
  return tasks.find((t) => t.id === taskId) ?? null;
}

async function readExecution(cookie: string, taskId: string) {
  const response = await fetch(`${BASE_URL}/api/tasks/${taskId}/execution`, {
    headers: { cookie },
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json();
  return payload.record as {
    outcome: string;
    result?: string;
    error?: { code: string; message: string };
    workflowId: string;
  } | null;
}

/** Attend un statut terminal, sans jamais présumer du résultat. */
async function waitForTerminal(
  cookie: string,
  taskId: string,
  timeoutMs = 180_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "unknown";
  while (Date.now() < deadline) {
    const task = await readTask(cookie, taskId);
    last = task?.status ?? "unknown";
    if (last === "succeeded" || last === "failed" || last === "cancelled") {
      return last;
    }
    await sleep(2_000);
  }
  return `timeout(dernier=${last})`;
}

async function runSuccessPath(cookie: string): Promise<void> {
  console.log("\n=== CHEMIN SUCCÈS ===");
  const created = await createTask(
    cookie,
    "Réponds exactement ICOS_TEMPORAL_HERMES_OK et rien d'autre",
  );
  record(
    "2-3. POST /api/tasks → Task PostgreSQL",
    Boolean(created.task.id),
    `taskId=${created.task.id} status=${created.task.status}`,
  );
  record(
    "4. Workflow Temporal démarré",
    created.workflowId === `icos-task-${created.task.id}`,
    `workflowId=${created.workflowId}`,
  );
  record(
    "5. Task queued après dispatch",
    created.task.status === "queued",
    `status=${created.task.status}`,
  );

  const terminal = await waitForTerminal(cookie, created.task.id);
  record(
    "8-10. Retour automatique → statut terminal",
    terminal === "succeeded",
    `status=${terminal}`,
  );

  const execution = await readExecution(cookie, created.task.id);
  record(
    "11. Résultat visible via API ICOS",
    execution?.outcome === "success" && Boolean(execution.result),
    execution
      ? `outcome=${execution.outcome} result=${JSON.stringify(execution.result?.slice(0, 80))}`
      : "aucun résultat",
  );
  record(
    "6-7. Prompt réel transmis à Hermes/OmniRoute",
    Boolean(execution?.result && execution.result.includes("ICOS_TEMPORAL_HERMES_OK")),
    execution?.result ? `result contient le marqueur attendu` : "marqueur absent",
  );
}

async function runFailurePath(cookie: string): Promise<void> {
  console.log("\n=== CHEMIN ÉCHEC (contrôlé) ===");
  // L'échec est provoqué côté worker via E2E_FORCE_FAILURE (voir activities.ts).
  const created = await createTask(cookie, "E2E_FORCE_FAILURE déclenche un échec contrôlé");
  record(
    "1-2. Task d'échec créée",
    Boolean(created.task.id),
    `taskId=${created.task.id} status=${created.task.status}`,
  );

  const terminal = await waitForTerminal(cookie, created.task.id);
  record("3-4. Task failed (jamais succeeded)", terminal === "failed", `status=${terminal}`);

  const execution = await readExecution(cookie, created.task.id);
  record(
    "5. Erreur exploitable visible dans ICOS",
    execution?.outcome === "failure" && Boolean(execution.error?.code),
    execution?.error
      ? `code=${execution.error.code} message=${execution.error.message.slice(0, 80)}`
      : "aucune erreur enregistrée",
  );
}

async function main(): Promise<void> {
  if (!TEST_PASSWORD || TEST_PASSWORD.length < 12) {
    throw new Error("E2E_PASSWORD est requis (>= 12 caractères).");
  }

  await ensureTestUser();
  const cookie = await login();
  record("1. Utilisateur authentifié", true, `session ouverte pour ${TEST_EMAIL}`);

  await runSuccessPath(cookie);
  await runFailurePath(cookie);

  console.log("\n=== SYNTHÈSE ===");
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.step}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} étapes OK`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("E2E interrompu :", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
