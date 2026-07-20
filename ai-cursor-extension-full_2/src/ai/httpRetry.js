/**
 * src/ai/httpRetry.js
 *
 * Every AI provider needs the same retry-on-rate-limit behavior. In the
 * previous version of this project, that retry loop was copy-pasted
 * separately into the Gemini call and the Groq call - a duplicate-code
 * smell that also meant a bug fix in one place could easily be forgotten
 * in the other. This module exists so there is exactly one retry
 * implementation, used by every provider.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('ai.httpRetry')
    : { debug() {}, warn() {} };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetches a URL, retrying with exponential backoff if the response is
   * considered retryable (by default, HTTP 429 - rate limited).
   *
   * @param {string} url
   * @param {Object} options - standard fetch() options
   * @param {Object} [config]
   * @param {number} [config.maxRetries=3]
   * @param {number} [config.baseDelayMs=1000]
   * @param {Function} [config.isRetryable] - (response) => boolean
   * @returns {Promise<Response>} the final fetch Response (never retried further)
   * @throws {Error} on network-level failure (no response at all)
   */
  async function fetchWithRetry(url, options, config) {
    const cfg = Object.assign(
      { maxRetries: 3, baseDelayMs: 1000, isRetryable: (res) => res.status === 429 },
      config || {}
    );

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      let response;
      try {
        response = await fetch(url, options);
      } catch (networkErr) {
        // No point retrying a DNS failure or offline network - fail fast.
        throw new Error(`Network error: ${(networkErr && networkErr.message) || networkErr}`);
      }

      if (cfg.isRetryable(response) && attempt < cfg.maxRetries) {
        const delay = Math.min(cfg.baseDelayMs * 2 ** attempt, 8000);
        logger.warn(`Retryable response (status ${response.status}), waiting ${delay}ms before retry ${attempt + 1}/${cfg.maxRetries}`);
        await sleep(delay);
        continue;
      }

      return response;
    }
    // Unreachable in practice (the loop always returns), but keeps the
    // function's return type honest for static analysis.
    throw new Error('fetchWithRetry: exhausted retries without a final response.');
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.HttpRetry = { fetchWithRetry };
})();
