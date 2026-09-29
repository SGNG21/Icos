# ICOS_SELF_BUILD_E2E run 2 (HEAD c1edfd7) — STOPPED: superseded workspace could not be released

Target reset to c1edfd7; run DB icos_test_selfbuild. Stopped 2026-09-29T10:44:21Z after attempt 2 stayed prepared ~15 min.

Proposal (by ICOS): Fix inconsistent indentation for AI Selection Engine block in container.ts.

## Durable state at stop
```
task|Fix inconsistent indentation for AI Selection Engine block in container.ts|queued
qc|icos-task-task-9580d73d-3b25-4fc0-9fbf-3d1baf3f83ee|action_applied|RETRY
attempt|icos-task-task-9580d73d-3b25-4fc0-9fbf-3d1baf3f83ee|1|failed|STREAM_FAILED: killed after exceeding its timeout (600010ms)
attempt|icos-task-task-9580d73d-3b25-4fc0-9fbf-3d1baf3f83ee-attempt-2|2|prepared|
workspace|icos-task-task-9580d73d-3b25-4fc0-9fbf-3d1baf3f83ee|abandoned|
```

## Abandoned worktree (attempt 1) — uncommitted edit left by the killed worker
```
 src/server/container.ts | 57 ++++++++++++++++++++++++++++++++++---------------
 1 file changed, 40 insertions(+), 17 deletions(-)
```

Diagnosis: 0053-amendment retirement moved attempt 1 to abandoned, but WorkspaceManager.cleanup refuses UNCOMMITTED_CHANGES (correctly: it never destroys work), so the workspace was never released and every allocation of attempt 2 collided. Recorded as SUPERSEDED_DIRTY_WORKSPACE_HELD.
