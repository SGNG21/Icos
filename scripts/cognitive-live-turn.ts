/**
 * ONE real, non-destructive Cognitive turn through OmniRoute (decision 0056).
 *
 * Requires OMNIROUTE_BASE_URL, OMNIROUTE_API_KEY, ICOS_COGNITIVE_MODEL and a TEST database
 * (ICOS_TEST_DATABASE_URL, migrated with `pnpm test:db:setup`). Prints NOT_CONFIGURED and
 * exits 2 when anything is missing. Never prints a secret: only the model names, ids,
 * timings, event types and the result kind/length.
 *
 *   ICOS_TEST_DATABASE_URL=postgres://$USER@localhost:5432/icos_cognitive_test \
 *   OMNIROUTE_BASE_URL=… OMNIROUTE_API_KEY=… ICOS_COGNITIVE_MODEL=… \
 *   pnpm exec tsx scripts/cognitive-live-turn.ts
 */
import { randomUUID } from "node:crypto";

import { createDatabase } from "../src/server/database/client";
import {
  TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "../src/server/database/test-database-guard";
import { OmniRouteCognitionEngine } from "../src/server/cognitive/cognition";
import { buildCognitiveRuntime } from "../src/server/cognitive/index";

async function main(): Promise<void> {
  const base = process.env.OMNIROUTE_BASE_URL;
  const key = process.env.OMNIROUTE_API_KEY;
  const model = process.env.ICOS_COGNITIVE_MODEL;
  if (!base || !key || !model || !process.env.ICOS_TEST_DATABASE_URL) {
    console.log(
      JSON.stringify({
        LIVE_OMNIROUTE_TURN: "NOT_CONFIGURED",
        missing: [
          !base && "OMNIROUTE_BASE_URL",
          !key && "OMNIROUTE_API_KEY",
          !model && "ICOS_COGNITIVE_MODEL",
          !process.env.ICOS_TEST_DATABASE_URL && "ICOS_TEST_DATABASE_URL",
        ].filter(Boolean),
      }),
    );
    process.exit(2);
  }
  assertSafeTestDatabaseUrl(TEST_DATABASE_URL);

  let effectiveModel: string | null = null;
  const observingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const clone = response.clone();
    effectiveModel =
      ((await clone.json().catch(() => null)) as { model?: string } | null)?.model ?? null;
    return response;
  };
  const handle = createDatabase(TEST_DATABASE_URL, { max: 2 });
  try {
    const engine = new OmniRouteCognitionEngine(
      base.replace(/\/+$/, ""),
      key,
      model,
      observingFetch,
    );
    const runtime = buildCognitiveRuntime(handle.db, { engine, operational: null });
    const actor = { tenantId: "default", userId: "live-turn-probe", roles: ["operator"] };
    const conversation = await runtime.createConversation(actor, { title: "Live OmniRoute probe" });
    const started = Date.now();
    const result = await runtime.submitTurn(actor, conversation.id, {
      text: "Présente-toi en une phrase. Ne propose aucune mission ni action.",
      idempotencyKey: `live-${randomUUID()}`,
    });
    const latencyMs = Date.now() - started;
    const events = await runtime.events(actor, conversation.id, 0);
    console.log(
      JSON.stringify(
        {
          LIVE_OMNIROUTE_TURN: result.turn.status === "completed" ? "COMPLETED" : "FAILED",
          requestedModel: model,
          effectiveModel,
          latencyMs,
          conversationId: conversation.id,
          turnId: result.turn.id,
          outcome: result.turn.outcome,
          failureReason: result.turn.failureReason,
          replyChars: result.reply?.content.parts[0].text.length ?? 0,
          eventSequence: events.map((e) => `${e.seq}:${e.type}`),
        },
        null,
        2,
      ),
    );
  } finally {
    await handle.close();
  }
}

void main();
