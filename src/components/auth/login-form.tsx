"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";

import { createLoginSubmission, type AuthActionResult } from "./auth-actions";

type LoginFormProps = {
  nextPath: string;
};

export function LoginForm({ nextPath }: LoginFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitRef = useRef<ReturnType<typeof createLoginSubmission> | null>(null);

  if (submitRef.current === null) {
    submitRef.current = createLoginSubmission({
      request: (input, init) => fetch(input, init),
      replace: (path) => router.replace(path),
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }

    const form = new FormData(event.currentTarget);
    const email = form.get("email");
    const password = form.get("password");
    if (typeof email !== "string" || typeof password !== "string") {
      return;
    }

    setError("");
    setPending(true);
    let result: AuthActionResult;
    try {
      result = await submitRef.current!({ email, password }, nextPath);
    } finally {
      setPending(false);
    }

    if (result.status === "rejected") {
      setError(result.message);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit} noValidate={false}>
      <div className="form-field">
        <label htmlFor="email">Adresse e-mail</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          disabled={pending}
        />
      </div>

      <div className="form-field">
        <label htmlFor="password">Mot de passe</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          required
          disabled={pending}
        />
      </div>

      <p className="auth-error" role="alert" aria-live="polite">
        {error}
      </p>

      <button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Connexion en cours…" : "Se connecter"}
      </button>
    </form>
  );
}
