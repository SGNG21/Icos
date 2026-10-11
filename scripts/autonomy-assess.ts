/**
 * Autonomy assessment (BR-06): where ICOS stands on the L0–L6 ladder, from durable proofs.
 *
 * READ-ONLY. A thin CLI over `container.autonomyAssessment` (src/server/autonomy/autonomy-evidence.ts),
 * which only reads the existing repositories: audit journal (goal conversions, execution callbacks,
 * gate reports), goals, missions, review decisions. Nothing is written, nothing is started. No secret
 * is read or printed (evidence refs are row ids, model ids and branch names).
 *
 * The same command gives the same answer for the same rows: that is the reproducibility claim.
 * Requires PERSISTENCE=postgres; the tier comes from ICOS_RUNTIME_TIER (lab | live), never guessed.
 *
 * Usage:
 *   pnpm autonomy:assess            # human-readable ladder + dimensions + proofs + limits
 *   pnpm autonomy:assess --json     # the full assessment as JSON
 *   pnpm autonomy:assess --direct   # the four repositories only, no container composition:
 *                                   # for a database whose schema predates the full runtime
 *                                   # (e.g. the live base before the convergence is deployed)
 */
import { loadEnv } from "@/config/env";
import type { AutonomyAssessment } from "@/core/autonomy/assessment";
import {
  autonomyAssessmentFor,
  type AutonomyAssessmentPort,
} from "@/server/autonomy/autonomy-evidence";
import { createContainer } from "@/server/container";
import { createDatabase } from "@/server/database/client";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresGoalRepository } from "@/server/repositories/postgres/goal-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";

function format(a: AutonomyAssessment): string {
  const lines: string[] = [
    `AUTONOMY_LEVEL=${a.level}`,
    `CERTIFICATION=${a.certification}`,
    `TIER=${a.tier ?? "undeclared"}`,
    `ASSESSED_AT=${a.assessedAt}`,
    ``,
    a.levelReason,
    ``,
  ];
  for (const d of a.dimensions) {
    lines.push(
      `${d.label.padEnd(17)} ${d.state.padEnd(9)} ${d.certification.padEnd(15)} proofs=${d.proofs}${d.lastEvidenceAt ? ` last=${d.lastEvidenceAt}` : ""}`,
    );
    for (const e of d.evidence) lines.push(`    ${e.source}:${e.ref}  ${e.summary}`);
    for (const l of d.limits) lines.push(`    limit: ${l}`);
  }
  lines.push(``, `Unmeasurable levels: ${a.unmeasurableLevels.join(", ")}`);
  for (const l of a.limits) lines.push(`limit: ${l}`);
  return lines.join("\n");
}

/** The same four repositories the container composes, and nothing else. */
function direct(): { port: AutonomyAssessmentPort; close: () => Promise<void> } {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres" || !env.DATABASE_URL)
    throw new Error("autonomy:assess --direct requires PERSISTENCE=postgres and DATABASE_URL");
  const handle = createDatabase(env.DATABASE_URL, { max: 2 });
  const tasks = new PostgresTaskRepository(handle.db);
  return {
    port: autonomyAssessmentFor(
      {
        audit: new PostgresAuditRepository(handle.db),
        goals: new PostgresGoalRepository(handle.db),
        missions: new PostgresMissionRepository(handle.db, tasks),
        reviewDecisions: new PostgresReviewDecisionRepository(handle.db),
      },
      env.ICOS_RUNTIME_TIER,
    ),
    close: handle.close,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--json" && a !== "--direct");
  if (unknown.length > 0) throw new Error("Usage: pnpm autonomy:assess [--json] [--direct]");
  const source = args.includes("--direct")
    ? direct()
    : await createContainer().then((c) => ({ port: c.autonomyAssessment, close: () => c.close() }));
  try {
    const assessment = await source.port.current();
    process.stdout.write(
      (args.includes("--json") ? JSON.stringify(assessment, null, 2) : format(assessment)) + "\n",
    );
  } finally {
    await source.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
