import { describe, expect, it } from "vitest";

import {
  DEFAULT_INACTIVITY_MS,
  inactivityExpired,
  initialSessionState,
  MAX_RECONNECT_ATTEMPTS,
  micIsCapturing,
  reduceVoiceSession,
  voicePhase,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "./voice-session-machine";

/**
 * LA SESSION VOCALE CONTINUE (P0-P), prouvée sur la couche pure.
 *
 * Ce qui est prouvé ici : un seul clic ouvre et ferme, les tours s'enchaînent SANS clic
 * intermédiaire, le barge-in coupe ICOS immédiatement, une pause ne ferme rien, et aucune
 * phase ne peut mentir sur le micro ou le transport.
 *
 * Ce qui n'est PAS prouvé ici : qu'un vrai micro s'ouvre et qu'un vrai WebSocket parle.
 * C'est le composant React, et ça se vérifie dans un navigateur — un test qui simulerait
 * `getUserMedia` ne prouverait que la fidélité du simulacre.
 */

const run = (events: VoiceSessionEvent[], from = initialSessionState): VoiceSessionState =>
  events.reduce(reduceVoiceSession, from);

/** Une session ouverte, transport prêt, micro réellement ouvert. */
const live = (at = 1_000) =>
  run([
    { type: "TOGGLE_SESSION", at },
    { type: "LINK", link: "ready" },
    { type: "MIC_OPENED", at },
  ]);

/** Un tour complet : parole, fin d'énoncé, réponse, audio, fin d'audio. */
const turn = (from: VoiceSessionState, at: number): VoiceSessionState =>
  run(
    [
      { type: "SPEECH_START", at },
      { type: "SPEECH_END", at: at + 1_000 },
      { type: "RESPONSE_STARTED" },
      { type: "ICOS_AUDIO_STARTED" },
      { type: "ICOS_AUDIO_ENDED", at: at + 4_000 },
    ],
    from,
  );

describe("session vocale — UN SEUL bouton ouvre et ferme", () => {
  it("part de OFF, micro fermé", () => {
    expect(voicePhase(initialSessionState)).toBe("OFF");
    expect(micIsCapturing(initialSessionState)).toBe(false);
  });

  it("le MÊME évènement ouvre puis ferme : c'est un seul bouton", () => {
    const open = reduceVoiceSession(initialSessionState, { type: "TOGGLE_SESSION", at: 1 });
    expect(open.sessionRequested).toBe(true);
    const closed = reduceVoiceSession(open, { type: "TOGGLE_SESSION", at: 2 });
    expect(voicePhase(closed)).toBe("OFF");
    expect(micIsCapturing(closed)).toBe(false);
  });

  it("ferme depuis N'IMPORTE QUELLE phase, y compris pendant qu'ICOS parle", () => {
    const speaking = run(
      [
        { type: "SPEECH_START", at: 2_000 },
        { type: "SPEECH_END", at: 3_000 },
        { type: "ICOS_AUDIO_STARTED" },
      ],
      live(),
    );
    expect(voicePhase(speaking)).toBe("ICOS_SPEAKING");
    expect(voicePhase(reduceVoiceSession(speaking, { type: "TOGGLE_SESSION", at: 4_000 }))).toBe(
      "OFF",
    );
  });
});

describe("aucune phase ne ment sur le micro ni sur le transport", () => {
  it("JAMAIS LISTENING quand le micro n'est pas réellement ouvert", () => {
    const requested = run([
      { type: "TOGGLE_SESSION", at: 1 },
      { type: "LINK", link: "ready" },
    ]);
    /* Transport prêt, mais la piste micro n'est pas ouverte : on CONNECTE. */
    expect(requested.micOpen).toBe(false);
    expect(voicePhase(requested)).toBe("CONNECTING");
    expect(micIsCapturing(requested)).toBe(false);
  });

  it("JAMAIS LISTENING quand le transport est tombé, micro ouvert ou pas", () => {
    for (const link of ["connecting", "reconnecting", "offline", "unavailable"] as const) {
      const state = reduceVoiceSession(live(), { type: "LINK", link });
      expect(voicePhase(state), link).not.toBe("LISTENING");
    }
  });

  it("une permission micro RÉVOQUÉE en pleine session termine la session et dit pourquoi", () => {
    const denied = reduceVoiceSession(live(), {
      type: "MIC_DENIED",
      message: "micro révoqué",
    });
    expect(voicePhase(denied)).toBe("ERROR");
    expect(denied.fatal).toBe("micro révoqué");
    expect(micIsCapturing(denied)).toBe(false);
  });

  it("LISTENING exige les DEUX : micro ouvert ET transport prêt", () => {
    expect(voicePhase(live())).toBe("LISTENING");
    expect(micIsCapturing(live())).toBe(true);
  });
});

describe("conversation continue — aucun clic entre deux tours", () => {
  it("revient AUTOMATIQUEMENT à l'écoute quand ICOS a fini de parler", () => {
    const after = turn(live(), 2_000);
    expect(voicePhase(after)).toBe("LISTENING");
    expect(after.sessionRequested).toBe(true);
    expect(after.micOpen).toBe(true);
  });

  it("enchaîne TROIS tours sans un seul TOGGLE_SESSION", () => {
    let state = live();
    const phases: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      state = reduceVoiceSession(state, { type: "SPEECH_START", at: 2_000 + i * 10_000 });
      phases.push(voicePhase(state));
      state = reduceVoiceSession(state, { type: "SPEECH_END", at: 3_000 + i * 10_000 });
      phases.push(voicePhase(state));
      state = reduceVoiceSession(state, { type: "ICOS_AUDIO_STARTED" });
      phases.push(voicePhase(state));
      state = reduceVoiceSession(state, { type: "ICOS_AUDIO_ENDED", at: 6_000 + i * 10_000 });
      phases.push(voicePhase(state));
    }
    expect(phases).toEqual(
      Array.from({ length: 3 }).flatMap(() => [
        "USER_SPEAKING",
        "THINKING",
        "ICOS_SPEAKING",
        "LISTENING",
      ]),
    );
  });

  it("une PAUSE entre deux phrases ne ferme rien", () => {
    const paused = turn(live(), 2_000);
    expect(inactivityExpired(paused, paused.lastActivityAt + 30_000)).toBe(false);
    expect(voicePhase(paused)).toBe("LISTENING");
  });

  it("un silence prolongé ferme, selon la politique d'inactivité et pas avant", () => {
    const idle = turn(live(), 2_000);
    expect(inactivityExpired(idle, idle.lastActivityAt + DEFAULT_INACTIVITY_MS - 1)).toBe(false);
    expect(inactivityExpired(idle, idle.lastActivityAt + DEFAULT_INACTIVITY_MS)).toBe(true);
    expect(voicePhase(reduceVoiceSession(idle, { type: "INACTIVITY_TIMEOUT" }))).toBe("OFF");
  });

  it("l'inactivité ne compte PAS pendant qu'on parle ou qu'ICOS répond", () => {
    const thinking = run(
      [
        { type: "SPEECH_START", at: 2_000 },
        { type: "SPEECH_END", at: 3_000 },
      ],
      live(),
    );
    expect(voicePhase(thinking)).toBe("THINKING");
    /* Une réponse longue n'est pas de l'inactivité : la session ne doit pas se fermer. */
    expect(inactivityExpired(thinking, 3_000 + DEFAULT_INACTIVITY_MS * 2)).toBe(false);
  });
});

