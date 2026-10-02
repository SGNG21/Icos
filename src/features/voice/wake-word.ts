/**
 * MOT-CLÉ « ICOS » — LE PORT, ET RIEN QUE LE PORT (P0-P optionnel).
 *
 * ÉTAT HONNÊTE, à reporter tel quel :
 *   WAKE_WORD_ICOS   = DESIGNED     (l'interface, l'état et les garanties existent)
 *   WAKE_WORD_LOCAL  = PORT_READY   (un moteur local se branche sans rien redessiner)
 *   WAKE_WORD_PROVEN = NO           (AUCUN moteur n'est fourni : rien ne détecte « ICOS »)
 *
 * Aucun Porcupine, aucun openWakeWord, aucune clé d'accès, aucune dépendance ajoutée. Le
 * détecteur par défaut ne détecte RIEN et le dit ({@link NO_WAKE_WORD_DETECTOR}). Un
 * interrupteur qui prétendrait écouter sans moteur serait exactement le genre de mensonge
 * d'interface que ce lot existe pour supprimer.
 *
 * ── LES GARANTIES, QUI SONT DANS LA FORME DU PORT ───────────────────────────────────────
 *
 * 1. AUCUN FLUX AMBIANT VERS LE NUAGE. `WakeWordDetector.push` reçoit des échantillons et
 *    rend un booléen, SYNCHRONEMENT. Il ne peut ni attendre, ni renvoyer de promesse, ni
 *    donc faire d'appel réseau : un détecteur distant est INEXPRIMABLE dans ce type. C'est
 *    une garantie structurelle, pas une consigne dans un commentaire.
 *
 * 2. DÉSARMÉ PAR DÉFAUT. `WakeWordMode` vaut `"OFF"` dans `initialSessionState`. Rien
 *    n'arme l'écoute sans un geste de Geoffrey.
 *
 * 3. L'ÉTAT DU MICRO RESTE VISIBLE. Armer le mot-clé ouvre une capture, donc
 *    `micIsCapturing` devient vrai et l'interface doit le montrer — c'est le même indicateur
 *    que pour une session ordinaire, il n'y a pas d'écoute « discrète ».
 *
 * 4. LE MOT-CLÉ N'AUTORISE RIEN. Il ne fait qu'OUVRIR une session
 *    (`WAKE_WORD_DETECTED` -> `sessionRequested`). Tout ce qui est dit ensuite emprunte le
 *    chemin normal — Cognitive Intake, Policy, approbations, budgets, autorité de mission.
 *    « ICOS, supprime X » n'a pas plus de pouvoir que la même phrase tapée au clavier.
 *
 * 5. AUCUN AUDIO AMBIANT N'EST CONSERVÉ. Le port n'expose aucun moyen de rendre de l'audio ;
 *    les trames traversent `push` et sont oubliées. La rétention reste celle de
 *    `DEFAULT_RETENTION` (`core/voice/contracts.ts`) : `audio: "none"`.
 */

export interface WakeWordDetector {
  /** Identifiant du moteur, pour que l'interface puisse dire CE QUI écoute. */
  readonly id: string;
  /** `false` quand aucun moteur réel n'est branché : l'interface ne doit pas promettre. */
  readonly available: boolean;
  /** Le mot attendu, en clair. Un seul aujourd'hui. */
  readonly phrase: string;
  /**
   * Pousse une trame locale. Rend `true` SI ET SEULEMENT SI le mot-clé vient d'être
   * reconnu. SYNCHRONE par contrat : voir la garantie 1 ci-dessus.
   */
  push(samples: Float32Array, sampleRate: number): boolean;
  reset(): void;
}

/**
 * LE DÉTECTEUR PAR DÉFAUT : il n'entend rien, et c'est la vérité de l'implémentation
 * actuelle. `available: false` permet à l'interface de proposer l'interrupteur tout en
 * disant qu'aucun moteur n'est installé, au lieu d'afficher une écoute qui n'existe pas.
 */
export const NO_WAKE_WORD_DETECTOR: WakeWordDetector = Object.freeze({
  id: "none",
  available: false,
  phrase: "ICOS",
  push: () => false,
  reset: () => undefined,
});

/**
 * Ce que l'interface a besoin de savoir pour ne rien promettre de faux.
 *
 * `listening` n'est vrai que si le mode est armé ET qu'un moteur existe : un interrupteur
 * sur ON sans moteur affiche « aucun moteur installé », jamais « à l'écoute ».
 */
export interface WakeWordStatus {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly listening: boolean;
  readonly phrase: string;
  readonly explanation: string;
}

export function wakeWordStatus(
  mode: "OFF" | "ARMED",
  detector: WakeWordDetector = NO_WAKE_WORD_DETECTOR,
): WakeWordStatus {
  const enabled = mode === "ARMED";
  const listening = enabled && detector.available;
  return {
    enabled,
    available: detector.available,
    listening,
    phrase: detector.phrase,
    explanation: !detector.available
      ? `Aucun moteur local installé : « ${detector.phrase} » n'est pas détecté.`
      : listening
        ? `À l'écoute de « ${detector.phrase} », sur l'appareil uniquement.`
        : `Détection de « ${detector.phrase} » désactivée.`,
  };
}
