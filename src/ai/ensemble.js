/**
 * src/ai/ensemble.js
 *
 * Runs EVERY configured provider at the same time and reconciles their
 * answers into one decision. This is provider-count-agnostic by design:
 * it works identically whether zero, one, two, or five providers are
 * configured - nothing here hardcodes "Gemini" or "Groq" specifically,
 * satisfying the "do not hardcode one provider" requirement structurally
 * rather than just in spirit.
 *
 * Reconciliation policy (unchanged in spirit from the previous version,
 * now generalized):
 *  - Zero providers configured -> free keyword fallback immediately.
 *  - All configured providers say "done" (goal already visible) and none
 *    give an actual element -> report alreadyDone, don't move the cursor.
 *  - All configured providers fail (rate limit, bad key, network) ->
 *    fall back to free keyword matching, but surface what went wrong.
 *  - Providers agree on the same element -> high confidence, use it.
 *  - Providers disagree -> use the highest-priority provider's answer
 *    (registry order), but report the disagreement transparently rather
 *    than silently picking a winner.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('ai.ensemble')
    : { debug() {}, warn() {} };

  async function runEnsemble({ goal, elements, providers, settings }) {
    const fallback = self.AICursor.KeywordFallback;

    if (!providers || providers.length === 0) {
      const index = fallback.match(goal, elements);
      return {
        index,
        note: index !== null
          ? 'Matched using free keyword search (no AI provider configured).'
          : 'No match found. Add a free AI provider (Gemini, Groq, or local Ollama) in Settings for smarter matching.',
      };
    }

    const tasks = providers.map((provider) =>
      provider.matchIntent({ goal, elements, settings })
        .then((index) => ({ provider: provider.name, index, error: null }))
        .catch((err) => ({ provider: provider.name, index: null, error: err.message }))
    );

    const results = await Promise.all(tasks);
    const labelOf = (i) => (elements[i] ? `"${elements[i].label}"` : `#${i}`);

    const doneVotes = results.filter((r) => r.index === 'DONE');
    const successful = results.filter((r) => r.index !== null && r.index !== 'DONE');
    const failed = results.filter((r) => r.error);

    if (doneVotes.length > 0 && successful.length === 0) {
      return {
        index: null,
        alreadyDone: true,
        note: `${doneVotes.map((r) => r.provider).join(' + ')} think${doneVotes.length === 1 ? 's' : ''} this is already visible on screen.`,
      };
    }

    if (successful.length === 0) {
      const index = fallback.match(goal, elements);
      const errorSummary = failed.map((f) => `${f.provider}: ${f.error}`).join(' | ');
      return {
        index,
        note: index !== null
          ? `AI providers unavailable (${errorSummary}). Used free keyword matching instead.`
          : `AI providers unavailable (${errorSummary}), and no keyword match found either.`,
      };
    }

    const uniqueIndexes = new Set(successful.map((r) => r.index));

    if (uniqueIndexes.size === 1) {
      const index = successful[0].index;
      const names = successful.map((r) => r.provider).join(' + ');
      return { index, note: `${names} agree: ${labelOf(index)}.` };
    }

    // Disagreement: `successful` preserves the registry's priority order
    // because `providers` (the input array) was already ordered by the
    // registry, and Promise.all preserves input order in its output.
    const primary = successful[0];
    const others = successful.slice(1);
    const disagreementText = others.map((r) => `${r.provider} suggested ${labelOf(r.index)}`).join(', ');
    return {
      index: primary.index,
      note: `${primary.provider} picked ${labelOf(primary.index)} (${disagreementText} - went with ${primary.provider}).`,
    };
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Ensemble = { runEnsemble };
})();