describe("barge-in — la parole de Geoffrey prime sur celle d'ICOS", () => {
  const speaking = () =>
    run(
      [
        { type: "SPEECH_START", at: 2_000 },
        { type: "SPEECH_END", at: 3_000 },
        { type: "ICOS_AUDIO_STARTED" },
      ],
      live(),
    );

  it("parler pendant qu'ICOS parle passe en INTERRUPTED, sans attendre la fin", () => {
    const barged = reduceVoiceSession(speaking(), { type: "SPEECH_START", at: 4_000 });
    expect(voicePhase(barged)).toBe("INTERRUPTED");
  });

  it("une fois l'audio RÉELLEMENT coupé, la nouvelle parole est capturée", () => {
    const capturing = run(
      [{ type: "SPEECH_START", at: 4_000 }, { type: "PLAYBACK_STOPPED" }],
      speaking(),
    );
    expect(voicePhase(capturing)).toBe("USER_SPEAKING");
  });

  it("le nouvel énoncé devient un tour entier : rien n'est perdu", () => {
    const next = run(
      [
        { type: "SPEECH_START", at: 4_000 },
        { type: "PLAYBACK_STOPPED" },
        { type: "SPEECH_END", at: 5_000 },
      ],
      speaking(),
    );
    expect(voicePhase(next)).toBe("THINKING");
  });

  it("un audio d'ICOS arrivé EN RETARD ne vole pas le tour de Geoffrey", () => {
    /*
     * La course réelle : la première syllabe de Geoffrey arrive avant le dernier paquet TTS.
     * Repasser en ICOS_SPEAKING lui couperait la parole qu'il vient de prendre.
     */
    const barged = run(
      [
        { type: "SPEECH_START", at: 4_000 },
        { type: "PLAYBACK_STOPPED" },
        { type: "ICOS_AUDIO_STARTED" },
      ],
      speaking(),
    );
    expect(voicePhase(barged)).toBe("USER_SPEAKING");
  });

  it("une fin d'audio tardive ne renvoie pas à l'écoute pendant qu'il parle", () => {
    const barged = run(
      [
        { type: "SPEECH_START", at: 4_000 },
        { type: "PLAYBACK_STOPPED" },
        { type: "ICOS_AUDIO_ENDED", at: 4_100 },
      ],
      speaking(),
    );
    expect(voicePhase(barged)).toBe("USER_SPEAKING");
  });
});

