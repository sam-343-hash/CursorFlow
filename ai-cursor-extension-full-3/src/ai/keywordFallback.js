/**
 * src/ai/keywordFallback.js
 *
 * The zero-setup, zero-cost fallback matcher. Unlike the real providers,
 * this does literal word-overlap scoring - it cannot reason about intent
 * (e.g. it will never guess that a "..." menu is the right click for
 * "change my profile picture"), but it requires no API key, no internet
 * call to a third party, and no signup, so the extension is never fully
 * non-functional even with zero configuration.
 */
(function () {
  const STOPWORDS = new Set([
    'my', 'the', 'a', 'an', 'to', 'on', 'in', 'for', 'of',
    'please', 'i', 'want', 'need', 'me', 'this', 'that',
  ]);

  function tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word && !STOPWORDS.has(word));
  }

  /**
   * Scores every element by literal word overlap with the goal and
   * returns the best index, its raw score, and a 0-1 confidence value
   * (score relative to a perfect match). The confidence value is what
   * lets the ensemble decide "this is obvious enough to skip the AI
   * call entirely" (see ensemble.js's fast-path) versus "this needs real
   * reasoning."
   */
  function matchWithScore(goal, elements) {
    const goalTokens = tokenize(goal);
    if (goalTokens.length === 0) return { index: null, score: 0, confidence: 0 };

    let bestIndex = null;
    let bestScore = 0;

    for (const el of elements) {
      const labelTokens = tokenize(el.label);
      let score = 0;
      for (const token of goalTokens) {
        if (labelTokens.includes(token)) score += 2;
        else if (labelTokens.some((lt) => lt.includes(token) || token.includes(lt))) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = el.index;
      }
    }

    const maxPossibleScore = goalTokens.length * 2;
    const confidence = maxPossibleScore > 0 ? bestScore / maxPossibleScore : 0;

    return {
      index: bestScore > 0 ? bestIndex : null,
      score: bestScore,
      confidence,
      tokenCount: goalTokens.length,
    };
  }

  /**
   * Backward-compatible simple form: just the index, or null. Existing
   * callers (the ensemble's all-providers-failed fallback path) don't
   * need the confidence score, only the final answer.
   */
  function match(goal, elements) {
    return matchWithScore(goal, elements).index;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.KeywordFallback = { match, matchWithScore };
})();
