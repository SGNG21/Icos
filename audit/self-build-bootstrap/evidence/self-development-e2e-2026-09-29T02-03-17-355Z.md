# SELF_DEVELOPMENT_E2E — durable evidence
Written by the run itself, from database rows, at 2026-09-29T02:10:09.347Z.
Started: 2026-09-29T02:03:17.355Z
Database: postgres://coco@localhost:5432/icos_test_selfbuild
Repository: /tmp/claude-501/sdrepo @ integration/phase-7
## 0. Input
An ImprovementCandidate was supplied (`imp-bd2ae494a04637b8`). No goal, mission, task, plan, worker, review, approval or integration call was supplied.
## 1. Candidate
```json
[
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1790647397343",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"proposed\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-09-29T02:03:17.343Z\",\"reviewedAt\":null,\"reviewedBy\":null,\"reviewNotes\":null,\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-09-29T02:03:17.343Z\",\"updatedAt\":\"2026-09-29T02:03:17.343Z\"}",
    "contentReference": null,
    "createdAt": "2026-09-29 04:03:17.343+02"
  },
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1790647397374",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"under_review\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-09-29T02:03:17.343Z\",\"reviewedAt\":\"2026-09-29T02:03:17.374Z\",\"reviewedBy\":\"self-development-chain\",\"reviewNotes\":\"selected for self-development: goal sd-goal-548e0fd6da8b5c82, mission sd-mission-548e0fd6da8b5c82\",\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-09-29T02:03:17.343Z\",\"updatedAt\":\"2026-09-29T02:03:17.374Z\"}",
    "contentReference": null,
    "createdAt": "2026-09-29 04:03:17.343+02"
  },
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1790647809306",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"approved\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-09-29T02:03:17.343Z\",\"reviewedAt\":\"2026-09-29T02:10:09.306Z\",\"reviewedBy\":\"self-development-coordinator\",\"reviewNotes\":\"INTEGRATION_APPLIED:INTEGRATED\",\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-09-29T02:03:17.343Z\",\"updatedAt\":\"2026-09-29T02:10:09.306Z\"}",
    "contentReference": null,
    "createdAt": "2026-09-29 04:03:17.343+02"
  }
]
```
## 2. Goal
```json
{
  "id": "sd-goal-548e0fd6da8b5c82",
  "title": "Document the worker branch lifecycle",
  "objective": "Document the worker branch lifecycle. Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target. The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\nTarget path: docs/",
  "rawInput": "The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.",
  "normalizedIntent": "Document the worker branch lifecycle. Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target. The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\nTarget path: docs/",
  "constraints": [],
  "successCriteria": [],
  "priority": 3,
  "riskLevel": "reversible",
  "allowedCapabilities": [],
  "forbiddenCapabilities": [],
  "humanApprovalPolicy": "if_risky",
  "metadata": {
    "source": "self-development",
    "category": "maintainability",
    "candidateId": "imp-bd2ae494a04637b8",
    "targetComponent": "docs"
  },
  "createdAt": "2026-09-29T02:03:17.377Z"
}
```
## 3. Mission
```json
{
  "id": "sd-mission-548e0fd6da8b5c82",
  "title": "Document the worker branch lifecycle",
  "objective": "Document the worker branch lifecycle. Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target. The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\nTarget path: docs/",
  "status": "draft",
  "goalId": "sd-goal-548e0fd6da8b5c82",
  "planId": "d8928dbd-ae43-4b7a-813c-64221bc5e953",
  "createdAt": "2026-09-29T02:03:17.383Z",
  "updatedAt": "2026-09-29T02:04:46.698Z"
}
```
## 4. Plan and DAG
```json
{
  "id": "a7317f01-1c24-4fdf-8a4e-18d9801cbfd6",
  "mission_id": "sd-mission-548e0fd6da8b5c82",
  "goal_id": "sd-goal-548e0fd6da8b5c82",
  "plan_id": "d8928dbd-ae43-4b7a-813c-64221bc5e953",
  "plan_fingerprint": "4e2cc201d3163445b02f31377b64cf4f71d137fd5ef8fccb983f8a22a660d95c",
  "version": 1,
  "predecessor_plan_id": null,
  "created_at": "2026-09-29 04:04:46.698+02"
}
```
```json
[
  {
    "missionTaskId": "50908b25-c2e2-4c8f-9912-2355ef70e7cc",
    "taskId": "task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "title": "Document worker branch lifecycle",
    "status": "succeeded",
    "dependsOn": [],
    "canonical": {
      "id": "task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
      "title": "Document worker branch lifecycle",
      "description": "Add a short note in docs/ describing the worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.",
      "status": "queued",
      "actionIds": [],
      "createdAt": "2026-09-29T02:04:46.714Z",
      "updatedAt": "2026-09-29T02:04:46.740Z",
      "missionId": "sd-mission-548e0fd6da8b5c82",
      "goalId": "sd-goal-548e0fd6da8b5c82",
      "planId": "d8928dbd-ae43-4b7a-813c-64221bc5e953",
      "objective": "Document worker branch lifecycle",
      "instructions": "Add a short note in docs/ describing the worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.",
      "dependencies": [],
      "successCriteria": [
        "File docs/worker-branch-lifecycle.md exists with content describing the lifecycle"
      ],
      "requiredCapabilities": [],
      "riskClass": "reversible",
      "allowedFileScope": [
        "docs/"
      ],
      "expectedArtifacts": [
        "docs/worker-branch-lifecycle.md"
      ],
      "priority": 2,
      "attemptBudget": 3,
      "reviewPolicy": "if_risky",
      "integrationPolicy": ""
    }
  }
]
```
## 5. Dispatch attempts — routing, worker identity, lease
```json
[
  {
    "id": "1b0f670d-e291-4fb5-871a-ed7fdab7b03d",
    "mission_task_id": "50908b25-c2e2-4c8f-9912-2355ef70e7cc",
    "task_id": "task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "workflow_id": "icos-task-task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "attempt": 1,
    "state": "dispatched",
    "worker_kind": "agent",
    "worker_id": "11111111-1111-4111-8111-111111111111",
    "capability": null,
    "dispatched_at": "2026-09-29 04:06:27.612+02",
    "execution_lease_owner": "icos-runner-d1740d0e-4dcd-4773-a9f2-9b82c7158ce3",
    "execution_lease_until": "2026-09-29 04:24:47.33+02",
    "failure_class": null,
    "created_at": "2026-09-29 04:04:46.74+02",
    "updated_at": "2026-09-29 04:06:27.612+02"
  }
]
```
## 6. Governed workspaces
```json
[
  {
    "workspaceId": "4aba2ff4-6383-4cf2-91d0-4184b9b63ef7",
    "workerId": "11111111-1111-4111-8111-111111111111",
    "missionId": "sd-mission-548e0fd6da8b5c82",
    "taskId": "task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "slug": "document_worker_br_task3041",
    "branch": "ws/document_worker_br_task3041",
    "worktreePath": "/private/var/folders/n6/hj0j2q093vg_23sfftptlfp80000gn/T/icos-selfdev-inXqOR/document_worker_br_task3041",
    "baseCommit": "fff87817ac94f96140b29ae20f4f22672e6a1ad8",
    "integrationTarget": "integration/phase-7",
    "fileScope": {
      "owns": [
        "docs/"
      ],
      "shared": [],
      "forbidden": [
        ".env.local",
        "**/.env.local",
        ".env.*.local",
        "secrets/**",
        "**/*.pem"
      ]
    },
    "migrationReservation": null,
    "status": "accepted",
    "leaseOwner": null,
    "leaseExpiresAt": null,
    "fencingToken": 1,
    "workflowId": "icos-task-task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "createdAt": "2026-09-29T02:04:46.798Z",
    "updatedAt": "2026-09-29T02:10:05.938Z",
    "releasedAt": "2026-09-29T02:10:05.938Z",
    "sourceCommit": "f7222c258196a0f916a439d787904d5373fcdd4d",
    "testDatabase": "icos_test_document_worker_br_task3041"
  }
]
```
## 7. Execution results
```json
[
  {
    "id": "texec-b226a304-4790-45a7-aa7d-f0da6553fc4a",
    "task_id": "task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "workflow_id": "icos-task-task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "outcome": "success",
    "worker_kind": "agent",
    "capability": null,
    "error_code": null,
    "error_message": null,
    "started_at": null,
    "completed_at": "2026-09-29 04:06:27.591+02",
    "artifacts": [
      {
        "path": "ws/document_worker_br_task3041",
        "type": "git-branch",
        "metadata": {
          "dirty": false,
          "commits": [
            "f7222c258196a0f916a439d787904d5373fcdd4d"
          ],
          "commitHash": "f7222c258196a0f916a439d787904d5373fcdd4d",
          "changedFiles": [
            "docs/WORKER_BRANCH_LIFECYCLE.md"
          ]
        }
      }
    ],
    "evidence": [
      {
        "type": "worker-identity",
        "source": "11111111-1111-4111-8111-111111111111",
        "metadata": {
          "model": "writer-model",
          "account": "self-dev-writer-account",
          "runtime": "binary",
          "provider": "self-dev-writer-provider",
          "workerId": "11111111-1111-4111-8111-111111111111"
        },
        "timestamp": "2026-09-29T02:06:27.591Z"
      },
      {
        "type": "change-diff",
        "source": "11111111-1111-4111-8111-111111111111",
        "metadata": {
          "diff": "diff --git a/docs/WORKER_BRANCH_LIFECYCLE.md b/docs/WORKER_BRANCH_LIFECYCLE.md\nnew file mode 100644\nindex 0000000..092deef\n--- /dev/null\n+++ b/docs/WORKER_BRANCH_LIFECYCLE.md\n@@ -0,0 +1,3 @@\n+# Worker Branch Lifecycle\n+\n+A worker branch is created for each writer attempt. If a run is rejected, the worker branch is kept (not deleted). Once the commits from the worker branch are contained in the integration target (e.g., main), the branch is reaped (deleted).",
          "branch": "ws/document_worker_br_task3041",
          "truncated": false,
          "commitHash": "f7222c258196a0f916a439d787904d5373fcdd4d"
        },
        "timestamp": "2026-09-29T02:06:27.591Z"
      },
      {
        "type": "worker-process",
        "source": "11111111-1111-4111-8111-111111111111",
        "metadata": {
          "signal": null,
          "exitCode": 0,
          "timedOut": false,
          "durationMs": 100188,
          "stderrTail": "",
          "stdoutTail": "<<<ICOS_RESULT>>>\n{\n  \"status\": \"succeeded\",\n  \"summary\": \"Added docs/WORKER_BRANCH_LIFECYCLE.md documenting the worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\n  \"unresolved\": [],\n  \"testsRun\": []\n}\n<<<END_ICOS_RESULT>>>\n"
        },
        "timestamp": "2026-09-29T02:06:27.591Z"
      }
    ],
    "findings": null,
    "observations": null,
    "confidence": null
  }
]
```
## 8. Independent review
```json
[
  {
    "id": "review-1790647599447-y5fds07i6",
    "taskId": "task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "workflowId": "icos-task-task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
    "decision": "APPROVE",
    "reviewerKind": "llm",
    "severity": "info",
    "reasons": [
      "The worker branch lifecycle documentation has been successfully created at docs/WORKER_BRANCH_LIFECYCLE.md with content matching the requirements: describes creation per writer attempt, retention on rejected runs, and reaping when commits are contained in the integration target.",
      "The execution evidence shows a successful worker process with exit code 0, no stderr, and the expected ICOS result structure indicating success.",
      "The change diff confirms a new file was added with the exact required content, no extra modifications, and the branch is clean.",
      "All constraints and objectives from the mission task are satisfied: short note added to docs/ covering the specified lifecycle points.",
      "No quality issues detected in the output; the note is concise, accurate, and addresses the non-obvious reaping rule that was the source of a prior defect."
    ],
    "requestedChanges": null,
    "evidenceRefs": [
      "worker-identity",
      "change-diff",
      "worker-process"
    ],
    "providerMetadata": {
      "model": "hermes",
      "provider": "command",
      "temperature": 0
    },
    "confidence": 0.98,
    "createdAt": "2026-09-29 04:06:39.447+02"
  }
]
```
## 9. Gate
Configured gate commands (from `ICOS_GATE_COMMANDS`; an ACCEPT means every one of these
ran and passed inside the governed workspace):
```json
{
  "install": [
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--offline"
  ],
  "typecheck": [
    "pnpm",
    "run",
    "typecheck"
  ],
  "lint": [
    "pnpm",
    "run",
    "lint"
  ],
  "unit": [
    "env",
    "-u",
    "ICOS_SELF_DEV_E2E",
    "-u",
    "ICOS_SELF_BUILD_E2E",
    "pnpm",
    "test"
  ],
  "postgres": [
    [
      "pnpm",
      "run",
      "test:db:setup"
    ],
    [
      "env",
      "-u",
      "ICOS_SELF_DEV_E2E",
      "-u",
      "ICOS_SELF_BUILD_E2E",
      "pnpm",
      "run",
      "test:integration"
    ]
  ],
  "build": [
    "pnpm",
    "build"
  ]
}
```
Coordinator outcome as REPORTED by the run (not a durable row; the durable trace of the
gate is the learned pattern in section 11, whose outcome is derived from its decision):
```json
{
  "candidateId": "imp-bd2ae494a04637b8",
  "missionId": "sd-mission-548e0fd6da8b5c82",
  "missionTaskId": "50908b25-c2e2-4c8f-9912-2355ef70e7cc",
  "taskId": "task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
  "workflowId": "icos-task-task-3041d08c-5b97-4d41-8d96-97cbb161b70a",
  "finalState": "integrated",
  "gateDecision": "ACCEPT",
  "reason": "INTEGRATION_APPLIED:INTEGRATED",
  "repairAttemptsUsed": 0,
  "completedAt": "2026-09-29T02:10:09.303Z"
}
```
## 10. Integration
```
integration/phase-7 before: fff87817ac94f96140b29ae20f4f22672e6a1ad8
integration/phase-7 after:  f7222c258196a0f916a439d787904d5373fcdd4d
```
Commits added to `integration/phase-7` (1):

