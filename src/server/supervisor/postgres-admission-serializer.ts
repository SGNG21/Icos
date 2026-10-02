import { lockKey } from "@/server/memory/sql";
import type { AdmissionSerializer } from "./objective-coordinator";

/** Le minimum nécessaire : ouvrir une transaction dans laquelle exécuter une requête. */
export interface AdmissionTxCapable {
  transaction<T>(
    fn: (tx: { execute(query: ReturnType<typeof lockKey>): Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
}

/**
 * SÉRIALISATION DE L'ADMISSION EN BASE (verrou C7).
 *
 * Le défaut : `admit()` lisait la charge, décidait, puis enfilait, sans rien entre les trois.
 * Deux approbations simultanées observaient donc le même « 0 actif » et étaient toutes deux
 * admises — un plafond de classe à 1 en laissait passer autant qu'il y avait d'appels.
 *
 * Pourquoi un verrou consultatif et pas une contrainte : la règle est « le NOMBRE de lignes
 * actives d'une classe ne doit pas dépasser N », qui ne s'exprime ni en CHECK ni en UNIQUE.
 * La sérialisation EST la contrainte — même forme que `postgres-spend-reservations.ts`.
 *
 * Pourquoi en base et pas en mémoire : une file de promesses par processus donne à chaque
 * processus son propre plafond. Deux instances, deux fois le plafond.
 *
 * ponytail: UN verrou global pour toute l'admission, pas un par classe de travail. Les
 * admissions sont rares et brèves (deux lectures filtrées et un enfilement) et le plafond
 * GLOBAL les couple de toute façon, donc un verrou par classe ne ferait gagner de la
 * concurrence que là où il n'y en a pas besoin. Passer à une clé par classe si l'admission
 * devient un point chaud mesuré.
 *
 * PLAFOND ASSUMÉ : la transaction porteuse du verrou reste OUVERTE pendant que le corps
 * s'exécute sur d'AUTRES connexions du pool. C'est ce qui rend l'exclusion réelle, et cela
 * immobilise une connexion le temps d'une admission. Acceptable parce qu'une admission est
 * courte ; à revoir si elle devient longue.
 */
export function postgresAdmission(
  db: AdmissionTxCapable,
  scope = "icos.admission",
): AdmissionSerializer {
  return <T>(fn: () => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.execute(lockKey(scope));
      return fn();
    });
}
