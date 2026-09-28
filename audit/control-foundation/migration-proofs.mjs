// Fresh-database migration proofs for the CORE3 + control-foundation reconciliation.
//
// Run from the repository root:  node audit/control-foundation/migration-proofs.mjs
// Uses two throwaway databases (created then dropped here): icos_mig_empty_test, icos_mig_upgrade_test.
//   A. empty database  -> all migrations through 0048
//   B. upgrade         -> through CORE3 0047 (truncated copy of drizzle/), write goal.* rows, then 0048
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Truncated copy of drizzle/ ending at CORE3 0047 (journal idx 44).
const through0047 = mkdtempSync(join(tmpdir(), "icos-mig-0047-"));
cpSync("drizzle", through0047, { recursive: true });
rmSync(join(through0047, "0048_control_plane.sql"));
{
  const j = JSON.parse(readFileSync(join(through0047, "meta/_journal.json"), "utf8"));
  j.entries = j.entries.filter((e) => e.tag !== "0048_control_plane");
  writeFileSync(join(through0047, "meta/_journal.json"), JSON.stringify(j, null, 2));
}
const admin = postgres(`postgres://${process.env.USER}@localhost:5432/postgres`, {
  max: 1,
  onnotice: () => {},
});
for (const db of ["icos_mig_empty_test", "icos_mig_upgrade_test"]) {
  await admin.unsafe(`drop database if exists ${db}`);
  await admin.unsafe(`create database ${db}`);
}
const url = (db) => `postgres://${process.env.USER}@localhost:5432/${db}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

async function run(db, folder) {
  const sql = postgres(url(db), { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: folder });
  return sql;
}
async function allowed(sql) {
  const [r] =
    await sql`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'audit_event_type_check'`;
  return new Set([...r.d.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]));
}
async function tryAudit(sql, id, type) {
  try {
    await sql.begin(async (tx) => {
      await tx`insert into audit_entries (id, event_type, actor_type, actor_label, details, occurred_at) values (${id}, ${type}, 'system', 'migration-proof', '{}'::jsonb, now())`;
    });
    return true;
  } catch (e) {
    return e.message;
  }
}
const GOAL = ["goal.created", "goal.status_updated", "goal.converted", "goal.idempotency_key_set"];
const CTL = [
  "control.command.rejected",
  "control.command.admitted",
  "control.command.executed",
  "control.command.failed",
];

// Journal coherence + no duplicate migration number
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries;
const files = readdirSync("drizzle")
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""))
  .sort();
const numbers = files.map((f) => f.slice(0, 4));
check(
  "no duplicate migration number",
  new Set(numbers).size === numbers.length,
  `${files.length} files, last ${files.at(-1)}`,
);
check(
  "journal ↔ files bijection",
  JSON.stringify(journal.map((e) => e.tag).sort()) === JSON.stringify(files),
);
check(
  "journal idx contiguous",
  journal.every((e, i) => e.idx === i),
  `idx 0..${journal.length - 1}`,
);
check(
  "journal when strictly increasing",
  journal.every((e, i) => i === 0 || e.when > journal[i - 1].when),
);
check(
  "order: 0047_audit_goal_events then 0048_control_plane",
  journal.at(-2).tag === "0047_audit_goal_events" && journal.at(-1).tag === "0048_control_plane",
);

// A. empty database -> everything through 0048
{
  const sql = await run("icos_mig_empty_test", "drizzle");
  const [{ n }] = await sql`select count(*)::int n from drizzle.__drizzle_migrations`;
  check("A: all migrations applied on empty DB", n === journal.length, `${n}/${journal.length}`);
  const set = await allowed(sql);
  check(
    "A: CHECK has 45 values incl. goal.* and control.*",
    set.size === 45 && [...GOAL, ...CTL].every((v) => set.has(v)),
    `${set.size} values`,
  );
  for (const t of GOAL)
    check(`A: ${t} audit insert succeeds`, (await tryAudit(sql, `mig-a-${t}`, t)) === true);
  check(
    "A: control.command.executed audit insert succeeds",
    (await tryAudit(sql, "mig-a-ctl", "control.command.executed")) === true,
  );
  const bogus = await tryAudit(sql, "mig-a-bogus", "not.an.event");
  check("A: unknown event type still rejected (allow-list intact)", bogus !== true);
  const tables = (
    await sql`select table_name t from information_schema.tables where table_schema='public' and table_name in ('control_commands','control_state_versions','runtime_control_flags','mission_control_holds','control_reauth_proofs')`
  ).map((r) => r.t);
  check("A: 5 control tables exist", tables.length === 5, tables.sort().join(","));
  const [flags] = await sql`select * from runtime_control_flags`;
  check(
    "A: flags row seeded to normal operation",
    flags &&
      flags.id === "global" &&
      !flags.safe_mode &&
      flags.dispatch_enabled &&
      flags.integration_enabled &&
      flags.external_actions_enabled,
  );
  await sql.end();
}

// B. upgrade: through CORE3 0047, write goal.* rows, then apply 0048
{
  let sql = await run("icos_mig_upgrade_test", through0047);
  const [{ n: before }] = await sql`select count(*)::int n from drizzle.__drizzle_migrations`;
  check("B1: applied through 0047 only", before === journal.length - 1, `${before} applied`);
  const setBefore = await allowed(sql);
  check(
    "B1: after 0047, goal.* allowed and control.* not yet",
    GOAL.every((v) => setBefore.has(v)) && !CTL.some((v) => setBefore.has(v)),
    `${setBefore.size} values`,
  );
  for (const t of GOAL)
    check(`B1: pre-0048 ${t} row written`, (await tryAudit(sql, `mig-b-pre-${t}`, t)) === true);
  const tablesBefore = (
    await sql`select count(*)::int n from information_schema.tables where table_schema='public' and table_name='control_commands'`
  )[0].n;
  check("B1: control tables absent before 0048", tablesBefore === 0);
  await sql.end();

  sql = await run("icos_mig_upgrade_test", "drizzle");
  const [{ n: after }] = await sql`select count(*)::int n from drizzle.__drizzle_migrations`;
  check(
    "B2: upgrade applied exactly one more migration (0048)",
    after === before + 1,
    `${before} -> ${after}`,
  );
  const set = await allowed(sql);
  check(
    "B2: CHECK after upgrade = 45-value union",
    set.size === 45 && [...GOAL, ...CTL].every((v) => set.has(v)),
  );
  const [{ n: preRows }] =
    await sql`select count(*)::int n from audit_entries where id like 'mig-b-pre-%'`;
  check("B2: goal.* rows written before 0048 survive", preRows === 4, `${preRows}/4`);
  for (const t of GOAL)
    check(
      `B2: ${t} still insertable after 0048`,
      (await tryAudit(sql, `mig-b-post-${t}`, t)) === true,
    );
  check(
    "B2: control.command.* insertable after 0048",
    (await tryAudit(sql, "mig-b-ctl", "control.command.admitted")) === true,
  );
  const [flags] = await sql`select * from runtime_control_flags`;
  check("B2: flags row seeded", !!flags && !flags.safe_mode);
  await sql.end();
  // Idempotence: running migrate again applies nothing.
  sql = await run("icos_mig_upgrade_test", "drizzle");
  const [{ n: again }] = await sql`select count(*)::int n from drizzle.__drizzle_migrations`;
  check("B3: re-running migrate is a no-op", again === after);
  await sql.end();
}

for (const db of ["icos_mig_empty_test", "icos_mig_upgrade_test"])
  await admin.unsafe(`drop database if exists ${db}`);
await admin.end();
rmSync(through0047, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\nMIGRATION PROOFS: ${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
