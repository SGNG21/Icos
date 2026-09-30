// AudioWorklet for /voice (decision 0061): copies each 128-sample render quantum
// to the main thread. A same-origin file, not a blob: URL (iOS Safari).
class IcosVoiceTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("icos-voice-tap", IcosVoiceTap);
