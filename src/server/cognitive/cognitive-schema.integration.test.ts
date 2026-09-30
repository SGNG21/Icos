import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createDatabase } from "@/server/database/client";
import { sql } from "drizzle-orm";
import * as schema from "@/server/cognitive/schema";

const TEST_DB_URL = process.env.ICOS_TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("ICOS_TEST_DATABASE_URL is not set");
}

let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  db = createDatabase(TEST_DB_URL, { max: 12 });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.db.execute(sql`
    TRUNCATE TABLE
      ${schema.cognitiveEvents},
      ${schema.cognitiveContextSnapshots},
      ${schema.cognitiveTurnRefs},
      ${schema.cognitiveTurns},
      ${schema.cognitiveParticipants},
      ${schema.cognitiveConversations},
      ${schema.memoryRecords},
      ${schema.memoryEntities},
      ${schema.memoryRelations}
    CASCADE
  `);
});

/** Matches the PostgreSQL error (message or constraint) behind drizzle's "Failed query" wrapper. */
function pgError(re: RegExp) {
  return (error: unknown): boolean => {
    for (
      let e = error as { message?: string; constraint_name?: string; cause?: unknown } | undefined;
      e;
      e = e.cause as typeof e
    ) {
      if (re.test(e.message ?? "") || re.test(e.constraint_name ?? "")) return true;
    }
    return false;
  };
}

