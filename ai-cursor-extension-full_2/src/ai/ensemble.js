/**
 * src/ai/ensemble.js
 *
 * Runs EVERY configured provider at the same time and reconciles their
 * answers into one decision. Provider-count-agnostic by design.
 *
 * Decision normalization:
 * A provider's raw matchIntent() result can be: null, 'DONE', a bare
 * number (legacy/simple providers and test fakes), or a structured
 * decision object - either { index, action: 'click'|'type', value? }
 * for on-page actions, or { action: 'navigate'|'open_tab', url } for
 * cross-page actions (no element index - these act on the whole tab,
 * not a specific element). normalizeDecision() converts all of these
 * into one consistent shape before any reconciliation logic runs.
 *
 * Speed design - an "Instant" tier before the "Thinking" tier:
 * Before paying the latency/cost of an AI round-trip, checks whether
 * the free keyword matcher found an unambiguous, exact match. The
 * instant tier is click-only by nature (it can't infer a typed value or
 * decide navigation) - any goal needing typing or navigation correctly
 * falls through to full AI reasoning.
 *
 * Reconciliation policy:
 *  - Zero providers configured -> free keyword fallback immediately.
 *  - An unambiguous instant match exists -> use it, skip AI entirely.
 *  - All configured providers say "done" -> report alreadyDone.
 *  - All configured providers fail -> fall back to free keyword matching.
 *  - Providers agree on the same decision -> high confidence, use it.
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
   * shape: null | 'DONE' | { index, action, value? } | { action, url }.
   */
  function normalizeDecision(raw) {
    if (raw === null || raw === undefined) return null;
    if (raw === 'DONE') return 'DONE';
    if (typeof raw === 'number') return { index: raw, action: 'click' };

    if (raw && typeof raw === 'object') {
      if (raw.action === 'navigate' || raw.action === 'open_tab') {
        return typeof raw.url === 'string' && raw.url ? { action: raw.action, url: raw.url } : null;
      }
      if (typeof raw.index === 'number') {
        const normalized = { index: raw.index, action: raw.action || 'click' };
        if (raw.action === 'type') normalized.value = raw.value;
        return normalized;
      }
    }
    return null;
  }

  function isNavigationDecision(decision) {
    return decision.action === 'navigate' || decision.action === 'open_tab';
  }

  function decisionKey(decision) {
    if (isNavigationDecision(decision)) return `${decision.action}:${decision.url}`;
    return `${decision.index}:${decision.action}:${decision.value || ''}`;
  }

  /** Builds the {index, action, value?/url?} shape returned to the Planner. */
  function toEnsembleResult(decision, note) {
    if (isNavigationDecision(decision)) {
      return { index: null, action: decision.action, url: decision.url, note };
    }
    const result = { index: decision.index, action: decision.action, note };
    if (decision.action === 'type') result.value = decision.value;
    return result;
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
    const describe = (d) => {
      if (isNavigationDecision(d)) return `${d.action === 'navigate' ? 'go to' : 'open a new tab to'} ${d.url}`;
      if (d.action === 'type') return `type "${d.value}" into ${labelOf(d.index)}`;
      return `click ${labelOf(d.index)}`;
    };

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
      return toEnsembleResult(d, `${names} agree: ${describe(d)}.`);
    }

    // Disagreement: `successful` preserves the registry's priority order
    // because `providers` (the input array) was already ordered by the
    // registry, and Promise.all preserves input order in its output.
    const primaryEntry = successful[0];
    const others = successful.slice(1);
    const disagreementText = others.map((r) => `${r.provider} suggested ${describe(r.decision)}`).join(', ');
    return toEnsembleResult(
      primaryEntry.decision,
      `${primaryEntry.provider}: ${describe(primaryEntry.decision)} (${disagreementText} - went with ${primaryEntry.provider}).`
    );
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Ensemble = { runEnsemble };
})();
