import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import { BACKLOG_PARTITION } from "@/server/autonomy/durable-improvement-backlog";
import type { Container } from "@/server/container";

/**
 * WRITES THE LINEAGE DOWN, FROM THE DATABASE (M14).
 *
 * A self-build run proved itself in a console that scrolled away and a test database the
 * next run truncated. Git kept the integrated commit and nothing else — not the goal, the
 * plan, the workspace, the worker, the reviewer's verdict, the gate's per-command results or
 * the learning. "Completion requires evidence" cannot mean evidence that only existed while
 * someone was watching.
 *
 * EVERY FIELD IS READ BACK FROM THE DURABLE ROWS, never from what the run reported in
 * memory. That is the same rule the worker's commit evidence follows: a claim is a claim,
 * and the row is the evidence. Where a row is absent the record says so explicitly rather
 * than omitting the line, because a missing stage is exactly what a reader needs to see.
 */

export interface SelfDevelopmentEvidenceInput {
  container: Container;
  /** The certification marker this run is evidence for. */
  marker: string;
  /** The high-level instruction, when the run started from one. */
  instruction?: string;
  candidateId: string;
  goalId: string;
  missionId: string;
  /** The canonical repository whose branch the run advanced. */
  repoPath: string;
  integrationRef: string;
  targetBefore: string;
  targetAfter: string;
  /** Repository-relative path of the record to write. */
  outPath: string;
  startedAt: string;
  /** The database these rows were read from. Recorded so a reader can go and look. */
  databaseUrl: string;
  /** Commits the run added to the target, oldest first, as `<sha> <subject>`. */
  addedCommits: string[];
  /** The coordinator's own outcome. Reported, and labelled as reported, not as a row. */
  outcome?: unknown;
  /** The gate commands this deployment was configured with — the REAL ones, or not. */
  gateCommands?: unknown;
  notes?: string[];
}

const one = <T>(rows: unknown): T | undefined => (rows as T[])[0];

const fence = (value: unknown): string =>
  "```json\n" + JSON.stringify(value ?? null, null, 2) + "\n```";

/** Truncated for a record meant to be read; the durable rows keep the whole thing. */
const clip = (value: string | null | undefined, max = 4000): string | null =>
  value == null ? null : value.length > max ? `${value.slice(0, max)}\n… [${value.length} bytes]` : value;

