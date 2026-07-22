import type { Metadata } from "next";

import { safeNextPath } from "@/auth-navigation";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Connexion — ICOS",
};

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const next = (await searchParams).next;
  const nextPath = safeNextPath(typeof next === "string" ? next : null);

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true">
          I
        </div>
        <p className="eyebrow">Accès humain sécurisé</p>
        <h1 id="login-title">Connexion à ICOS</h1>
        <p className="login-intro">
          Utilisez le compte qui vous a été attribué. La création de compte n’est pas disponible
          depuis cette interface.
        </p>
        <LoginForm nextPath={nextPath} />
      </section>
    </main>
  );
}
