/**
 * Real process-restart proof for client-context resolution (decision 0062). Run as a CHILD
 * process by client-context.integration.test.ts: it creates a conversation, submits ONE turn
 * that resolves a client, and hard-exits without any cleanup — exactly what a crashed server
 * leaves behind. The parent then proves the resolved scope is still there.
 *
 * argv: <tenantId> <userId> <text>. Prints `CONVERSATION <id>` then exits with code 137.
 */
import { buildCognitiveRuntime } from "../index";
import { answer, openTestDb, ScriptedCognitionEngine } from "./support";

async function main(): Promise<void> {
  const [tenantId, userId, text] = process.argv.slice(2);
  const handle = openTestDb();
  const runtime = buildCognitiveRuntime(handle.db, {
    engine: new ScriptedCognitionEngine(() => answer("ok")),
    operational: null,
    missions: null,
  });
  const actor = { tenantId, userId, roles: ["owner"] };
  const conversation = await runtime.createConversation(actor, { title: "crash-resolution" });
  process.stdout.write(`CONVERSATION ${conversation.id}\n`);
  await runtime.submitTurn(actor, conversation.id, { text, idempotencyKey: "crash-resolve-0001" });
  // Everything is committed; die without closing the pool, as a crash would.
  process.exit(137);
}

void main();