- `f7222c2 docs: add worker branch lifecycle document`
## 11. Durable learning
```json
[
  {
    "id": "3d797ffa6e9d689f",
    "name": "success: finding:integration_gate",
    "description": "Observed 1 time(s): 1 success.",
    "signature": {
      "findingCategory": "integration_gate"
    },
    "observations": [
      "Review decision: ACCEPT",
      "Finding [info]: IntegrationGate - ACCEPT",
      "Review decision: REJECT",
      "Finding [warning]: IntegrationGate - tests PostgreSQL en échec (pnpm run test:integration) : EV plan: ${missionTasks.length} task(s): ${missionTasks.m… 142| ); 143| expect(missionTasks.length).toBeGreaterThan(0); | ^ 144| 145| /* Every planned task carries a canonical envelope the planner cho… ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
      "Finding [warning]: IntegrationGate - fichiers hors périmètre : WORKER_BRANCH_LIFECYCLE.md",
      "Finding [warning]: IntegrationGate - fichiers hors périmètre : docs/icos/worker-branch-lifecycle.md"
    ],
    "occurrenceCount": 11,
    "lastSeenAt": "2026-09-29T02:10:09.302Z",
    "outcomeCounts": {
      "success": 7,
      "failure": 4,
      "mixed": 0
    },
    "firstSeenAt": "2026-09-28T23:28:51.010Z",
    "createdAt": "2026-09-28T23:28:51.010Z",
    "evidenceRefs": [
      "8ba48dc68b881083823493bcd32d8d5f67f5a012",
      "eb7942c8e8f09da0ed8ef45315dc7d439878a4a1",
      "8875d320cb4d56238e7d2db7a940fa39b30eb0ff",
      "485863917fafb59d345e1da903d3c7c0db74cd2b",
      "46673d5841f80576590b336f0203c88776abf9c4",
      "1895f2e9d75f80827caf61d169edbfddd20a0cb5",
      "c544e3cb47756cc022758497cedcdfed26f9fb17",
      "d5324cb0afb1f3a1df9eabbb017e32464c467fc3",
      "b697c65f19ad965cf7ac827228c1557fa0b70bdc",
      "6560832bdceed86f6b5f2a884b80a4fad9dde06c",
      "f7222c258196a0f916a439d787904d5373fcdd4d"
    ],
    "sourceOutcomeIds": [
      "gate-imp-bd2ae494a04637b8-8ba48dc68b881083823493bcd32d8d5f67f5a012-ACCEPT",
      "gate-imp-bd2ae494a04637b8-eb7942c8e8f09da0ed8ef45315dc7d439878a4a1-ACCEPT",
      "gate-imp-bd2ae494a04637b8-8875d320cb4d56238e7d2db7a940fa39b30eb0ff-ACCEPT",
      "gate-imp-bd2ae494a04637b8-485863917fafb59d345e1da903d3c7c0db74cd2b-REJECT",
      "gate-imp-bd2ae494a04637b8-46673d5841f80576590b336f0203c88776abf9c4-REJECT",
      "gate-imp-bd2ae494a04637b8-1895f2e9d75f80827caf61d169edbfddd20a0cb5-ACCEPT",
      "gate-imp-bd2ae494a04637b8-c544e3cb47756cc022758497cedcdfed26f9fb17-REJECT",
      "gate-imp-bd2ae494a04637b8-d5324cb0afb1f3a1df9eabbb017e32464c467fc3-ACCEPT",
      "gate-imp-bd2ae494a04637b8-b697c65f19ad965cf7ac827228c1557fa0b70bdc-REJECT",
      "gate-imp-bd2ae494a04637b8-6560832bdceed86f6b5f2a884b80a4fad9dde06c-ACCEPT",
      "gate-imp-bd2ae494a04637b8-f7222c258196a0f916a439d787904d5373fcdd4d-ACCEPT"
    ],
    "missionIds": [
      "sd-mission-548e0fd6da8b5c82"
    ],
    "outcome": "success"
  },
  {
    "id": "a10e50cf3424c910",
    "name": "success: default:undefined",
    "description": "Observed 1 time(s): 1 success.",
    "signature": {},
    "observations": [
      "Review decision: APPROVE"
    ],
    "occurrenceCount": 11,
    "lastSeenAt": "2026-09-29T02:06:39.447Z",
    "outcomeCounts": {
      "success": 11,
      "failure": 0,
      "mixed": 0
    },
    "firstSeenAt": "2026-09-28T23:24:59.054Z",
    "createdAt": "2026-09-28T23:24:59.054Z",
    "evidenceRefs": [
      "worker-identity",
      "change-diff",
      "worker-process"
    ],
    "sourceOutcomeIds": [
      "review-review-1790637899054-3d4knuh2j",
      "review-review-1790638233187-x9tzp9p3z",
      "review-review-1790638625770-04c7ojww7",
      "review-review-1790639205973-jv63ubfw4",
      "review-review-1790639722024-1urqob71l",
      "review-review-1790639834905-c9jslqvxt",
      "review-review-1790640205828-obhk2yz02",
      "review-review-1790640583442-tu2pmpyle",
      "review-review-1790644711320-7e6qfi70f",
      "review-review-1790647182363-o9s2apt1r",
      "review-review-1790647599447-y5fds07i6"
    ],
    "missionIds": [
      "sd-mission-548e0fd6da8b5c82"
    ],
    "outcome": "success"
  },
  {
    "id": "43c9f04b5de3bd0d",
    "name": "success: worker:agent",
    "description": "Observed 1 time(s): 1 success. Workers: agent.",
    "signature": {
      "workerKind": "agent"
    },
    "observations": [],
    "occurrenceCount": 12,
    "lastSeenAt": "2026-09-29T02:06:27.599Z",
    "outcomeCounts": {
      "success": 12,
      "failure": 0,
      "mixed": 0
    },
    "firstSeenAt": "2026-09-28T23:24:16.551Z",
    "createdAt": "2026-09-28T23:24:16.551Z",
    "evidenceRefs": [
      "11111111-1111-4111-8111-111111111111:2026-09-28T23:24:16.543Z",
      "11111111-1111-4111-8111-111111111111:2026-09-28T23:30:26.311Z",
      "11111111-1111-4111-8111-111111111111:2026-09-28T23:36:14.074Z",
      "11111111-1111-4111-8111-111111111111:2026-09-28T23:46:08.263Z",
      "11111111-1111-4111-8111-111111111111:2026-09-28T23:54:55.139Z",
      "11111111-1111-4111-8111-111111111111:2026-09-28T23:56:49.897Z",
      "11111111-1111-4111-8111-111111111111:2026-09-29T00:02:47.126Z",
      "11111111-1111-4111-8111-111111111111:2026-09-29T00:09:28.626Z",
      "11111111-1111-4111-8111-111111111111:2026-09-29T00:21:18.441Z",
      "11111111-1111-4111-8111-111111111111:2026-09-29T01:18:02.475Z",
      "11111111-1111-4111-8111-111111111111:2026-09-29T01:59:24.591Z",
      "11111111-1111-4111-8111-111111111111:2026-09-29T02:06:27.591Z"
    ],
    "sourceOutcomeIds": [
      "exec-texec-9f142e14-1e2e-40ba-8d7d-a0d1dd3ec272",
      "exec-texec-52f63bff-9167-4ff3-ae81-bdc216fee142",
      "exec-texec-d037521e-1629-486d-97f5-b042194e1622",
      "exec-texec-5478918d-c5c9-488b-ba16-d82d4ce5ad19",
      "exec-texec-deeadf44-5a9b-4f6a-9545-b636231490fd",
      "exec-texec-e6bc8f2d-38c9-4434-92f3-4e8446f147c0",
      "exec-texec-58d323d8-a25f-4abe-bbc3-5358f1709afe",
      "exec-texec-f82d8228-0676-4b9d-98d7-d1c1b8f48ea4",
      "exec-texec-e7ca68f2-8d66-47dc-8940-f4c608781c06",
      "exec-texec-38ecc277-cea1-472c-a0ef-09d1e4363174",
      "exec-texec-9e6a8336-23aa-45e7-94fc-60a9fd10a72d",
      "exec-texec-b226a304-4790-45a7-aa7d-f0da6553fc4a"
    ],
    "missionIds": [
      "sd-mission-548e0fd6da8b5c82"
    ],
    "outcome": "success"
  },
  {
    "id": "58e90f05a0be82ca",
    "name": "failure: finding:review_change_request",
    "description": "Observed 1 time(s): 1 failure.",
    "signature": {
      "findingCategory": "review_change_request"
    },
    "observations": [
      "Review decision: REQUEST_CHANGES",
      "Finding [warning]: artifact - No note was created in docs/ as required by the task."
    ],
    "occurrenceCount": 1,
    "lastSeenAt": "2026-09-29T00:22:45.435Z",
    "outcomeCounts": {
      "success": 0,
      "failure": 1,
      "mixed": 0
    },
    "firstSeenAt": "2026-09-29T00:22:45.435Z",
    "createdAt": "2026-09-29T00:22:45.435Z",
    "evidenceRefs": [
      "worker-identity",
      "worker-process"
    ],
    "sourceOutcomeIds": [
      "review-review-1790641365434-ad2adqpgf"
    ],
    "missionIds": [
      "sd-mission-548e0fd6da8b5c82"
    ],
    "outcome": "failure"
  }
]
```
## 12. Notes

- The self-development path gates through GovernedSelfDevelopmentCoordinator's DIRECT call to the IntegrationGate, not through the pending-review sweeper. The review itself IS persisted (section 8), because the coordinator reviews through container.reviewer, which is the canonical PostgresReviewerService.
- Worker branch and commits survive in /tmp/claude-501/sdrepo even when this run is reset.