/* Helper to insert a minimal conversation */
async function insertConversation(id: string = "conv-1") {
  await db.db.insert(schema.cognitiveConversations).values({
    id,
    tenantId: "default",
    ownerUserId: "user-1",
    title: "Test Conversation",
    status: "active",
    nextTurnSeq: 1,
    nextEventSeq: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/* Helper to insert a minimal turn */
async function insertTurn(
  id: string = "turn-1",
  conversationId: string = "conv-1",
  seq: number = 1,
  role: "user" | "assistant" = "user",
  authorKind: "human" | "icos" | "agent" = "human",
  authorId: string = "user-1",
  content: any = { text: "hello" },
  status: "received" | "processing" | "completed" | "failed" | "cancelled" = "received",
  idempotencyKey?: string,
) {
  // For user turns, idempotency_key is required (not null)
  const finalIdempotencyKey = role === "user" ? (idempotencyKey ?? `${id}-key`) : idempotencyKey;
  await db.db.insert(schema.cognitiveTurns).values({
    id,
    tenantId: "default",
    conversationId,
    seq,
    role,
    authorKind,
    authorId,
    content: JSON.stringify(content),
    status,
    idempotencyKey: finalIdempotencyKey,
    createdAt: new Date(),
  });
}

/* Helper to insert a minimal memory entity */
async function insertEntity(id: string = "ent-1", kind: "person" | "company" = "person") {
  await db.db.insert(schema.memoryEntities).values({
    id,
    tenantId: "default",
    kind,
    key: `key-${id}`,
    name: `Entity ${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("cognitive schema guards", () => {
  test("cognitive_events: UPDATE and DELETE are rejected", async () => {
    await insertConversation();
    await db.db.insert(schema.cognitiveEvents).values({
      conversationId: "conv-1",
      seq: 1,
      tenantId: "default",
      type: "test",
      payload: JSON.stringify({}),
      createdAt: new Date(),
    });

    // UPDATE should fail
    await expect(
      db.db
        .update(schema.cognitiveEvents)
        .set({ type: "updated" })
        .where(
          sql`${schema.cognitiveEvents.seq} = 1 AND ${schema.cognitiveEvents.conversationId} = 'conv-1'`,
        )
        .execute(),
    ).rejects.toSatisfy(pgError(/append-only/));

    // DELETE should fail
    await expect(
      db.db
        .delete(schema.cognitiveEvents)
        .where(
          sql`${schema.cognitiveEvents.seq} = 1 AND ${schema.cognitiveEvents.conversationId} = 'conv-1'`,
        )
        .execute(),
    ).rejects.toSatisfy(pgError(/append-only/));
  });

  test("cognitive_context_snapshots: UPDATE rejected", async () => {
    await insertConversation();
    const turnId = "turn-1";
    await insertTurn(
      turnId,
      "conv-1",
      1,
      "assistant",
      "human",
      "user-1",
      { text: "hello" },
      "completed",
    );
    await db.db.insert(schema.cognitiveContextSnapshots).values({
      id: "snap-1",
      tenantId: "default",
      conversationId: "conv-1",
      turnId,
      policyVersion: "1",
      scope: JSON.stringify({}),
      items: JSON.stringify([]),
      excluded: JSON.stringify([]),
      tokenBudget: 100,
      tokensUsed: 50,
      contentHash: "hash",
      createdAt: new Date(),
    });

    await expect(
      db.db
        .update(schema.cognitiveContextSnapshots)
        .set({ tokenBudget: 200 })
        .where(sql`${schema.cognitiveContextSnapshots.id} = 'snap-1'`)
        .execute(),
    ).rejects.toSatisfy(pgError(/append-only/));
  });

  test("cognitive_turns: changing content of an existing turn rejected", async () => {
    await insertConversation();
    await insertTurn(
      "turn-1",
      "conv-1",
      1,
      "user",
      "human",
      "user-1",
      { text: "original" },
      "received",
    );

    await expect(
      db.db
        .update(schema.cognitiveTurns)
        .set({ content: JSON.stringify({ text: "changed" }) })
        .where(sql`${schema.cognitiveTurns.id} = 'turn-1'`)
        .execute(),
    ).rejects.toSatisfy(pgError(/immutable/));
  });

  test("cognitive_turns: changing status of a 'completed' turn rejected", async () => {
    await insertConversation();
    await insertTurn(
      "turn-1",
      "conv-1",
      1,
      "assistant",
      "human",
      "user-1",
      { text: "hello" },
      "completed",
    );

    await expect(
      db.db
        .update(schema.cognitiveTurns)
        .set({ status: "failed" })
        .where(sql`${schema.cognitiveTurns.id} = 'turn-1'`)
        .execute(),
    ).rejects.toSatisfy(pgError(/terminal/));
  });

  test("cognitive_turns: DELETE rejected", async () => {
    await insertConversation();
    await insertTurn(
      "turn-1",
      "conv-1",
      1,
      "assistant",
      "human",
      "user-1",
      { text: "hello" },
      "received",
    );

    await expect(
      db.db
        .delete(schema.cognitiveTurns)
        .where(sql`${schema.cognitiveTurns.id} = 'turn-1'`)
        .execute(),
    ).rejects.toSatisfy(pgError(/append-only/));
  });

  test("cognitive_turns: second user turn in status 'received' for same conversation rejected", async () => {
    await insertConversation();
    await insertTurn(
      "turn-1",
      "conv-1",
      1,
      "user",
      "human",
      "user-1",
      { text: "hello" },
      "received",
      "key-1",
    );
    // Second user turn in received/processing should fail due to unique index
    await expect(
      db.db.insert(schema.cognitiveTurns).values({
        id: "turn-2",
        tenantId: "default",
        conversationId: "conv-1",
        seq: 2,
        role: "user",
        authorKind: "human",
        authorId: "user-1",
        content: JSON.stringify({ text: "second" }),
        status: "received",
        idempotencyKey: "key-2",
        createdAt: new Date(),
      }),
    ).rejects.toSatisfy(pgError(/cognitive_turns_one_inflight/));
  });

  test("cognitive_turns: user turn without idempotency_key rejected", async () => {
    await insertConversation();
    await expect(
      db.db.insert(schema.cognitiveTurns).values({
        id: "turn-1",
        tenantId: "default",
        conversationId: "conv-1",
        seq: 1,
        role: "user",
        authorKind: "human",
        authorId: "user-1",
        content: JSON.stringify({ text: "no key" }),
        status: "received",
        // idempotencyKey intentionally omitted
        createdAt: new Date(),
      }),
    ).rejects.toSatisfy(pgError(/cognitive_turns_user_key_check/));
  });

  test("memory_records: MODEL_INFERRED with statement_kind 'fact' rejected", async () => {
    await insertEntity();
    await expect(
      db.db.insert(schema.memoryRecords).values({
        id: "rec-1",
        tenantId: "default",
        type: "semantic",
        subjectKey: "subj-1",
        entityId: "ent-1",
        content: "some fact",
        epistemic: "MODEL_INFERRED",
        statementKind: "fact",
        status: "active",
        confidence: 0.8,
        originTrust: "trusted",
        provenance: JSON.stringify({}),
        sensitivity: "normal",
        retention: "standard",
        validFrom: new Date(),
        recordedBy: "test",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toSatisfy(pgError(/memory_records_model_not_fact_check/));
  });

  test("memory_records: origin_trust 'untrusted' with statement_kind 'instruction' rejected", async () => {
    await insertEntity();
    await expect(
      db.db.insert(schema.memoryRecords).values({
        id: "rec-1",
        tenantId: "default",
        type: "semantic",
        subjectKey: "subj-1",
        entityId: "ent-1",
        content: "do something",
        epistemic: "USER_ASSERTED",
        statementKind: "instruction",
        status: "candidate", // isolate this guard from the review CHECK
        confidence: 0.8,
        originTrust: "untrusted",
        provenance: JSON.stringify({}),
        sensitivity: "normal",
        retention: "standard",
        validFrom: new Date(),
        recordedBy: "test",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toSatisfy(pgError(/memory_records_untrusted_instruction_check/));
  });

  test("memory_records: changing content rejected unless status becomes 'deleted' with content '[deleted]'", async () => {
    await insertEntity();
    await db.db.insert(schema.memoryRecords).values({
      id: "rec-1",
      tenantId: "default",
      type: "semantic",
      subjectKey: "subj-1",
      entityId: "ent-1",
      content: "original content",
      epistemic: "USER_ASSERTED",
      statementKind: "fact",
      status: "active",
      confidence: 0.8,
      originTrust: "trusted",
      provenance: JSON.stringify({}),
      sensitivity: "normal",
      retention: "standard",
      validFrom: new Date(),
      recordedBy: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Changing content to something else should fail
    await expect(
      db.db
        .update(schema.memoryRecords)
        .set({ content: "new content", status: "active" })
        .where(sql`${schema.memoryRecords.id} = 'rec-1'`)
        .execute(),
    ).rejects.toSatisfy(pgError(/content is immutable/));

    // Changing content to '[deleted]' and status to 'deleted' should succeed
    await expect(
      db.db
        .update(schema.memoryRecords)
        .set({ content: "[deleted]", status: "deleted" })
        .where(sql`${schema.memoryRecords.id} = 'rec-1'`)
        .execute(),
    ).resolves.toBeDefined();
  });

  test("memory_records: DELETE rejected", async () => {
    await insertEntity();
    await db.db.insert(schema.memoryRecords).values({
      id: "rec-1",
      tenantId: "default",
      type: "semantic",
      subjectKey: "subj-1",
      entityId: "ent-1",
      content: "some content",
      epistemic: "USER_ASSERTED",
      statementKind: "fact",
      status: "active",
      confidence: 0.8,
      originTrust: "trusted",
      provenance: JSON.stringify({}),
      sensitivity: "normal",
      retention: "standard",
      validFrom: new Date(),
      recordedBy: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      db.db
        .delete(schema.memoryRecords)
        .where(sql`${schema.memoryRecords.id} = 'rec-1'`)
        .execute(),
    ).rejects.toSatisfy(pgError(/append-only/));
  });

  test("memory_records: two 'active' semantic records with same tenant/type/subject_key/client rejected", async () => {
    await insertEntity("ent-1");
    await insertEntity("ent-2"); // different entity, same client

    await db.db.insert(schema.memoryRecords).values({
      id: "rec-1",
      tenantId: "default",
      type: "semantic",
      subjectKey: "subj-1",
      entityId: "ent-1",
      content: "first",
      epistemic: "USER_ASSERTED",
      statementKind: "fact",
      status: "active",
      confidence: 0.8,
      originTrust: "trusted",
      provenance: JSON.stringify({}),
      sensitivity: "normal",
      retention: "standard",
      validFrom: new Date(),
      clientId: "client-1",
      recordedBy: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      db.db.insert(schema.memoryRecords).values({
        id: "rec-2",
        tenantId: "default",
        type: "semantic",
        subjectKey: "subj-1", // same subject key
        entityId: "ent-2",
        content: "second",
        epistemic: "USER_ASSERTED",
        statementKind: "fact",
        status: "active",
        confidence: 0.8,
        originTrust: "trusted",
        provenance: JSON.stringify({}),
        sensitivity: "normal",
        retention: "standard",
        validFrom: new Date(),
        clientId: "client-1", // same client
        recordedBy: "test",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toSatisfy(pgError(/memory_records_one_active/));
  });

  test("memory_records: same subject for a DIFFERENT client_id accepted", async () => {
    await insertEntity("ent-1");
    await insertEntity("ent-2");

    await db.db.insert(schema.memoryRecords).values({
      id: "rec-1",
      tenantId: "default",
      type: "semantic",
      subjectKey: "subj-1",
      entityId: "ent-1",
      content: "first",
      epistemic: "USER_ASSERTED",
      statementKind: "fact",
      status: "active",
      confidence: 0.8,
      originTrust: "trusted",
      provenance: JSON.stringify({}),
      sensitivity: "normal",
      retention: "standard",
      validFrom: new Date(),
      clientId: "client-1",
      recordedBy: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Different client should be allowed
    await expect(
      db.db.insert(schema.memoryRecords).values({
        id: "rec-2",
        tenantId: "default",
        type: "semantic",
        subjectKey: "subj-1",
        entityId: "ent-2",
        content: "second",
        epistemic: "USER_ASSERTED",
        statementKind: "fact",
        status: "active",
        confidence: 0.8,
        originTrust: "trusted",
        provenance: JSON.stringify({}),
        sensitivity: "normal",
        retention: "standard",
        validFrom: new Date(),
        clientId: "client-2", // different client
        recordedBy: "test",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  test("memory_records: two active 'episodic' records with same subject accepted", async () => {
    await insertEntity("ent-1");
    await insertEntity("ent-2");

    await db.db.insert(schema.memoryRecords).values({
      id: "rec-1",
      tenantId: "default",
      type: "episodic",
      subjectKey: "subj-1",
      entityId: "ent-1",
      content: "first episodic",
      epistemic: "USER_ASSERTED",
      statementKind: "fact",
      status: "active",
      confidence: 0.8,
      originTrust: "trusted",
      provenance: JSON.stringify({}),
      sensitivity: "normal",
      retention: "standard",
      validFrom: new Date(),
      recordedBy: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Same subject, different entity, same type episodic should be allowed (unique index excludes episodic)
    await expect(
      db.db.insert(schema.memoryRecords).values({
        id: "rec-2",
        tenantId: "default",
        type: "episodic",
        subjectKey: "subj-1",
        entityId: "ent-2",
        content: "second episodic",
        epistemic: "USER_ASSERTED",
        statementKind: "fact",
        status: "active",
        confidence: 0.8,
        originTrust: "trusted",
        provenance: JSON.stringify({}),
        sensitivity: "normal",
        retention: "standard",
        validFrom: new Date(),
        recordedBy: "test",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  test("memory_relations: from_entity_id = to_entity_id rejected", async () => {
    await insertEntity("ent-1");

    await expect(
      db.db.insert(schema.memoryRelations).values({
        id: "rel-1",
        tenantId: "default",
        fromEntityId: "ent-1",
        toEntityId: "ent-1", // same entity
        type: "RELATED_TO",
        epistemic: "USER_ASSERTED",
        confidence: 0.8,
        sourceId: "src-1",
        validFrom: new Date(),
        createdAt: new Date(),
      }),
    ).rejects.toSatisfy(pgError(/memory_relations_no_self_check/));
  });
});
