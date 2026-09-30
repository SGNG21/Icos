/**
 * Real process-restart proof helper (decision 0057). Run as a CHILD process by
 * cognitive-runtime.integration.test.ts: it creates a conversation, submits a turn whose
 * model call never returns, and hard-exits (no cleanup) once the turn is durably
 * `processing` — exactly what a crashed server leaves behind.
 *
 * argv: <tenantId> <userId>. Prints `CONVERSATION <id>` then exits with code 137.
 */
import { buildCognitiveRuntime } from "../index";
import { openTestDb, ScriptedCognitionEngine } from "./support";

async function main(): Promise<void> {
  const [tenantId, userId] = process.argv.slice(2);
  const handle = openTestDb();
  const hang = new ScriptedCognitionEngine(() => new Promise(() => {}));
  const runtime = buildCognitiveRuntime(handle.db, { engine: hang, operational: null });
  const actor = { tenantId, userId, roles: ["operator"] };
  const conversation = await runtime.createConversation(actor, { title: "crash" });
  process.stdout.write(`CONVERSATION ${conversation.id}\n`);
  void runtime.submitTurn(actor, conversation.id, {
    text: "analyse avant crash",
    idempotencyKey: "crash-key-0001",
  });
  for (;;) {
    const rows =
      await handle.sql`select status from cognitive_turns where conversation_id = ${conversation.id}`;
    if (rows.some((r) => r.status === "processing")) process.exit(137);
    await new Promise((r) => setTimeout(r, 50));
  }
}

void main();
