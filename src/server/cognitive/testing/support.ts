import { sql } from "drizzle-orm";

import type { CognitionOutput } from "@/core/cognitive/contracts";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import type { CognitionEngine, CognitionInput } from "../cognition";

/** Test-only engine: returns scripted outputs and records every input it was given. */
export class ScriptedCognitionEngine implements CognitionEngine {
  readonly label = "scripted-test-engine";
  readonly inputs: CognitionInput[] = [];
  constructor(
    private readonly script: (
      input: CognitionInput,
      signal: AbortSignal,
    ) => CognitionOutput | Promise<CognitionOutput>,
  ) {}
  async think(input: CognitionInput, signal: AbortSignal): Promise<CognitionOutput> {
    this.inputs.push(input);
    return await this.script(input, signal);
  }
}

export const answer = (text: string, extra: Partial<CognitionOutput> = {}): CognitionOutput => ({
  result: { kind: "ANSWER_ONLY", text },
  memorySuggestions: [],
  ...extra,
});

export function openTestDb(): DatabaseHandle {
  return createDatabase(TEST_DATABASE_URL, { max: 12 });
}

/** TRUNCATE ignores the append-only row triggers: test databases only. */
export async function resetCognitive(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(
    sql`TRUNCATE TABLE cognitive_events, cognitive_context_snapshots, cognitive_turn_refs, cognitive_turns,
        cognitive_participants, cognitive_conversations, memory_records, memory_relations, memory_entities,
        memory_retrieval_log, goal_previews, goals, missions RESTART IDENTITY CASCADE`,
  );
}
