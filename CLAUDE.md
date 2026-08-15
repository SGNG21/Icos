# ICOS Repository Instructions

This repository contains the institutional source of truth for ICOS.

Before significant work:
1. read `README.md`;
2. read `docs/icos/constitution/ICOS_CONSTITUTION.md`;
3. read relevant `.icos/policies/`;
4. read accepted decisions relevant to the task;
5. use a Task Contract.

Rules:
- no tenant context -> no tenant operation;
- no explicit permission -> deny;
- never expose or commit secrets;
- never weaken security/tests merely to pass;
- agents do not directly bypass service/policy layers to production data;
- prefer reuse and reversible implementation;
- architecture changes require ADR/Decision;
- completion requires evidence.

Escalate to the owner only for genuine strategic ambiguity, irreversible material choices, policy/security conflicts, material budget exceptions or required production credentials.
