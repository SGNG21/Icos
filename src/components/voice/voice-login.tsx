"use client";

import { AlertCircle, Eye, EyeOff, Lock, LockOpen, Network, Wifi, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { createLoginSubmission } from "@/components/auth/auth-actions";

import styles from "./voice.module.css";

/**
 * ICOS voice sign-in for the phone (decision 0056). Same submission, endpoint
 * and error semantics as the shared login form — only the presentation is
 * phone-first. Indicators state facts about this page (scheme, host, network),
 * never assumptions.
 */
export function VoiceLogin({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [origin, setOrigin] = useState<{ secure: boolean; tailnet: boolean } | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<ReturnType<typeof createLoginSubmission> | null>(null);

  useEffect(() => {
    // Facts about where this page runs are only known in the browser.
    const sync = () => setOnline(navigator.onLine);
    const initial = setTimeout(() => {
      sync();
      setOrigin({
        secure: window.isSecureContext && location.protocol === "https:",
        tailnet: location.hostname.endsWith(".ts.net"),
      });
    }, 0);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      clearTimeout(initial);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !email || !password) return;
    submitRef.current ??= createLoginSubmission({
      request: (input, init) => fetch(input, init),
      replace: (path) => router.replace(path),
    });
    setPending(true);
    setError("");
    const result = await submitRef.current({ email, password }, nextPath);
    if (result.status === "rejected") {
      setPending(false);
      setError(online ? result.message : "Pas de connexion réseau. Réessayez une fois en ligne.");
      passwordRef.current?.focus();
    }
    // succeeded: keep the pending state while the voice screen loads.
  }

  const canSubmit = email.length > 0 && password.length > 0 && !pending && online;

  return (
    <main className={`${styles.root} ${styles.loginRoot}`}>
      <div className={styles.loginWrap}>
        <header className={styles.loginBrand}>
          <span className={styles.mark} aria-hidden="true">
            I
          </span>
          <h1 className={styles.loginTitle}>ICOS Voix</h1>
          <p className={styles.loginSub}>Accès humain sécurisé</p>
          <ul className={styles.badges} aria-label="État de la connexion">
            {origin && (
              <li className={styles.chip} data-tone={origin.secure ? "ok" : "warn"}>
                {origin.secure ? <Lock aria-hidden /> : <LockOpen aria-hidden />}
                {origin.secure ? "Connexion chiffrée" : "Connexion non chiffrée"}
              </li>
            )}
            {origin?.tailnet && (
              <li className={styles.chip} data-tone="flow">
                <Network aria-hidden />
                Réseau privé Tailscale
              </li>
            )}
            <li className={styles.chip} data-tone={online ? "ok" : "critical"}>
              {online ? <Wifi aria-hidden /> : <WifiOff aria-hidden />}
              {online ? "En ligne" : "Hors ligne"}
            </li>
          </ul>
        </header>

        <form className={styles.card} onSubmit={submit} noValidate aria-busy={pending}>
          {error && (
            <p className={styles.formError} role="alert">
              <AlertCircle aria-hidden />
              <span>{error}</span>
            </p>
          )}
          <div className={styles.field}>
            <label htmlFor="voice-email">Adresse e-mail</label>
            <input
              id="voice-email"
              className={styles.input}
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              disabled={pending}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="voice-password">Mot de passe</label>
            <div className={styles.inputWrap}>
              <input
                id="voice-password"
                ref={passwordRef}
                className={`${styles.input} ${styles.withToggle}`}
                name="password"
                type={reveal ? "text" : "password"}
                autoComplete="current-password"
                required
                disabled={pending}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error ? true : undefined}
              />
              <button
                type="button"
                className={styles.reveal}
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                aria-pressed={reveal}
                aria-controls="voice-password"
              >
                {reveal ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </button>
            </div>
          </div>
          <button type="submit" className={styles.submit} disabled={!canSubmit}>
            {pending && <span className={styles.spinner} aria-hidden />}
            {pending ? "Connexion…" : "Se connecter"}
          </button>
        </form>
        <p className={styles.footnote}>Utilisez le compte ICOS qui vous a été attribué.</p>
      </div>
    </main>
  );
}
