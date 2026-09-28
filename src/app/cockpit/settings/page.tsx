import { Panel, Unavailable } from "@/components/cockpit/primitives";
import { PERMISSIONS, hasPermission } from "@/core/identity";
import { getCockpitContext } from "@/features/cockpit/load";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await getCockpitContext();
  if (!ctx) return null;
  const { session, scope } = ctx;
  const granted = PERMISSIONS.filter((p) => hasPermission(session.roles, p));

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Settings</p>
          <h1>Session & preferences</h1>
        </div>
      </div>

      <div className="cx-grid2">
        <Panel title="Session" eyebrow="Server-side identity">
          <dl className="cx-kv">
            <dt>User</dt>
            <dd>{session.user.name ?? session.user.email}</dd>
            <dt>Email</dt>
            <dd>{session.user.email}</dd>
            <dt>Roles</dt>
            <dd>{session.roles.join(", ")}</dd>
            <dt>Operational scope</dt>
            <dd>{scope.kind === "global" ? "global" : `${scope.agentIds.size} linked agent(s)`}</dd>
          </dl>
          <h4>Granted permissions ({granted.length})</h4>
          <div className="cx-tags">
            {granted.map((p) => (
              <span key={p} className="cx-chip">
                {p}
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Security" eyebrow="Devices · re-authentication">
          <Unavailable title="Passkeys / WebAuthn step-up are NOT YET WIRED" requirement="BR-18">
            HIGH-risk commands stay unsendable until a fresh re-authentication can be bound to the command.
          </Unavailable>
          <Unavailable title="Device and session management are NOT YET WIRED" requirement="BR-21">
            Listing and revoking your other sessions/devices needs a server endpoint.
          </Unavailable>
        </Panel>
      </div>

      <Panel title="Notifications" eyebrow="P0 / P1 / P2">
        <Unavailable title="Notification preferences are NOT YET WIRED" requirement="BR-19">
          Preferences are not stored in the browser: they would silently diverge from what the server sends.
        </Unavailable>
      </Panel>
    </>
  );
}
