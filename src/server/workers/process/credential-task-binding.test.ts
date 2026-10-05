import { describe, expect, it } from "vitest";

import { brokerCredentials, type CredentialCapability } from "./credential-broker";

/**
 * A CREDENTIAL IS GRANTED TO A TASK, not to a program.
 *
 * Capabilities were keyed by command — `hermes:.hermes/auth.json` — so every task served
 * by the same executor received the same grant and the audit could not say which task
 * had been given what. The file's own rule already said otherwise ("une CAPACITÉ,
 * accordée à une tâche précise… le temps d'une exécution"); the binding is what makes
 * that checkable rather than aspirational.
 */
const binding = { taskId: "task-a", workflowId: "icos-task-task-a", executor: "hermes" } as const;

const capability = (taskId: string): CredentialCapability => ({
  id: `${taskId}:hermes:.hermes/auth.json`,
  kind: "file",
  target: ".hermes/auth.json",
});

const resolver = () => "secret-value";

describe("credential grants are bound to one task", () => {
  it("CREDENTIAL_SCOPE_TASK_BOUND: the grant records the task, workflow and executor", () => {
    const outcome = brokerCredentials([capability("task-a")], resolver, () => "T0", binding);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.grants[0]!.boundTo).toEqual(binding);
    /* Still no field that could carry the value — that is the type, not a discipline. */
    expect(JSON.stringify(outcome.grants)).not.toContain("secret-value");
  });

  it("CROSS_TASK_CREDENTIAL_REUSE_BLOCKED: task A's capability is refused for task B", () => {
    /* Exactly the replay: B presents the capability prepared for A. */
    const outcome = brokerCredentials([capability("task-a")], resolver, () => "T0", {
      ...binding,
      taskId: "task-b",
      workflowId: "icos-task-task-b",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("CREDENTIAL_TARGET_REJECTED");
    expect(outcome.missing).toContain("task-a:hermes:.hermes/auth.json");
  });

  it("refuses the foreign capability without leaking the one it would have granted", () => {
    const outcome = brokerCredentials(
      [capability("task-a"), capability("task-b")],
      resolver,
      () => "T0",
      { ...binding, taskId: "task-b", workflowId: "icos-task-task-b" },
    );

    /* One refusal poisons the batch: a partial grant is still a grant it may not have. */
    expect(outcome.ok).toBe(false);
  });

  it("an unbound caller keeps the previous behaviour exactly", () => {
    /* Callers that broker outside a task predate this lock and are not broken by it. */
    const outcome = brokerCredentials([capability("task-a")], resolver, () => "T0");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.grants[0]!.boundTo).toBeUndefined();
  });

  it("still refuses a target that would escape the disposable HOME", () => {
    const outcome = brokerCredentials(
      [{ id: "task-a:hermes:escape", kind: "file", target: "../../etc/passwd" }],
      resolver,
      () => "T0",
      binding,
    );

    expect(outcome.ok).toBe(false);
  });
});
