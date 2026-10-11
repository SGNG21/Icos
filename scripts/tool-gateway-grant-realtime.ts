/**
 * Accès temps réel du runtime — adaptateur CLI MINCE autour de `grantRealtimeToRuntime()`.
 * Exécuté par un HUMAIN via `tsx` : `pnpm tools:grant-realtime --reason "…"`.
 *
 * Accorde EXPLICITEMENT à l'identité `agent-icos-runtime` les deux seules permissions dont la
 * source de contexte temps réel a besoin : `web-search:SEARCH` et `web-fetch:READ`. C'est un
 * acte d'ADMINISTRATION (décision 0058 : rien n'est jamais accordé implicitement) ; il ne
 * tourne jamais au démarrage. Même chemin que `POST /api/tool-gateway/grants` : la permission
 * `agentCapabilities.write` du propriétaire est vérifiée, la raison est obligatoire, tout est
 * audité. Révoquer : `POST /api/tool-gateway/grants` avec `op: "revoke"`.
 *
 * Options :
 *   --reason "<texte>"     obligatoire (consigné dans la grant et l'audit)
 *   --as <email>           l'humain qui accorde (défaut : ICOS_OWNER_EMAIL)
 *   --expires-at <ISO>     échéance optionnelle de la grant
 *   --only search|fetch    une seule des deux permissions
 *
 * Sécurité : aucune `DATABASE_URL`, aucun secret, aucun jeton n'est affiché ; le rapport ne
 * contient que des identifiants d'agent, d'outils et le résultat.
 */
import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";
import { getToolGatewayRuntime } from "@/server/tool-gateway/app";
import { grantRealtimeToRuntime } from "@/server/tool-gateway/realtime-grants";
import { isAgentRegistration } from "@/server/tool-gateway/runtime-agent";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") {
    throw new Error("PERSISTENCE=postgres est requis : une grant en mémoire ne porte rien.");
  }
  const reason = arg("reason");
  if (!reason?.trim()) throw new Error('--reason "<pourquoi>" est requis.');
  const email = arg("as") ?? env.ICOS_OWNER_EMAIL;
  if (!email) throw new Error("--as <email> ou ICOS_OWNER_EMAIL est requis.");
  const only = arg("only");
  if (only !== undefined && only !== "search" && only !== "fetch") {
    throw new Error("--only doit valoir search ou fetch.");
  }

  const container = await createContainer({ env });
  if (!container.users) throw new Error("Registre des utilisateurs indisponible.");
  const owner = await container.users.findByEmail(email);
  if (!owner) throw new Error("Utilisateur inconnu pour cet email.");
  if (!isAgentRegistration(container.agents))
    throw new Error("Registre des agents non inscriptible.");

  const runtime = await getToolGatewayRuntime(container);
  const result = await grantRealtimeToRuntime(
    { gateway: runtime.gateway, agents: container.agents },
    { owner, reason, expiresAt: arg("expires-at"), only },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.grants.some((g) => !g.ok)) process.exitCode = 1;
  /* Le conteneur garde un pool ouvert : sortir explicitement (cf. workforce-bootstrap). */
  process.exit(process.exitCode ?? 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "REALTIME_GRANT_FAILED");
  process.exit(1);
});
