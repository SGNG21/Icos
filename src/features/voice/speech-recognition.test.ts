import { describe, expect, it, vi } from "vitest";

import {
  createSpeechRecognitionController,
  recognitionError,
} from "./speech-recognition";

describe("speech recognition", () => {
  it("reports unsupported browsers without faking transcription", () => {
    const onError = vi.fn();
    const controller = createSpeechRecognitionController(
      { onFinalTranscript: vi.fn(), onError },
      undefined,
    );

    expect(controller.supported).toBe(false);
    controller.start();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "unsupported_recognition" }),
    );
  });

  it("maps denied microphone permission", () => {
    expect(recognitionError("not-allowed").code).toBe("permission_denied");
  });

  it("maps no-speech", () => {
    expect(recognitionError("no-speech").code).toBe("no_speech");
  });
});
