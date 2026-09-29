"use client";

import { Send } from "lucide-react";
import { useState } from "react";

import {
  ASK_EXAMPLES,
  ASK_MAX_LENGTH,
  ASK_STAGES,
  askPipeline,
  type StageStatus,
} from "@/features/cockpit/ask";

const STATUS_TEXT: Record<StageStatus, string> = {
  idle: "—",
  ready: "composed",
  not_connected: "NOT CONNECTED",
  waiting: "waiting",
};

export function AskIcos() {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const stages = askPipeline(text, submitted);

  return (
    <div className="cx-ask">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
        }}
        className="cx-ask"
      >
        <label className="cx-field">
          Ask or instruct ICOS
          <textarea
            value={text}
            maxLength={ASK_MAX_LENGTH}
            onChange={(e) => {
              setText(e.target.value);
              setSubmitted(false);
            }}
            placeholder="Pourquoi CORE3 est bloqué ?"
          />
        </label>
        <div className="cx-examples" aria-label="Examples">
          {ASK_EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex}
              onClick={() => {
                setText(ex);
                setSubmitted(false);
              }}
            >
              {ex}
            </button>
          ))}
        </div>
        <button type="submit" className="cx-btn cx-btn--primary" disabled={stages[0] !== "ready"}>
          <Send aria-hidden size={14} /> Send to ICOS
        </button>
      </form>

      {submitted && (
        <p className="cx-outcome" data-status="not_wired" role="status">
          <strong>NOT CONNECTED — nothing was sent</strong>
          <span>
            ICOS has no endpoint that turns language into a proposed command (BR-17). Your text
            stayed on this device and was not interpreted.
          </span>
        </p>
      )}

      <ol className="cx-pipeline" aria-label="Command pipeline">
        {ASK_STAGES.map((stage, i) => (
          <li key={stage.key} data-status={stages[i]}>
            <span>
              <strong>{stage.label}</strong> <span className="cx-dim">· {stage.owner}</span>
            </span>
            <span
              className={stages[i] === "not_connected" ? "cx-missing" : "cx-dim"}
              data-kind={stages[i] === "not_connected" ? "not_connected" : undefined}
            >
              {STATUS_TEXT[stages[i]]}
              {stages[i] === "not_connected" && "requirement" in stage && (
                <span className="cx-missing__req">{stage.requirement}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
