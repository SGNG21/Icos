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
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submitRef = useRef<ReturnType<typeof createLoginSubmission> | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  if (submitRef.current === null) {
    submitRef.current = createLoginSubmission({
      request: (input, init) => fetch(input, init),
      replace: (path) => router.replace(path),
    });
  }

  const validateEmail = (email: string): string | null => {
    if (!email) return "L'adresse e-mail est requise";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Format d'e-mail invalide";
    return null;
  };

  const validatePassword = (password: string): string | null => {
    if (!password) return "Le mot de passe est requis";
    if (password.length < 12) return "Le mot de passe doit contenir au moins 12 caractères";
    return null;
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const email = form.get("email");
    const password = form.get("password");
    if (typeof email !== "string" || typeof password !== "string") return;

    // Client-side validation
    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    setEmailError(emailErr || "");
    setPasswordError(passwordErr || "");

    if (emailErr || passwordErr) {
      emailRef.current?.focus();
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
      passwordRef.current?.focus();
    }
  }

  const handleEmailBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    const err = validateEmail(event.currentTarget.value);
    setEmailError(err || "");
  };

  const handlePasswordBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    const err = validatePassword(event.currentTarget.value);
    setPasswordError(err || "");
  };

  return (
    <form className="login-form" onSubmit={handleSubmit} noValidate={false}>
      <div className="form-field">
        <label htmlFor="email">Adresse e-mail</label>
        <input
          id="email"
          ref={emailRef}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          disabled={pending}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={handleEmailBlur}
          aria-invalid={!!emailError}
          aria-describedby={emailError ? "email-error" : undefined}
          autoFocus
        />
        {emailError && (
          <p id="email-error" className="field-error" role="alert" aria-live="polite">
            {emailError}
          </p>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="password">Mot de passe</label>
        <input
          id="password"
          ref={passwordRef}
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          required
          disabled={pending}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={handlePasswordBlur}
          aria-invalid={!!passwordError}
          aria-describedby={passwordError ? "password-error" : "password-hint"}
        />
        {passwordError ? (
          <p id="password-error" className="field-error" role="alert" aria-live="polite">
            {passwordError}
          </p>
        ) : (
          <p id="password-hint" className="field-hint">
            12 caractères minimum
          </p>
        )}
      </div>

      {error && (
        <p className="auth-error" role="alert" aria-live="assertive">
          {error}
        </p>
      )}

      <button type="submit" disabled={pending} aria-busy={pending} className="login-submit">
        {pending ? "Connexion en cours…" : "Se connecter"}
      </button>
    </form>
  );
}
