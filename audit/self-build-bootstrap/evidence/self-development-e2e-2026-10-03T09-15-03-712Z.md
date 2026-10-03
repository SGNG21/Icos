# SELF_DEVELOPMENT_E2E — durable evidence
Written by the run itself, from database rows, at 2026-10-03T09:34:53.435Z.
Started: 2026-10-03T09:15:03.712Z
Database: postgres://coco@localhost:5432/icos_srb_test
Repository: /tmp/claude-501/sdrepo @ integration/phase-7
## 0. Input
An ImprovementCandidate was supplied (`imp-bd2ae494a04637b8`). No goal, mission, task, plan, worker, review, approval or integration call was supplied.
## 1. Candidate
```json
[
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1791018903698",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"proposed\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-10-03T09:15:03.698Z\",\"reviewedAt\":null,\"reviewedBy\":null,\"reviewNotes\":null,\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-10-03T09:15:03.698Z\",\"updatedAt\":\"2026-10-03T09:15:03.698Z\"}",
    "contentReference": null,
    "createdAt": "2026-10-03 11:15:03.698+02"
  },
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1791018903733",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"under_review\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-10-03T09:15:03.698Z\",\"reviewedAt\":\"2026-10-03T09:15:03.733Z\",\"reviewedBy\":\"self-development-chain\",\"reviewNotes\":\"selected for self-development: goal sd-goal-548e0fd6da8b5c82, mission sd-mission-548e0fd6da8b5c82\",\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-10-03T09:15:03.698Z\",\"updatedAt\":\"2026-10-03T09:15:03.733Z\"}",
    "contentReference": null,
    "createdAt": "2026-10-03 11:15:03.698+02"
  },
  {
    "id": "improvement-candidate-imp-bd2ae494a04637b8-1791020093385",
    "summary": "{\"id\":\"imp-bd2ae494a04637b8\",\"identity\":{\"contentHash\":\"bd2ae494a04637b8\",\"category\":\"maintainability\",\"targetComponent\":\"docs\"},\"title\":\"Document the worker branch lifecycle\",\"description\":\"Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.\",\"rationale\":\"The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\",\"category\":\"maintainability\",\"targetComponent\":\"docs\",\"status\":\"approved\",\"priority\":\"medium\",\"proposedBy\":\"icos-self-development\",\"proposedAt\":\"2026-10-03T09:15:03.698Z\",\"reviewedAt\":\"2026-10-03T09:34:53.385Z\",\"reviewedBy\":\"self-development-coordinator\",\"reviewNotes\":\"INTEGRATED_AND_SETTLED\",\"implementedAt\":null,\"implementedBy\":null,\"supersededBy\":null,\"createdAt\":\"2026-10-03T09:15:03.698Z\",\"updatedAt\":\"2026-10-03T09:34:53.385Z\"}",
    "contentReference": null,
    "createdAt": "2026-10-03 11:15:03.698+02"
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
  "createdAt": "2026-10-03T09:15:03.736Z"
}
```
## 3. Mission
```json
{
  "id": "sd-mission-548e0fd6da8b5c82",
  "title": "Document the worker branch lifecycle",
  "objective": "Document the worker branch lifecycle. Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target. The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.\nTarget path: docs/",
  "status": "succeeded",
  "goalId": "sd-goal-548e0fd6da8b5c82",
  "planId": "4d7e19f9-8e2a-4d15-9049-cf218b250205",
  "createdAt": "2026-10-03T09:15:03.741Z",
  "updatedAt": "2026-10-03T09:34:52.352Z"
}
```
## 4. Plan and DAG
```json
{
  "id": "823c0357-a526-48ec-adf5-5774c1775a9d",
  "mission_id": "sd-mission-548e0fd6da8b5c82",
  "goal_id": "sd-goal-548e0fd6da8b5c82",
  "plan_id": "4d7e19f9-8e2a-4d15-9049-cf218b250205",
  "plan_fingerprint": "d3d4ce104759f3b6ae47fc08788d58fc56e73a4b7e33b343becea5f4a0e903c6",
  "version": 1,
  "predecessor_plan_id": null,
  "created_at": "2026-10-03 11:15:14.678+02"
}
```
```json
[
  {
    "missionTaskId": "c8c1c60f-545d-4f3d-9a2f-a589bea3a696",
    "taskId": "task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "title": "Document worker branch lifecycle",
    "status": "succeeded",
    "dependsOn": [],
    "canonical": {
      "id": "task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
      "title": "Document worker branch lifecycle",
      "description": "Create a docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target. The reaping rule is non-obvious and was the source of a real defect.",
      "status": "succeeded",
      "actionIds": [],
      "createdAt": "2026-10-03T09:15:14.684Z",
      "updatedAt": "2026-10-03T09:34:52.315Z",
      "missionId": "sd-mission-548e0fd6da8b5c82",
      "goalId": "sd-goal-548e0fd6da8b5c82",
      "planId": "4d7e19f9-8e2a-4d15-9049-cf218b250205",
      "objective": "Document worker branch lifecycle",
      "instructions": "Create a docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target. The reaping rule is non-obvious and was the source of a real defect.",
      "dependencies": [],
      "successCriteria": [
        "File created at docs/worker-branch-lifecycle.md",
        "Content covers: branch creation per writer attempt, retention on rejection, reaping when commits reach integration target",
        "Reaping rule clearly explained to prevent future defects"
      ],
      "requiredCapabilities": [],
      "riskClass": "reversible",
      "allowedFileScope": [
        "docs/"
      ],
      "expectedArtifacts": [
        "docs/worker-branch-lifecycle.md"
      ],
      "priority": 3,
      "attemptBudget": 2,
      "reviewPolicy": "never",
      "integrationPolicy": ""
    }
  }
]
```
## 5. Dispatch attempts — routing, worker identity, lease
```json
[
  {
    "id": "1bd2770c-b4a0-4dda-bb16-7ef96691885a",
    "mission_task_id": "c8c1c60f-545d-4f3d-9a2f-a589bea3a696",
    "task_id": "task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "workflow_id": "icos-task-task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "attempt": 1,
    "state": "completed",
    "worker_kind": "agent",
    "worker_id": "11111111-1111-4111-8111-111111111111",
    "capability": null,
    "dispatched_at": null,
    "execution_lease_owner": "icos-runner-85129b04-ef7e-4273-bd30-7299d1bef93d",
    "execution_lease_until": "2026-10-03 11:35:15.365+02",
    "failure_class": null,
    "created_at": "2026-10-03 11:15:14.721+02",
    "updated_at": "2026-10-03 11:17:05.837+02"
  }
]
```
## 6. Governed workspaces
```json
[
  {
    "workspaceId": "8eb762a4-843c-4579-aeaa-afbe323b0f54",
    "workerId": "11111111-1111-4111-8111-111111111111",
    "missionId": "sd-mission-548e0fd6da8b5c82",
    "taskId": "task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "slug": "document_worker_br_taskebc1",
    "branch": "ws/document_worker_br_taskebc1",
    "worktreePath": "/private/var/folders/n6/hj0j2q093vg_23sfftptlfp80000gn/T/icos-selfdev-cDDg2i/document_worker_br_taskebc1",
    "baseCommit": "1af6906ae03a80788c63d99ff258b65968dd2897",
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
    "workflowId": "icos-task-task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "createdAt": "2026-10-03T09:15:14.791Z",
    "updatedAt": "2026-10-03T09:34:47.353Z",
    "releasedAt": "2026-10-03T09:34:47.353Z",
    "sourceCommit": "a0187f9eab76d805e20fca2d4aac5cf01c18687b",
    "testDatabase": "icos_test_document_worker_br_taskebc1"
  }
]
```
## 7. Execution results
```json
[
  {
    "id": "texec-44262fed-4168-4d72-9483-ba8e5d75b144",
    "task_id": "task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "workflow_id": "icos-task-task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "outcome": "success",
    "worker_kind": "agent",
    "capability": null,
    "error_code": null,
    "error_message": null,
    "started_at": null,
    "completed_at": "2026-10-03 11:17:05.818+02",
    "artifacts": [
      {
        "path": "ws/document_worker_br_taskebc1",
        "type": "git-branch",
        "metadata": {
          "dirty": false,
          "commits": [
            "a0187f9eab76d805e20fca2d4aac5cf01c18687b"
          ],
          "commitHash": "a0187f9eab76d805e20fca2d4aac5cf01c18687b",
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
        "timestamp": "2026-10-03T09:17:05.819Z"
      },
      {
        "type": "change-diff",
        "source": "11111111-1111-4111-8111-111111111111",
        "metadata": {
          "diff": "diff --git a/docs/worker-branch-lifecycle.md b/docs/worker-branch-lifecycle.md\nnew file mode 100644\nindex 0000000..4ac5a8a\n--- /dev/null\n+++ b/docs/worker-branch-lifecycle.md\n@@ -0,0 +1,9 @@\n+# Icos/Worker Branch Lifecycle\n+\n+The `icos/worker` branch is created for each writer attempt to isolate changes.\n+\n+- **Created**: When a writer starts a new attempt, a new `icos/worker` branch is created from the current integration target (e.g., `main`).\n+- **Kept**: If a run is rejected (e.g., fails tests, review, or validation), the `icos/worker` branch is kept to allow inspection and potential reuse of the work.\n+- **Reaped**: Once the commits from an `icos/worker` branch are contained in the integration target (i.e., merged into `main` or equivalent), the branch is reaped (deleted) to avoid clutter.\n+\n+This lifecycle ensures that each writer attempt has a clean workspace, rejected attempts remain available for debugging, and successful attempts are cleaned up after integration.\n\\ No newline at end of file",
          "branch": "ws/document_worker_br_taskebc1",
          "truncated": false,
          "commitHash": "a0187f9eab76d805e20fca2d4aac5cf01c18687b"
        },
        "timestamp": "2026-10-03T09:17:05.819Z"
      },
      {
        "type": "worker-process",
        "source": "11111111-1111-4111-8111-111111111111",
        "metadata": {
          "signal": null,
          "exitCode": 0,
          "timedOut": false,
          "durationMs": 110350,
          "stderrTail": "",
          "stdoutTail": "<<<ICOS_RESULT>>>\n{\n  \"status\": \"succeeded\",\n  \"summary\": \"Created documentation for icos/worker branch lifecycle at docs/worker-branch-lifecycle.md and committed the change on branch ws/document_worker_br_taskebc1. The document describes the three-phase lifecycle: Created (per writer attempt from integration target), Kept (when run is rejected for inspection/reuse), and Reaped (once commits are contained in integration target).\",\n  \"unresolved\": [],\n  \"testsRun\": []\n}\n<<<END_ICOS_RESULT>>>\n"
        },
        "timestamp": "2026-10-03T09:17:05.819Z"
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
    "id": "review-1791019083477-0g99lx12t",
    "taskId": "task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "workflowId": "icos-task-task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
    "decision": "APPROVE",
    "reviewerKind": "llm",
    "severity": "info",
    "reasons": [
      "The worker successfully created the documentation file at docs/worker-branch-lifecycle.md as requested.",
      "The document correctly describes the three-phase lifecycle: Created (per writer attempt from integration target), Kept (when run is rejected for inspection/reuse), and Reaped (once commits are contained in integration target).",
      "The reaping rule — the non-obvious defect source — is explicitly documented: 'Once the commits from an icos/worker branch are contained in the integration target (i.e., merged into main or equivalent), the branch is reaped (deleted) to avoid clutter.'",
      "The change was committed on a dedicated branch (ws/document_worker_br_taskebc1) with a clean commit (a0187f9eab76d805e20fca2d4aac5cf01c18687b).",
      "Worker process exited successfully (exitCode: 0, no timeout, no stderr)."
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
    "createdAt": "2026-10-03 11:18:03.477+02"
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
  "missionTaskId": "c8c1c60f-545d-4f3d-9a2f-a589bea3a696",
  "taskId": "task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
  "workflowId": "icos-task-task-ebc1a6f2-a4f3-4fca-9aeb-b362bd4981e3",
  "finalState": "integrated",
  "gateDecision": "ACCEPT",
  "reason": "INTEGRATED_AND_SETTLED",
  "repairAttemptsUsed": 0,
  "completedAt": "2026-10-03T09:34:53.387Z"
}
```
## 10. Integration
```
integration/phase-7 before: 1af6906ae03a80788c63d99ff258b65968dd2897
integration/phase-7 after:  a0187f9eab76d805e20fca2d4aac5cf01c18687b
```
Commits added to `integration/phase-7` (1):

