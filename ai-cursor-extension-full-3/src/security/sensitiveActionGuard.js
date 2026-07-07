/**
 * src/security/sensitiveActionGuard.js
 *
 * Decides whether an on-screen element represents a "sensitive" action
 * that the extension must never click automatically - payments,
 * deletions, logouts, and similar irreversible or high-consequence
 * actions. The cursor may still point at these elements (that's the
 * whole product), but execution always requires a real human click.
 *
 * This is a deliberate, non-negotiable safety boundary: no setting,
 * command phrasing, or AI confidence score is allowed to bypass it. If a
 * later "auto-execute multi-step" feature is built, it MUST consult this
 * guard before every single click, not just the first one.
 *
 * Categorization (not just a flat boolean) exists so the UI can someday
 * explain *why* something was blocked ("this looks like a payment
 * action") rather than a generic warning - better trust through
 * transparency.
 */
(function () {
  const CATEGORIES = {
    DESTRUCTIVE: {
      label: 'destructive',
      keywords: [
        'delete', 'remove', 'deactivate', 'permanently', 'erase',
        'clear all', 'wipe', 'destroy',
      ],
    },
    FINANCIAL: {
      label: 'financial',
      keywords: [
        'buy now', 'purchase', 'pay', 'checkout', 'confirm order',
        'place order', 'submit payment', 'transfer', 'send money',
        'withdraw', 'donate', 'subscribe', 'upgrade plan', 'add card',
      ],
    },
    ACCOUNT: {
      label: 'account',
      keywords: [
        'cancel subscription', 'unsubscribe', 'log out', 'sign out',
        'deauthorize', 'revoke', 'close account', 'delete account',
      ],
    },
    COMMUNICATION: {
      label: 'communication',
      keywords: ['send', 'post', 'publish', 'reply all', 'broadcast'],
    },
  };

  /**
   * Checks a label against every category. Returns the FIRST matching
   * category, or null if nothing matches. Order matters: DESTRUCTIVE and
   * FINANCIAL are checked before the broader COMMUNICATION category,
   * since "send money" should be classified as financial, not just
   * communication, even though it also contains "send"-adjacent intent.
   */
  function classify(label) {
    if (!label || typeof label !== 'string') return null;
    const lower = label.toLowerCase();

    for (const key of ['DESTRUCTIVE', 'FINANCIAL', 'ACCOUNT', 'COMMUNICATION']) {
      const category = CATEGORIES[key];
      if (category.keywords.some((word) => lower.includes(word))) {
        return category.label;
      }
    }
    return null;
  }

  function isSensitive(label) {
    return classify(label) !== null;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.SensitiveActionGuard = { isSensitive, classify, CATEGORIES };
})();