export async function writeSelfDevelopmentEvidence(
  input: SelfDevelopmentEvidenceInput,
): Promise<string> {
  const { container, missionId } = input;
  const db = container.db!;

  /* The backlog is append-only over context items; the LATEST revision is the candidate. */
  const backlogRows = await db.execute(sql`
    select "id", "summary", "contentReference", "createdAt"
    from context_items where "missionId" = ${BACKLOG_PARTITION}
    order by "createdAt" asc
  `);
  const candidate = (backlogRows as unknown as Array<Record<string, unknown>>).filter((row) =>
    String(row.id ?? "").includes(input.candidateId),
  );

  const goal = await container.goalRepository.getById(input.goalId).catch(() => null);
  const mission = await container.mission.findById(missionId);
  const missionTasks = await container.mission.listTasks(missionId);

  const canonicalTasks = await Promise.all(
    missionTasks.map(async (t) => ({
      missionTaskId: t.id,
      taskId: t.taskId,
      title: t.title,
      status: t.status,
      dependsOn: t.dependsOn,
      canonical: await container.tasks.getById(t.taskId),
    })),
  );

  const attempts = await db.execute(sql`
    select id, mission_task_id, task_id, workflow_id, attempt, state, worker_kind, worker_id,
           capability, dispatched_at, execution_lease_owner, execution_lease_until,
           failure_class, created_at, updated_at
    from dispatch_attempts where mission_id = ${missionId} order by created_at asc
  `);

  const workspaces = (await container.workspaceManager!.list()).filter(
    (w) => w.missionId === missionId,
  );

  const results = await db.execute(sql`
    select r.id, r.task_id, r.workflow_id, r.outcome, r.worker_kind, r.capability,
           r.error_code, r.error_message, r.started_at, r.completed_at, r.artifacts,
           r.evidence, r.findings, r.observations, r.confidence
    from task_execution_results r
    join dispatch_attempts d on d.workflow_id = r.workflow_id
    where d.mission_id = ${missionId}
  `);

  /* Canonical review decisions live in `decisions` (camelCase columns). */
  const reviews = await db.execute(sql`
    select "id", "taskId", "workflowId", "decision", "reviewerKind", "severity", "reasons",
           "requestedChanges", "evidenceRefs", "providerMetadata", "confidence", "createdAt"
    from decisions where "missionId" = ${missionId} order by "createdAt" asc
  `);

  const patterns = await container.durableMemory.getPatterns({ limit: 50 }).catch(() => []);
  const missionPatterns = patterns.filter((p) => (p.missionIds ?? []).includes(missionId));

  const autonomousPlan = one<Record<string, unknown>>(
    await db.execute(sql`
      select id, mission_id, goal_id, plan_id, plan_fingerprint, version,
             predecessor_plan_id, created_at
      from autonomous_plans where mission_id = ${missionId} order by version desc limit 1
    `),
  );

  const lines: string[] = [
    `# ${input.marker} — durable evidence`,
    "",
    `Written by the run itself, from database rows, at ${new Date().toISOString()}.`,
    `Started: ${input.startedAt}`,
    `Database: ${input.databaseUrl}`,
    `Repository: ${input.repoPath} @ ${input.integrationRef}`,
    "",
    "## 0. Input",
    "",
    input.instruction
      ? `THE ONLY INPUT WAS A SENTENCE:\n\n> ${input.instruction}\n\nNo candidate, goal, mission, task, plan, worker, review, approval or integration call was supplied.`
      : `An ImprovementCandidate was supplied (\`${input.candidateId}\`). No goal, mission, task, plan, worker, review, approval or integration call was supplied.`,
    "",
    "## 1. Candidate",
    "",
    candidate.length
      ? fence(
          candidate.map((row) => ({
            ...row,
            contentReference: clip(row.contentReference as string | null),
          })),
        )
      : "**ABSENT** — no backlog row for this candidate.",
    "",
    "## 2. Goal",
    "",
    goal ? fence(goal.goal) : "**ABSENT** — no goal row.",
    "",
    "## 3. Mission",
    "",
    mission ? fence(mission) : "**ABSENT** — no mission row.",
    "",
    "## 4. Plan and DAG",
    "",
    autonomousPlan ? fence(autonomousPlan) : "_No autonomous_plans row for this mission._",
    "",
    fence(canonicalTasks),
    "",
    "## 5. Dispatch attempts — routing, worker identity, lease",
    "",
    fence(attempts),
    "",
    "## 6. Governed workspaces",
    "",
    workspaces.length ? fence(workspaces) : "**ABSENT** — no governed workspace was allocated.",
    "",
    "## 7. Execution results",
    "",
    results.length ? fence(results) : "**ABSENT** — no execution result was recorded.",
    "",
    "## 8. Independent review",
    "",
    reviews.length
      ? fence(reviews)
      : "**ABSENT** — no review decision row, so nothing could have authorised an integration.",
    "",
    "## 9. Gate",
    "",
    "Configured gate commands (from `ICOS_GATE_COMMANDS`; an ACCEPT means every one of these",
    "ran and passed inside the governed workspace):",
    "",
    fence(input.gateCommands),
    "",
    "Coordinator outcome as REPORTED by the run (not a durable row; the durable trace of the",
    "gate is the learned pattern in section 11, whose outcome is derived from its decision):",
    "",
    fence(input.outcome),
    "",
    "## 10. Integration",
    "",
    "```",
    `${input.integrationRef} before: ${input.targetBefore}`,
    `${input.integrationRef} after:  ${input.targetAfter}`,
    "```",
    "",
    /* EXACTLY-ONCE is a property of git ancestry, so it is stated as a count, not a flag. */
    input.addedCommits.length
      ? `Commits added to \`${input.integrationRef}\` (${input.addedCommits.length}):\n\n` +
        input.addedCommits.map((c) => `- \`${c}\``).join("\n")
      : "**NOTHING WAS INTEGRATED** — the target did not move.",
    "",
    "",
    "## 11. Durable learning",
    "",
    missionPatterns.length
      ? fence(missionPatterns)
      : patterns.length
        ? `_No pattern names this mission; ${patterns.length} pattern(s) exist._`
        : "**ABSENT** — no learned pattern.",
    "",
    input.notes?.length ? `## 12. Notes\n\n${input.notes.map((n) => `- ${n}`).join("\n")}` : "",
    "",
  ];

  const target = path.resolve(input.outPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, lines.filter((l) => l !== "").join("\n") + "\n", "utf8");
  return target;
}

export { clip };
