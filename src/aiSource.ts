/** Who wrote an AI answer, for the small label under drafts and explanations. */
export function aiSourceLabel(source: string, model?: string | null): string {
  const named = (name: string) => (model ? `${name} (${model})` : name);
  switch (source) {
    case "claude": return named("Claude");
    case "ollama": return named("Ollama");
    case "llamacpp": return named("self-hosted llama.cpp");
    case "network": return named("network AI server");
    default: return "offline summary";
  }
}
