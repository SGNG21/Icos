/**
 * DÉTECTION D'ACTIVITÉ VOCALE, LOCALE ET PURE (P0-P). Aucune dépendance, aucun réseau,
 * aucune horloge : le temps est compté EN ÉCHANTILLONS, donc la même entrée donne toujours
 * la même sortie et un test n'a pas besoin d'attendre.
 *
 * ── POURQUOI ELLE EXISTE ────────────────────────────────────────────────────────────────
 * Sans elle, chaque tour demande un clic : c'est le push-to-talk qu'on remplace. C'est elle
 * qui découpe une conversation continue en tours, et c'est elle qui détecte le BARGE-IN
 * pendant qu'ICOS parle.
 *
 * ── POURQUOI ELLE EST LOCALE ────────────────────────────────────────────────────────────
 * Détecter la parole en envoyant l'audio ambiant à un service distant reviendrait à diffuser
 * en permanence le micro de Geoffrey pour décider s'il parle. L'énergie du signal se calcule
 * ici, sur l'appareil, et aucun octet ne part tant qu'un tour n'a pas commencé.
 *
 * ── HYSTÉRÉSIS, ET POURQUOI DEUX SEUILS ─────────────────────────────────────────────────
 * Un seuil unique fait clignoter la détection sur les respirations et coupe les mots au
 * milieu. On entre en parole plus haut qu'on n'en sort, et on exige une DURÉE des deux
 * côtés : `minSpeechMs` pour qu'un claquement de porte ne soit pas un tour, `hangoverMs`
 * pour qu'une pause entre deux mots n'en termine pas un.
 *
 * ponytail: RMS à seuil, pas un modèle. C'est le détecteur le plus simple qui segmente
 * vraiment, il n'ajoute aucune dépendance, et il se trompe dans un sens sans gravité (un
 * tour de trop part au STT, qui rend un transcript vide). Passer à un VAD spectral (WebRTC,
 * Silero WASM) si le bruit ambiant produit des tours vides mesurables.
 */

export interface VadConfig {
  /** RMS au-dessus duquel on considère qu'il y a de la parole. 0..1. */
  readonly startThreshold: number;
  /** RMS en dessous duquel on considère le silence. DOIT être < `startThreshold`. */
  readonly endThreshold: number;
  /** Durée minimale de parole avant d'émettre SPEECH_START : filtre les bruits brefs. */
  readonly minSpeechMs: number;
  /** Silence toléré À L'INTÉRIEUR d'un énoncé. C'est ce qui autorise les pauses. */
  readonly hangoverMs: number;
}

/**
 * Réglages par défaut, choisis pour une capture navigateur avec suppression de bruit et
 * contrôle de gain actifs (ce que demande `getUserMedia` dans le composant).
 */
export const DEFAULT_VAD: VadConfig = Object.freeze({
  startThreshold: 0.02,
  endThreshold: 0.01,
  minSpeechMs: 150,
  /* 700 ms : au-dessus d'une pause entre deux mots, en dessous d'une fin de phrase. */
  hangoverMs: 700,
});

export type VadEvent = "SPEECH_START" | "SPEECH_END";

export interface Vad {
  /** Pousse une trame. Rend l'évènement franchi par CETTE trame, ou `null`. */
  push(samples: Float32Array, sampleRate: number): VadEvent | null;
  /** Oublie tout : après un barge-in, une coupure, un changement de tour. */
  reset(): void;
  readonly speaking: boolean;
}

/** Énergie efficace de la trame. La seule mesure que ce module fait du son. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export function createVad(config: VadConfig = DEFAULT_VAD): Vad {
  if (!(config.endThreshold < config.startThreshold)) {
    /* Sans hystérésis la détection oscille : on refuse la configuration au lieu de clignoter. */
    throw new Error("VAD_CONFIG_INVALID: endThreshold doit être < startThreshold");
  }

  let speaking = false;
  /* Durées accumulées EN MILLISECONDES, dérivées du nombre d'échantillons vus. */
  let loudMs = 0;
  let quietMs = 0;

  return {
    get speaking() {
      return speaking;
    },
    reset() {
      speaking = false;
      loudMs = 0;
      quietMs = 0;
    },
    push(samples, sampleRate) {
      if (samples.length === 0 || sampleRate <= 0) return null;
      const frameMs = (samples.length / sampleRate) * 1000;
      const energy = rms(samples);

      if (!speaking) {
        /* Hors parole : seul le seuil HAUT compte, et il faut qu'il tienne. */
        if (energy >= config.startThreshold) {
          loudMs += frameMs;
          if (loudMs >= config.minSpeechMs) {
            speaking = true;
            quietMs = 0;
            return "SPEECH_START";
          }
        } else {
          loudMs = 0;
        }
        return null;
      }

      /* En parole : seul le seuil BAS compte, et une pause brève ne termine rien. */
      if (energy > config.endThreshold) {
        quietMs = 0;
        return null;
      }
      quietMs += frameMs;
      if (quietMs >= config.hangoverMs) {
        speaking = false;
        loudMs = 0;
        return "SPEECH_END";
      }
      return null;
    },
  };
}
