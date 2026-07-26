import { describe, expect, it, vi } from "vitest";

import {
  createSpeechSynthesisController,
  pickFrenchVoice,
} from "./speech-synthesis";

describe("speech synthesis", () => {
  it("prefers a French voice", () => {
    const voices = [
      { lang: "en-US" },
      { lang: "fr-FR" },
    ] as SpeechSynthesisVoice[];

    expect(pickFrenchVoice(voices)?.lang).toBe("fr-FR");
  });

  it("reports unsupported synthesis", () => {
    const onError = vi.fn();
    const controller = createSpeechSynthesisController(undefined);
    expect(controller.supported).toBe(false);
    controller.speak("Bonjour", { onError });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "unsupported_synthesis" }),
    );
  });
});
