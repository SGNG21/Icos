/**
 * Amorçage de la WORKFORCE — adaptateur CLI MINCE autour de `bootstrapWorkforce()`
 * (aucune logique métier ici). Exécuté via `tsx` : `pnpm workforce:bootstrap`.
 *
 * Crée les douze cerveaux canoniques et leur accorde le MINIMUM d'outils que leurs rôles
 * certifiés déclarent. C'est un acte d'ADMINISTRATION : il ne tourne jamais au démarrage du
 * runtime, parce qu'un redéploiement ne doit pas accorder de pouvoirs. Idempotent — un
 * second passage ne crée ni ne réaccorde rien, et un passage interrompu se reprend.
 *
 * Sécurité : aucune `DATABASE_URL`, aucun secret, aucun jeton n'est affiché. Le rapport ne
 * contient que des identifiants d'agents, de rôles et d'outils.
 */
import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") {
    throw new Error("PERSISTENCE=postgres est requis : des cerveaux en mémoire ne portent rien.");
  }

  const container = await createContainer();
  if (!container.workforce) {
    throw new Error("La workforce n'est pas composée sur ce conteneur.");
  }

  /*
   * The authority the COMPOSED workforce uses, not a fresh one. `isIssued` is a WeakSet
   * membership test on the instance that issued the principal, so a second authority
   * produces principals the service rejects as "non émis" — which is what made this
   * command unrunnable.
   */
  const authority = { sessions: container.workforce.sessions };
  const ownerEmail = env.ICOS_OWNER_EMAIL;
  if (!ownerEmail) throw new Error("ICOS_OWNER_EMAIL est requis.");
  /*
   * L'ADMIN crée, active et accorde ; le CERTIFICATEUR certifie. Deux principals, parce que
   * `certifyRole` refuse qu'on certifie un rôle qu'on a soi-même composé. Les gabarits
   * livrés avec le dépôt sont créés par `workforce-bootstrap` (système), donc le
   * propriétaire peut les certifier — et un certificateur SYSTÈME, lui, reste refusé.
   */
  const admin = authority.sessions.fromSession({
    user: { id: ownerEmail, email: ownerEmail, status: "active" },
    roles: ["owner"],
  });
  const certifierEmail = process.env.ICOS_ROLE_CERTIFIER_EMAIL ?? ownerEmail;
  const certifier = authority.sessions.fromSession({
    user: { id: certifierEmail, email: certifierEmail, status: "active" },
    roles: [],
  });

  /* L'amorçage est exposé PAR la racine de composition : le magasin n'en sort jamais. */
  const report = await container.workforce.bootstrap(admin, certifier);

  console.log(
    JSON.stringify(
      {
        result: report.complete ? "workforce_ready" : "workforce_incomplete",
        rolesActivated: report.rolesActivated,
        rolesAlreadyActive: report.rolesAlreadyActive,
        brains: report.brains.results,
        grants: report.grants.results,
      },
      null,
      2,
    ),
  );
  /* Un amorçage incomplet doit faire échouer la commande : un succès partiel n'en est pas un. */
  if (!report.complete) process.exitCode = 1;

  /*
   * Sortir EXPLICITEMENT. Le conteneur garde un pool PostgreSQL et des minuteurs ouverts,
   * donc le processus restait vivant après avoir imprimé son rapport : la commande ne
   * rendait jamais la main et bloquait tout appel automatisé. Tout le travail est terminé
   * et affiché à ce point.
   */
  process.exit(process.exitCode ?? 0);
}

/*
 * Not a top-level await: tsx transforms these scripts to CJS, where one is a transform
 * error, so `pnpm workforce:bootstrap` could not run at all. Same shape as the other
 * scripts in here — a rejected bootstrap must still exit non-zero.
 */
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "WORKFORCE_BOOTSTRAP_FAILED");
  process.exit(1);
});
