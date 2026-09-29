"use client";

import { useEffect, useState } from "react";

import type { ControlState } from "@/core/control/contracts";
import { httpControlTransport, runtimeFlagRows, type Reply } from "@/features/cockpit/commands";

import { ToneBadge } from "./primitives";

/** Current runtime control flags, read from `GET /api/control/state`. Never assumed. */
export function ControlStatePanel() {
  const [reply, setReply] = useState<Reply<ControlState> | "loading" | "unreachable">("loading");
  useEffect(() => {
    let live = true;
    httpControlTransport()
      .state({ kind: "runtime", id: "global" })
      .then((r) => live && setReply(r))
      .catch(() => live && setReply("unreachable"));
    return () => {
      live = false;
    };
  }, []);

  if (reply === "loading")
    return (
      <p className="cx-safestate" role="status">
        <span className="cx-missing" data-kind="unknown">
          CONTROL STATE: UNKNOWN
        </span>{" "}
        reading…
      </p>
    );
  if (reply === "unreachable" || reply.kind !== "ok") {
    const notConnected = reply !== "unreachable" && reply.kind === "not_connected";
    return (
      <div className="cx-safestate" role="status">
        <span className="cx-missing" data-kind={notConnected ? "not_connected" : "unknown"}>
          CONTROL STATE: {notConnected ? "NOT CONNECTED" : "UNAVAILABLE"}
        </span>
        <p>
          {notConnected
            ? "The governed control API (decision 0044) is not deployed with this build, so no flag can be read and no emergency command can be sent. In an emergency, stop ICOS processes at the host."
            : "ICOS did not answer the control-state read. Flags are not shown as either on or off."}
        </p>
      </div>
    );
  }
  const rows = runtimeFlagRows(reply.value);
  return (
    <div className="cx-safestate" role="status">
      <table className="cx-table">
        <thead>
          <tr>
            <th>Flag</th>
            <th>Effective</th>
            <th>Stored</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td>
                <ToneBadge tone={r.tone} label={r.effective ? "on" : "off"} size="sm" />
              </td>
              <td className="cx-dim">
                {r.stored === null ? "UNREADABLE → fail-closed" : r.stored ? "on" : "off"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cx-dim">
        Runtime version {reply.value.runtime.version ?? "UNKNOWN"} · read live from ICOS.
      </p>
    </div>
  );
}
