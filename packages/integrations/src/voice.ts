import { z } from "zod";
import { attempt, IntegrationError, requestJson } from "./result.js";
import type { Fetch } from "./result.js";

export class ElevenLabs {
  constructor(private readonly config: { apiKey?: string; model?: string; fetch?: Fetch }) {}
  transcribe(audio: Blob) {
    return attempt("elevenlabs", Boolean(this.config.apiKey && this.config.model), async () => {
      if (audio.size === 0 || audio.size > 20 * 1024 * 1024) throw new IntegrationError("INVALID_AUDIO_SIZE");
      if (!/^(audio\/(webm|wav|mpeg|mp4|ogg)|video\/webm)(;.*)?$/.test(audio.type)) throw new IntegrationError("INVALID_AUDIO_TYPE");
      const body = new FormData();
      body.set("model_id", this.config.model!);
      body.set("file", audio, "private-intake");
      body.set("tag_audio_events", "false");
      body.set("diarize", "false");
      const result = z.object({ text: z.string().trim().min(1), language_code: z.string().optional() }).parse(
        await requestJson(this.config.fetch ?? fetch, "https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST", headers: { "xi-api-key": this.config.apiKey! }, body,
        }, 45_000));
      return { ...result, requiresConfirmation: true as const };
    });
  }
}
