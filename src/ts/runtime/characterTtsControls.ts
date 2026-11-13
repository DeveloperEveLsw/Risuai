// Portable character fields, not a browser-wide DBState save observer.
export const characterTtsFields = [
  "ttsMode",
  "ttsSpeech",
  "voicevoxConfig",
  "naittsConfig",
  "oaiVoice",
  "oaiTTSConfig",
  "hfTTS",
  "vits",
  "gptSoVitsConfig",
  "fishSpeechConfig",
  "ttsReadOnlyQuoted",
] as const;

// The original character/CharConfig defaults. Optional control-only values are
// displayed through getters; opening a missing configuration must not store it.
export const characterTtsDefaults: Record<string, any> = {
  voicevoxConfig: {
    SPEED_SCALE: 1,
    PITCH_SCALE: 0,
    INTONATION_SCALE: 1,
    VOLUME_SCALE: 1,
  },
  naittsConfig: { customvoice: false, voice: "Aini", version: "v2" },
  oaiTTSConfig: { enabled: false, format: "mp3" },
  hfTTS: { model: "", language: "en" },
  gptSoVitsConfig: {
    url: "",
    use_auto_path: false,
    ref_audio_path: "",
    use_long_audio: false,
    ref_audio_data: { fileName: "", assetId: "" },
    volume: 1,
    text_lang: "auto",
    text: "en",
    use_prompt: false,
    prompt_lang: "en",
    top_p: 1,
    temperature: 0.7,
    speed: 1,
    top_k: 5,
    text_split_method: "cut0",
  },
  fishSpeechConfig: {
    model: { _id: "", title: "", description: "" },
    chunk_length: 200,
    normalize: false,
  },
};

export function characterTtsConfig(values: Record<string, any>, key: string) {
  const fallback = characterTtsDefaults[key] ?? {};
  const value = values[key] ?? {};
  const result = { ...fallback, ...value };
  for (const nested of ["ref_audio_data", "model"])
    if (fallback[nested])
      result[nested] = { ...fallback[nested], ...value[nested] };
  return result;
}

export const characterTtsProviderConfig: Record<string, string> = {
  VOICEVOX: "voicevoxConfig",
  novelai: "naittsConfig",
  openai: "oaiTTSConfig",
  huggingface: "hfTTS",
  gptsovits: "gptSoVitsConfig",
  fishspeech: "fishSpeechConfig",
};
