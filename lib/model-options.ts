// Start with documented current model IDs. Older candidates are only exposed in
// the dropdown when /v1/models confirms the user's API key can access them.
export const DOCUMENTED_MODEL_FALLBACK = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const;

export const MODEL_CANDIDATES = [
  ...DOCUMENTED_MODEL_FALLBACK,
  "gpt-5",
  "gpt-5-mini",
  "o4-mini",
] as const;
