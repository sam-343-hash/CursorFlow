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
   * returns the index of the best match, or null if nothing scores
   * above zero.
   */
  function match(goal, elements) {
    const goalTokens = tokenize(goal);
    if (goalTokens.length === 0) return null;

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

    return bestScore > 0 ? bestIndex : null;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.KeywordFallback = { match };
})();
