# ICOS_SELF_BUILD_E2E run 1 (HEAD 38daa77) — STOPPED: correction stranded

Target: /tmp/claude-501/sdrepo integration/phase-7 reset to 38daa77. Run DB icos_test_selfbuild. Stopped at 2026-09-29T09:38:49Z by the operator after attempt 2 stayed prepared for >9 min.

## Durable state at stop
```
                       title                       | status |          updated_at
---------------------------------------------------+--------+-------------------------------
 Implement token-based compaction in ContextEngine | queued | 2026-09-29 11:29:13.350724+02
(1 row)

                     workflow_id                     |     state      | action | last_error
-----------------------------------------------------+----------------+--------+------------
 icos-task-task-ecfa5260-e02a-4264-81e9-8e84a189cdff | action_applied | RETRY  |
(1 row)

                          workflow_id                          | attempt |  state   |                          last_error                          |          created_at
---------------------------------------------------------------+---------+----------+--------------------------------------------------------------+-------------------------------
 icos-task-task-ecfa5260-e02a-4264-81e9-8e84a189cdff           |       1 | failed   | STREAM_FAILED: killed after exceeding its timeout (599994ms) | 2026-09-29 11:18:41.799+02
 icos-task-task-ecfa5260-e02a-4264-81e9-8e84a189cdff-attempt-2 |       2 | prepared |                                                              | 2026-09-29 11:29:13.350724+02
(2 rows)

                     workflow_id                     |        status         |             branch             | released_at
-----------------------------------------------------+-----------------------+--------------------------------+-------------
 icos-task-task-ecfa5260-e02a-4264-81e9-8e84a189cdff | ready_for_integration | ws/implement_token_ba_taskecfa |
(1 row)

            id            |  status
--------------------------+-----------
 sd-goal-46f71f13feeab160 | converted
(1 row)

```

Diagnosis: attempt 1 FAILED (worker timeout); QC RETRY prepared attempt 2; attempt 1's workspace is never reviewed, so the pending-review gate never releases it, and every allocation of attempt 2 collides (WORKFLOW_COLLISION). Recorded as SUPERSEDED_ATTEMPT_WORKSPACE_HELD.
