/**
 * src/ai/providerRegistry.js
 *
 * The single place that knows about every provider that exists. Adding
 * a new provider (DeepSeek, Mistral, a hosted Llama endpoint, etc.)
 * means: (1) write a new file in src/ai/providers/ implementing the
 * shared interface, (2) add one line here. Nothing else in the codebase
 * needs to change - the ensemble, the planner, and the UI all just ask
 * this registry "which providers are configured right now."
 *
 * Order matters: it defines tiebreak priority when providers disagree
 * (see ensemble.js) - earlier in the list wins ties, not because it's
 * "better" in the abstract, but because a deterministic tiebreak is
 * better than a random one for reproducible behavior.
 */
(function () {
  function getAllProviders() {
    const p = self.AICursor.Providers || {};
    // Explicit order = explicit tiebreak priority.
    return [p.gemini, p.groq, p.ollama].filter((provider) => !!provider);
  }

  function getConfiguredProviders(settings) {
    return getAllProviders().filter((provider) => {
      try {
        return provider.isConfigured(settings);
      } catch (e) {
        return false;
      }
    });
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.ProviderRegistry = { getAllProviders, getConfiguredProviders };
})();
