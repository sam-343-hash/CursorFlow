/**
 * src/ai/providerInterface.js
 *
 * Documents (and lightly enforces) the contract every AI provider must
 * follow, so the ensemble/planner code can call ANY provider identically
 * without knowing which one it is. This is what "do not hardcode one
 * provider" means in practice: every file that reasons about AI matching
 * talks to this shape, never to "Gemini" or "Groq" specifically.
 *
 * Required shape:
 *   {
 *     name: string                          - human-readable, shown in UI/logs
 *     isConfigured(settings): boolean        - can this provider run right now?
 *     matchIntent({goal, elements, settings}): Promise<number | 'DONE' | null>
 *   }
 *
 * `settings` is a plain object (e.g. { geminiApiKey, groqApiKey,
 * ollamaEnabled, ollamaUrl }) - providers only read the keys relevant to
 * them and ignore the rest, so adding a new provider never requires
 * changing this shared settings shape.
 */
(function () {
  function isValidProvider(provider) {
    return (
      !!provider &&
      typeof provider.name === 'string' &&
      provider.name.length > 0 &&
      typeof provider.isConfigured === 'function' &&
      typeof provider.matchIntent === 'function'
    );
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.ProviderInterface = { isValidProvider };
})();
