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
import { createPrincipalAuthority } from "@/server/workforce/principals";
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

  const authority = createPrincipalAuthority();
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
}

await main();
