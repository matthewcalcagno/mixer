const LOCAL_SPEECH_ENV_KEYS = [
  "MIXER_LOCAL_MODELS_DIR",
  "MIXER_DICTATION_LOCAL_STT_MODEL",
  "MIXER_VOICE_LOCAL_STT_MODEL",
  "MIXER_VOICE_LOCAL_TTS_MODEL",
  "MIXER_VOICE_LOCAL_TTS_SPEAKER_ID",
  "MIXER_VOICE_LOCAL_TTS_SPEED",
] as const;

const DISABLED_E2E_SPEECH_ENV = {
  MIXER_DICTATION_ENABLED: "0",
  MIXER_VOICE_MODE_ENABLED: "0",
  MIXER_DICTATION_STT_PROVIDER: "openai",
  MIXER_VOICE_TURN_DETECTION_PROVIDER: "openai",
  MIXER_VOICE_STT_PROVIDER: "openai",
  MIXER_VOICE_TTS_PROVIDER: "openai",
} as const;

export function withDisabledE2ESpeechEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Default app E2E does not cover speech flows; keep restarts from starting
  // background local-model downloads for unrelated tests.
  const next: NodeJS.ProcessEnv = {
    ...env,
    ...DISABLED_E2E_SPEECH_ENV,
  };

  for (const key of LOCAL_SPEECH_ENV_KEYS) {
    delete next[key];
  }

  return next;
}
