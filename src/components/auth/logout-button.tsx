"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { createLogoutSubmission } from "./auth-actions";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitRef = useRef<ReturnType<typeof createLogoutSubmission> | null>(null);

  if (submitRef.current === null) {
    submitRef.current = createLogoutSubmission({
      request: (input, init) => fetch(input, init),
      replace: (path) => router.replace(path),
    });
  }

  async function handleLogout() {
    if (pending) {
      return;
    }

    setError("");
    setPending(true);
    try {
      const result = await submitRef.current!();
      if (result.status === "rejected") {
        setError(result.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="logout-control">
      <button type="button" onClick={handleLogout} disabled={pending} aria-busy={pending}>
        {pending ? "Déconnexion…" : "Se déconnecter"}
      </button>
      <p className="sidebar-auth-error" role="alert" aria-live="polite">
        {error}
      </p>
    </div>
  );
}
