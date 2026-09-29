# SELF_DEVELOPMENT_E2E — durable evidence
Written by the run itself, from database rows, at 2026-09-29T02:03:15.121Z.
Started: 2026-09-29T01:56:29.146Z
Database: postgres://coco@localhost:5432/icos_test_selfbuild
Repository: /tmp/claude-501/sdrepo @ integration/phase-7
## 0. Input
An ImprovementCandidate was supplied (`imp-bd2ae494a04637b8`). No goal, mission, task, plan, worker, review, approval or integration call was supplied.
## 1. Candidate
```json
[
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1790646989134",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"proposed\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-09-29T01:56:29.134Z\",\"reviewedAt\":null,\"reviewedBy\":null,\"reviewNotes\":null,\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-09-29T01:56:29.134Z\",\"updatedAt\":\"2026-09-29T01:56:29.134Z\"}",
    "contentReference": null,
    "createdAt": "2026-09-29 03:56:29.134+02"
  },
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1790646989164",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"under_review\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-09-29T01:56:29.134Z\",\"reviewedAt\":\"2026-09-29T01:56:29.164Z\",\"reviewedBy\":\"self-development-chain\",\"reviewNotes\":\"selected for self-development: goal sd-goal-548e0fd6da8b5c82, mission sd-mission-548e0fd6da8b5c82\",\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-09-29T01:56:29.134Z\",\"updatedAt\":\"2026-09-29T01:56:29.164Z\"}",
    "contentReference": null,
    "createdAt": "2026-09-29 03:56:29.134+02"
  },
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1790647395079",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"approved\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-09-29T01:56:29.134Z\",\"reviewedAt\":\"2026-09-29T02:03:15.079Z\",\"reviewedBy\":\"self-development-coordinator\",\"reviewNotes\":\"INTEGRATION_APPLIED:INTEGRATED\",\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-09-29T01:56:29.134Z\",\"updatedAt\":\"2026-09-29T02:03:15.079Z\"}",
    "contentReference": null,
    "createdAt": "2026-09-29 03:56:29.134+02"
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
  "createdAt": "2026-09-29T01:56:29.167Z"
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
  "planId": "9358e7e2-0ee1-4216-81ab-127b6d7caa52",
  "createdAt": "2026-09-29T01:56:29.174Z",
  "updatedAt": "2026-09-29T01:56:44.578Z"
}
```
## 4. Plan and DAG
```json
{
  "id": "f72dcfe0-06bb-4dd0-a63b-9ceec74b2035",
  "mission_id": "sd-mission-548e0fd6da8b5c82",
  "goal_id": "sd-goal-548e0fd6da8b5c82",
  "plan_id": "9358e7e2-0ee1-4216-81ab-127b6d7caa52",
  "plan_fingerprint": "d54362baf84d83f87eb19c0fa2c4ffc27b64e47c1904183d8af44a270cc675f2",
  "version": 1,
  "predecessor_plan_id": null,
  "created_at": "2026-09-29 03:56:44.578+02"
}
```
```json
[
  {
    "missionTaskId": "7bf7e8c8-5464-4fb6-9c6f-d636e92b87db",
    "taskId": "task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "title": "Document worker branch lifecycle",
    "status": "succeeded",
    "dependsOn": [],
    "canonical": {
      "id": "task-5e47746a-82d8-488a-9669-bc44e9648da1",
      "title": "Document worker branch lifecycle",
      "description": "Add a short note in docs/ describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.",
      "status": "queued",
      "actionIds": [],
      "createdAt": "2026-09-29T01:56:44.586Z",
      "updatedAt": "2026-09-29T01:56:44.614Z",
      "missionId": "sd-mission-548e0fd6da8b5c82",
      "goalId": "sd-goal-548e0fd6da8b5c82",
      "planId": "9358e7e2-0ee1-4216-81ab-127b6d7caa52",
      "objective": "Document worker branch lifecycle",
      "instructions": "Add a short note in docs/ describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.",
      "dependencies": [],
      "successCriteria": [
        "A file exists in docs/ that describes the worker branch lifecycle."
      ],
      "requiredCapabilities": [],
      "riskClass": "reversible",
      "allowedFileScope": [
        "docs/"
      ],
      "expectedArtifacts": [
        "docs/worker-branch-lifecycle.md"
      ],
      "priority": 1,
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
    "id": "6c5b69a2-ce33-4c48-8f26-2a0c8fbc2e68",
    "mission_task_id": "7bf7e8c8-5464-4fb6-9c6f-d636e92b87db",
    "task_id": "task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "workflow_id": "icos-task-task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "attempt": 1,
    "state": "dispatched",
    "worker_kind": "agent",
    "worker_id": "11111111-1111-4111-8111-111111111111",
    "capability": null,
    "dispatched_at": "2026-09-29 03:59:24.613+02",
    "execution_lease_owner": "icos-runner-89cd6be1-e3aa-400d-a396-783a1d67e609",
    "execution_lease_until": "2026-09-29 04:16:45.724+02",
    "failure_class": null,
    "created_at": "2026-09-29 03:56:44.614+02",
    "updated_at": "2026-09-29 03:59:24.613+02"
  }
]
```
## 6. Governed workspaces
```json
[
  {
    "workspaceId": "c10bf95a-f050-4b38-9d1d-149e0d92cc83",
    "workerId": "11111111-1111-4111-8111-111111111111",
    "missionId": "sd-mission-548e0fd6da8b5c82",
    "taskId": "task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "slug": "document_worker_br_task5e47",
    "branch": "ws/document_worker_br_task5e47",
    "worktreePath": "/private/var/folders/n6/hj0j2q093vg_23sfftptlfp80000gn/T/icos-selfdev-GO99ZV/document_worker_br_task5e47",
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
    "workflowId": "icos-task-task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "createdAt": "2026-09-29T01:56:44.688Z",
    "updatedAt": "2026-09-29T02:03:11.696Z",
    "releasedAt": "2026-09-29T02:03:11.696Z",
    "sourceCommit": "6560832bdceed86f6b5f2a884b80a4fad9dde06c",
    "testDatabase": "icos_test_document_worker_br_task5e47"
  }
]
```
## 7. Execution results
```json
[
  {
    "id": "texec-9e6a8336-23aa-45e7-94fc-60a9fd10a72d",
    "task_id": "task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "workflow_id": "icos-task-task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "outcome": "success",
    "worker_kind": "agent",
    "capability": null,
    "error_code": null,
    "error_message": null,
    "started_at": null,
    "completed_at": "2026-09-29 03:59:24.591+02",
    "artifacts": [
      {
        "path": "ws/document_worker_br_task5e47",
        "type": "git-branch",
        "metadata": {
          "dirty": false,
          "commits": [
            "6560832bdceed86f6b5f2a884b80a4fad9dde06c"
          ],
          "commitHash": "6560832bdceed86f6b5f2a884b80a4fad9dde06c",
          "changedFiles": [
            "docs/worker-branch-lifecycle.md"
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
        "timestamp": "2026-09-29T01:59:24.591Z"
      },
      {
        "type": "change-diff",
        "source": "11111111-1111-4111-8111-111111111111",
        "metadata": {
          "diff": "diff --git a/docs/worker-branch-lifecycle.md b/docs/worker-branch-lifecycle.md\nnew file mode 100644\nindex 0000000..56e7195\n--- /dev/null\n+++ b/docs/worker-branch-lifecycle.md\n@@ -0,0 +1,8 @@\n+# Icos/Worker Branch Lifecycle\n+\n+The `icos/worker` branch is created for each writer attempt to isolate changes.\n+- **Created**: When a writer starts a new attempt, a new `icos/worker` branch is created from the current integration target (e.g., `main`).\n+- **Kept**: If a run is rejected (e.g., fails tests, review, or validation), the `icos/worker` branch is kept to allow inspection and potential reuse of the work.\n+- **Reaped**: Once the commits from an `icos/worker` branch are contained in the integration target (i.e., merged into `main` or equivalent), the branch is reaped (deleted) to avoid clutter.\n+\n+This lifecycle ensures that each writer attempt has a clean workspace, rejected attempts remain available for debugging, and successful attempts are cleaned up after integration.",
          "branch": "ws/document_worker_br_task5e47",
          "truncated": false,
          "commitHash": "6560832bdceed86f6b5f2a884b80a4fad9dde06c"
        },
        "timestamp": "2026-09-29T01:59:24.591Z"
      },
      {
        "type": "worker-process",
        "source": "11111111-1111-4111-8111-111111111111",
        "metadata": {
          "signal": null,
          "exitCode": 0,
          "timedOut": false,
          "durationMs": 158768,
          "stderrTail": "",
          "stdoutTail": "<<<ICOS_RESULT>>>\n{\n  \"status\": \"succeeded\",\n  \"summary\": \"Added documentation for icos/worker branch lifecycle in docs/worker-branch-lifecycle.md\",\n  \"unresolved\": [],\n  \"testsRun\": []\n}\n<<<END_ICOS_RESULT>>>\n"
        },
        "timestamp": "2026-09-29T01:59:24.591Z"
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
    "id": "review-1790647182363-o9s2apt1r",
    "taskId": "task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "workflowId": "icos-task-task-5e47746a-82d8-488a-9669-bc44e9648da1",
    "decision": "APPROVE",
    "reviewerKind": "llm",
    "severity": "info",
    "reasons": [
      "The worker successfully created the required documentation file at docs/worker-branch-lifecycle.md.",
      "The content accurately describes the icos/worker branch lifecycle: created per writer attempt from the integration target, kept when a run is rejected, and reaped once commits are contained in the integration target.",
      "The note is clear, concise, and matches the mission objective exactly.",
      "The worker's process completed successfully with exit code 0 and no errors.",
      "The artifact shows a clean git branch with the exact changes expected.",
      "No test failures or unresolved issues were reported.",
      "The documentation addresses the non-obvious reaping rule that was the source of a real defect, fulfilling the preventive goal."
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
    "confidence": 0.95,
    "createdAt": "2026-09-29 03:59:42.363+02"
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
  "missionTaskId": "7bf7e8c8-5464-4fb6-9c6f-d636e92b87db",
  "taskId": "task-5e47746a-82d8-488a-9669-bc44e9648da1",
  "workflowId": "icos-task-task-5e47746a-82d8-488a-9669-bc44e9648da1",
  "finalState": "integrated",
  "gateDecision": "ACCEPT",
  "reason": "INTEGRATION_APPLIED:INTEGRATED",
  "repairAttemptsUsed": 0,
  "completedAt": "2026-09-29T02:03:15.077Z"
}
```
## 10. Integration
```
integration/phase-7 before: fff87817ac94f96140b29ae20f4f22672e6a1ad8
integration/phase-7 after:  6560832bdceed86f6b5f2a884b80a4fad9dde06c
```
Commits added to `integration/phase-7` (1):

- `6560832 docs: add note on icos/worker branch lifecycle`
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
    "occurrenceCount": 10,
    "lastSeenAt": "2026-09-29T02:03:15.075Z",
    "outcomeCounts": {
      "success": 6,
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
      "6560832bdceed86f6b5f2a884b80a4fad9dde06c"
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
      "gate-imp-bd2ae494a04637b8-6560832bdceed86f6b5f2a884b80a4fad9dde06c-ACCEPT"
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
    "occurrenceCount": 10,
    "lastSeenAt": "2026-09-29T01:59:42.363Z",
    "outcomeCounts": {
      "success": 10,
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
      "review-review-1790647182363-o9s2apt1r"
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
    "occurrenceCount": 11,
    "lastSeenAt": "2026-09-29T01:59:24.601Z",
    "outcomeCounts": {
      "success": 11,
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
      "11111111-1111-4111-8111-111111111111:2026-09-29T01:59:24.591Z"
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
      "exec-texec-9e6a8336-23aa-45e7-94fc-60a9fd10a72d"
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