describe("reconnexion — bornée, et honnête quand elle échoue", () => {
  it("LISTENING -> RECONNECTING -> LISTENING, sans perdre la session", () => {
    const dropped = reduceVoiceSession(live(), { type: "LINK", link: "reconnecting" });
    expect(voicePhase(dropped)).toBe("RECONNECTING");
    const back = reduceVoiceSession(dropped, { type: "LINK", link: "ready" });
    expect(voicePhase(back)).toBe("LISTENING");
    expect(back.sessionRequested).toBe(true);
  });

  it("abandonne après un nombre BORNÉ de tentatives et explique, au lieu de tourner", () => {
    let state = live();
    for (let i = 0; i <= MAX_RECONNECT_ATTEMPTS; i += 1) {
      state = reduceVoiceSession(state, { type: "LINK", link: "reconnecting" });
    }
    expect(voicePhase(state)).toBe("DEGRADED");
    expect(state.degraded).toMatch(/reconnexion abandonnée/);
  });

  it("une reprise réussie remet le compteur à zéro : la borne reste une borne", () => {
    let state = live();
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i += 1) {
      state = reduceVoiceSession(state, { type: "LINK", link: "reconnecting" });
    }
    state = reduceVoiceSession(state, { type: "LINK", link: "ready" });
    expect(state.reconnectAttempts).toBe(0);
    expect(voicePhase(state)).toBe("LISTENING");
  });

  it("DEGRADED reste utilisable et se répare ; ERROR termine la session", () => {
    const degraded = reduceVoiceSession(live(), { type: "DEGRADED", message: "voix muette" });
    expect(voicePhase(degraded)).toBe("DEGRADED");
    expect(degraded.sessionRequested).toBe(true);
    expect(voicePhase(reduceVoiceSession(degraded, { type: "RECOVERED" }))).toBe("LISTENING");

    const fatal = reduceVoiceSession(live(), { type: "FATAL", message: "transport perdu" });
    expect(voicePhase(fatal)).toBe("ERROR");
    expect(fatal.sessionRequested).toBe(false);
    expect(fatal.fatal).toBe("transport perdu");
  });

  it("recliquer après une erreur efface l'erreur : « réessayer » veut dire ça", () => {
    const fatal = reduceVoiceSession(live(), { type: "FATAL", message: "transport perdu" });
    const retried = reduceVoiceSession(fatal, { type: "TOGGLE_SESSION", at: 9_000 });
    expect(retried.fatal).toBeNull();
    expect(retried.sessionRequested).toBe(true);
  });
});

describe("mot-clé « ICOS » — désarmé par défaut, et sans aucun pouvoir propre", () => {
  it("est OFF par défaut : une écoute permanente ne s'active jamais par omission", () => {
    expect(initialSessionState.wakeWord).toBe("OFF");
  });

  it("DÉSARMÉ, le mot-clé n'ouvre rien", () => {
    const heard = reduceVoiceSession(initialSessionState, {
      type: "WAKE_WORD_DETECTED",
      at: 1,
    });
    expect(voicePhase(heard)).toBe("OFF");
  });

  it("ARMÉ, il ouvre une session ORDINAIRE : même machine, même micro visible", () => {
    const armed = reduceVoiceSession(initialSessionState, {
      type: "WAKE_WORD_MODE",
      mode: "ARMED",
    });
    const woken = run(
      [
        { type: "WAKE_WORD_DETECTED", at: 1 },
        { type: "LINK", link: "ready" },
        { type: "MIC_OPENED", at: 1 },
      ],
      armed,
    );
    expect(voicePhase(woken)).toBe("LISTENING");
    /* L'indicateur micro est le MÊME : il n'existe pas d'écoute « discrète ». */
    expect(micIsCapturing(woken)).toBe(true);
  });

  it("le mode survit à l'arrêt de la session : c'est un réglage, pas un état de session", () => {
    const armed = reduceVoiceSession(initialSessionState, {
      type: "WAKE_WORD_MODE",
      mode: "ARMED",
    });
    const stopped = run(
      [
        { type: "TOGGLE_SESSION", at: 1 },
        { type: "TOGGLE_SESSION", at: 2 },
      ],
      armed,
    );
    expect(stopped.wakeWord).toBe("ARMED");
  });
});
