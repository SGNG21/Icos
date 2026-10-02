import { describe, expect, it } from "vitest";

import { NO_WAKE_WORD_DETECTOR, wakeWordStatus, type WakeWordDetector } from "./wake-word";
import {
  initialSessionState,
  micIsCapturing,
  reduceVoiceSession,
  voicePhase,
  type VoiceSessionEvent,
} from "./voice-session-machine";

/**
 * MOT-CLÉ « ICOS » — ce qui est réellement livré, et ce qui ne l'est pas.
 *
 * Aucun moteur n'est fourni. Ces preuves portent donc sur la FORME du port et sur le fait
 * que l'interface ne peut pas prétendre écouter ce que rien ne détecte.
 */

/** Un moteur local FACTICE, pour prouver la forme — jamais livré en production. */
const fakeDetector = (): WakeWordDetector => {
  let heard = false;
  return {
    id: "fake-local",
    available: true,
    phrase: "ICOS",
    push: () => {
      const was = heard;
      heard = true;
      return !was;
    },
    reset: () => {
      heard = false;
    },
  };
};

describe("port mot-clé — aucun moteur livré, et c'est dit", () => {
  it("le détecteur par défaut n'entend RIEN et se déclare indisponible", () => {
    expect(NO_WAKE_WORD_DETECTOR.available).toBe(false);
    expect(NO_WAKE_WORD_DETECTOR.push(new Float32Array(320), 16_000)).toBe(false);
  });

  it("ARMÉ SANS MOTEUR, l'interface dit « aucun moteur », jamais « à l'écoute »", () => {
    const status = wakeWordStatus("ARMED");
    expect(status.enabled).toBe(true);
    expect(status.listening).toBe(false);
    expect(status.explanation).toMatch(/Aucun moteur local installé/);
  });

  it("avec un moteur, ARMÉ dit l'écoute, et précise qu'elle est LOCALE", () => {
    const status = wakeWordStatus("ARMED", fakeDetector());
    expect(status.listening).toBe(true);
    expect(status.explanation).toMatch(/sur l'appareil uniquement/);
  });

  it("DÉSARMÉ ne prétend jamais écouter, même avec un moteur disponible", () => {
    const status = wakeWordStatus("OFF", fakeDetector());
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
  });
});

describe("garanties de vie privée, tenues par la FORME du port", () => {
  it("`push` est SYNCHRONE : un détecteur distant est inexprimable", () => {
    /*
     * La garantie qui compte. `push` rend un `boolean`, pas une promesse : une
     * implémentation ne peut pas attendre un aller-retour réseau, donc elle ne peut pas
     * diffuser l'audio ambiant vers un modèle distant pour décider. Ce n'est pas une
     * consigne dans un commentaire, c'est le type.
     */
    const result: boolean = NO_WAKE_WORD_DETECTOR.push(new Float32Array(320), 16_000);
    expect(typeof result).toBe("boolean");
    /* `boolean` et non `Promise<boolean>` : le type seul interdit l'aller-retour réseau. */
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
  });

  it("le port n'expose AUCUN moyen de rendre de l'audio : rien n'est conservé", () => {
    /* Les seules clés sont l'identité, la disponibilité, la phrase et deux fonctions. */
    expect(Object.keys(NO_WAKE_WORD_DETECTOR).sort()).toEqual([
      "available",
      "id",
      "phrase",
      "push",
      "reset",
    ]);
  });

  it("le mot-clé n'AUTORISE rien : il ouvre une session, point", () => {
    /*
     * « ICOS, supprime X » n'a pas plus de pouvoir que la même phrase tapée. L'évènement
     * ne touche QUE `sessionRequested` : aucune autorité, aucune approbation, aucun budget.
     */
    const armed = reduceVoiceSession(initialSessionState, {
      type: "WAKE_WORD_MODE",
      mode: "ARMED",
    });
    const woken = reduceVoiceSession(armed, { type: "WAKE_WORD_DETECTED", at: 1 });
    const changed = (Object.keys(woken) as (keyof typeof woken)[]).filter(
      (key) => woken[key] !== armed[key],
    );
    expect(changed.sort()).toEqual(["lastActivityAt", "sessionRequested"]);
  });

  it("une session ouverte par mot-clé rend le micro VISIBLE comme toute autre", () => {
    const armed = reduceVoiceSession(initialSessionState, {
      type: "WAKE_WORD_MODE",
      mode: "ARMED",
    });
    const woken = (
      [
        { type: "WAKE_WORD_DETECTED", at: 1 },
        { type: "LINK", link: "ready" },
        { type: "MIC_OPENED", at: 1 },
      ] satisfies VoiceSessionEvent[]
    ).reduce(reduceVoiceSession, armed);
    expect(micIsCapturing(woken)).toBe(true);
    expect(voicePhase(woken)).toBe("LISTENING");
  });
});
