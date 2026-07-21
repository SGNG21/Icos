"use client";

import { useState, type FormEvent } from "react";

export function CommandComposer() {
  const [command, setCommand] = useState("");
  const [notice, setNotice] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (command.trim()) {
      setNotice("Commande conservée localement dans le champ — exécution désactivée.");
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <label htmlFor="command">Instruction pour ICOS</label>
      <div className="composer-row">
        <input
          id="command"
          onChange={(event) => {
            setCommand(event.target.value);
            setNotice("");
          }}
          placeholder="Décrivez l’objectif à préparer…"
          type="text"
          value={command}
        />
        <button type="submit">Préparer</button>
      </div>
      <div className="composer-help" aria-live="polite">
        <span>{notice || "Entrée locale uniquement"}</span>
        <kbd>Entrée</kbd>
      </div>
    </form>
  );
}