- `a0187f9 docs: add note on icos/worker branch lifecycle`
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
      "Finding [info]: IntegrationGate - ACCEPT"
    ],
    "occurrenceCount": 1,
    "lastSeenAt": "2026-10-03T09:34:53.380Z",
    "outcomeCounts": {
      "success": 1,
      "failure": 0,
      "mixed": 0
    },
    "firstSeenAt": "2026-10-03T09:34:53.380Z",
    "createdAt": "2026-10-03T09:34:53.380Z",
    "evidenceRefs": [
      "a0187f9eab76d805e20fca2d4aac5cf01c18687b"
    ],
    "sourceOutcomeIds": [
      "gate-imp-bd2ae494a04637b8-a0187f9eab76d805e20fca2d4aac5cf01c18687b-ACCEPT"
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
    "occurrenceCount": 1,
    "lastSeenAt": "2026-10-03T09:18:03.477Z",
    "outcomeCounts": {
      "success": 1,
      "failure": 0,
      "mixed": 0
    },
    "firstSeenAt": "2026-10-03T09:18:03.477Z",
    "createdAt": "2026-10-03T09:18:03.477Z",
    "evidenceRefs": [
      "worker-identity",
      "change-diff",
      "worker-process"
    ],
    "sourceOutcomeIds": [
      "review-review-1791019083477-0g99lx12t"
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
    "occurrenceCount": 1,
    "lastSeenAt": "2026-10-03T09:17:05.828Z",
    "outcomeCounts": {
      "success": 1,
      "failure": 0,
      "mixed": 0
    },
    "firstSeenAt": "2026-10-03T09:17:05.828Z",
    "createdAt": "2026-10-03T09:17:05.828Z",
    "evidenceRefs": [
      "11111111-1111-4111-8111-111111111111:2026-10-03T09:17:05.819Z"
    ],
    "sourceOutcomeIds": [
      "exec-texec-44262fed-4168-4d72-9483-ba8e5d75b144"
    ],
    "missionIds": [
      "sd-mission-548e0fd6da8b5c82"
    ],
    "outcome": "success"
  }
]
```
## 12. Notes

- Decision 0052: self-development runs on the canonical path only — QC review (persisted, section 8) -> pending-review sweep -> IntegrationGate -> applier -> integrated settlement. The coordinator never reviews, gates, applies or completes a task itself.
- Worker branch and commits survive in /tmp/claude-501/sdrepo even when this run is reset.
