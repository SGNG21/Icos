# Mutation proofs for the control plane (decision 0044).
# Each row removes one safety check, runs the control test suites, and must be KILLED
# by a real assertion failure. Files are restored after each mutation.
# Run from anywhere: python3 audit/control-foundation/mutation-proofs.py

import subprocess, sys
import os
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
M=[
 ("state version check", "src/server/control/command-bus.ts", "if (version !== request.expectedVersion) {", "if (false) {"),
 ("authorization", "src/server/control/command-bus.ts", "if (!hasPermission(actor.session.roles, requiredPermission(request.type))) {", "if (false) {"),
 ("re-auth / freshness", "src/server/control/command-bus.ts", "if (!freshness.ok) {", "if (false) {"),
 ("proof single-use", "src/server/control/command-bus.ts", "if (requirement.reauth && !(await tx.consumeProof(proofHash!, at))) {", "if (false) {"),
 ("mission hold check (guard)", "src/server/control/runtime-control.ts", "return (await this.store.isHeld(missionId))", "return false"),
 ("hold check (supervisor admission)", "src/server/supervisor/supervisor-service.ts", "if (!this.controlGuard) return false;", "return false;"),
 ("safe-mode guard", "src/core/control/policy.ts", "if (stored.safeMode) {", "if (false) {"),
 ("fail-closed read", "src/core/control/policy.ts", "  if (!stored) {\n    return {", "  if (false) {\n    return {"),
 ("integration guard (gate)", "src/server/workspace-manager/integration-gate.ts", "if (this.control) {", "if (false) {"),
 ("external-action guard (applier)", "src/server/workspace-manager/integration-applier.ts", "if (this.control) await assertExternalActionAllowed", "if (false) await assertExternalActionAllowed"),
 ("dispatcher backstop", "src/server/control/runtime-control.ts", "if (!decision.allowed)\n      throw new ControlHeldError(decision.reason, `dispatch", "if (false)\n      throw new ControlHeldError(decision.reason, `dispatch"),
 ("audit write", "src/server/control/command-bus.ts", "await tx.appendAudit(", "await (async (..._a: unknown[]) => {})("),
 ("idempotency", "src/server/control/command-bus.ts", "const existing = await tx.getCommand(commandId);", "const existing = null as CommandRecord | null;"),
 ("QC retry hold (production composition)", "src/server/system/production-services.ts", "!(await container.control.guard.dispatch(prepared.missionId)).allowed", "false"),
 ("cancel compare-and-set", "src/server/control/compose.ts", "? deps.missions.transitionMissionStatusIf(id, from, \"cancelled\")", "? (await deps.missions.updateMissionStatus(id, \"cancelled\"), true)"),
 ("sticky cancelled", "src/server/services/in-memory/mission-repository.ts", "if (mission.status === \"cancelled\") return;", ""),
 ("enable resets evidence", "src/server/services/worker-registry/worker-registration-service.ts", "      health: \"unknown\",\n      availability: \"unknown\",\n      lastProbeAt: null,\n      lastProbeOutcome: \"never\",\n", ""),
]
TESTS=["src/server/control","src/app/api/control","src/core/control"]
rows=[]
for name,f,old,new in M:
    p=f"{ROOT}/{f}"; src=open(p).read()
    n=src.count(old)
    if n==0: rows.append((name,"PATTERN NOT FOUND","-")); continue
    open(p,"w").write(src.replace(old,new))
    try:
        r=subprocess.run(["pnpm","-s","vitest","run",*TESTS],cwd=ROOT,capture_output=True,text=True,timeout=300)
        out=r.stdout+r.stderr
        if "Transform failed" in out or "SyntaxError" in out:
            rows.append((name,"INVALID MUTATION (does not compile)","-")); continue
        failed=[l.strip() for l in out.splitlines() if l.strip().startswith("Tests ")]
        rows.append((name,"KILLED" if r.returncode!=0 else "SURVIVED", failed[-1] if failed else out[-200:]))
    finally:
        open(p,"w").write(src)
for r in rows: print(" | ".join(r))
