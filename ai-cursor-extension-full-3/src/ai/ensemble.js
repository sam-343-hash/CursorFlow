/**
 * src/ai/ensemble.js
 *
 * Runs EVERY configured provider at the same time and reconciles their
 * answers into one decision. This is provider-count-agnostic by design:
 * it works identically whether zero, one, two, or five providers are
 * configured - nothing here hardcodes "Gemini" or "Groq" specifically.
 *
 * Decision normalization:
 * A provider's raw matchIntent() result can be: null, the string 'DONE',
 * a bare number (legacy/simple providers, and what the test suite's fake
 * providers return directly), or a structured { index, action, value }
 * object (what the real providers now return via PromptBuilder's
 * click/type protocol). normalizeDecision() converts all of these into
 * one consistent shape before any reconciliation logic runs, so the rest
 * of this file never needs to care which form a given provider used.
 *
 * Speed design - an "Instant" tier before the "Thinking" tier:
 * Before paying the latency and API cost of a network round-trip to any
 * AI provider, this checks whether the free keyword matcher found an
 * unambiguous, exact match (every meaningful word in the goal literally
 * appears in one element's label, with enough words to be a specific
 * instruction). If so, it uses that immediately and skips calling any
 * provider for that step. The instant tier is click-only by nature - it
 * has no way to infer what value should be typed, so any goal that needs
 * typing (e.g. a filename) will not match instantly and correctly falls
 * through to full AI reasoning.
 *
 * Reconciliation policy:
 *  - Zero providers configured -> free keyword fallback immediately.
 *  - An unambiguous instant match exists -> use it, skip AI entirely.
 *  - All configured providers say "done" -> report alreadyDone.
 *  - All configured providers fail -> fall back to free keyword matching.
 *  - Providers agree on the same decision (index + action + value) ->
 *    high confidence, use it.
 *  - Providers disagree -> use the highest-priority provider's answer
 *    (registry order), but report the disagreement transparently.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('ai.ensemble')
    : { debug() {}, warn() {} };

  const INSTANT_MATCH_MIN_TOKENS = 2;
  const INSTANT_MATCH_MIN_CONFIDENCE = 1.0;

  /**
   * Converts any provider's raw matchIntent() result into one consistent
   * shape: null | 'DONE' | { index, action, value? }.
   */
  function normalizeDecision(raw) {
    if (raw === null || raw === undefined) return null;
    if (raw === 'DONE') return 'DONE';
    if (typeof raw === 'number') return { index: raw, action: 'click' };
    if (typeof raw === 'object' && typeof raw.index === 'number') {
      const normalized = { index: raw.index, action: raw.action || 'click' };
      if (raw.action === 'type') normalized.value = raw.value;
      return normalized;
    }
    return null;
  }

  function decisionKey(decision) {
    return `${decision.index}:${decision.action}:${decision.value || ''}`;
  }

  async function runEnsemble({ goal, elements, providers, settings }) {
    const fallback = self.AICursor.KeywordFallback;

    if (!providers || providers.length === 0) {
      const index = fallback.match(goal, elements);
      return {
        index,
        action: 'click',
        note: index !== null
          ? 'Matched using free keyword search (no AI provider configured).'
          : 'No match found. Add a free AI provider (Gemini, Groq, or local Ollama) in Settings for smarter matching.',
      };
    }

    // --- INSTANT TIER: skip the AI call entirely for unambiguous matches ---
    const instantCheck = fallback.matchWithScore(goal, elements);
    if (
      instantCheck.index !== null &&
      instantCheck.tokenCount >= INSTANT_MATCH_MIN_TOKENS &&
      instantCheck.confidence >= INSTANT_MATCH_MIN_CONFIDENCE
    ) {
      logger.debug('Instant match found, skipping AI call', instantCheck);
      return {
        index: instantCheck.index,
        action: 'click',
        note: `Instant match: "${elements[instantCheck.index].label}" exactly matches your goal (skipped AI call for speed).`,
      };
    }

    // --- THINKING TIER: no obvious match, use full AI reasoning ------------
    const tasks = providers.map((provider) =>
      provider.matchIntent({ goal, elements, settings })
        .then((raw) => ({ provider: provider.name, decision: normalizeDecision(raw), error: null }))
        .catch((err) => ({ provider: provider.name, decision: null, error: err.message }))
    );

    const results = await Promise.all(tasks);
    const labelOf = (i) => (elements[i] ? `"${elements[i].label}"` : `#${i}`);

    const doneVotes = results.filter((r) => r.decision === 'DONE');
    const successful = results.filter((r) => r.decision !== null && r.decision !== 'DONE');
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
        action: 'click',
        note: index !== null
          ? `AI providers unavailable (${errorSummary}). Used free keyword matching instead.`
          : `AI providers unavailable (${errorSummary}), and no keyword match found either.`,
      };
    }

    const uniqueKeys = new Set(successful.map((r) => decisionKey(r.decision)));

    if (uniqueKeys.size === 1) {
      const d = successful[0].decision;
      const names = successful.map((r) => r.provider).join(' + ');
      const actionText = d.action === 'type' ? `type "${d.value}" into` : 'click';
      return { index: d.index, action: d.action, value: d.value, note: `${names} agree: ${actionText} ${labelOf(d.index)}.` };
    }

    // Disagreement: `successful` preserves the registry's priority order
    // because `providers` (the input array) was already ordered by the
    // registry, and Promise.all preserves input order in its output.
    const primary = successful[0].decision;
    const primaryName = successful[0].provider;
    const others = successful.slice(1);
    const disagreementText = others
      .map((r) => `${r.provider} suggested ${r.decision.action === 'type' ? `typing "${r.decision.value}" into ` : ''}${labelOf(r.decision.index)}`)
      .join(', ');
    const primaryActionText = primary.action === 'type' ? `type "${primary.value}" into` : 'picked';
    return {
      index: primary.index,
      action: primary.action,
      value: primary.value,
      note: `${primaryName} ${primaryActionText} ${labelOf(primary.index)} (${disagreementText} - went with ${primaryName}).`,
    };
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Ensemble = { runEnsemble };
})();
