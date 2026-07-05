/**
 * src/actions/actionQueue.js
 *
 * Actions (click, type, scroll, etc.) must run one at a time, in order -
 * firing two actions simultaneously against a live page is how you get
 * race conditions and mis-clicks. This queue guarantees sequential
 * execution, and wraps each action with:
 *   - Retry with a fixed delay (default 2 retries, 300ms apart) if the
 *     action throws, or if a supplied verification function reports the
 *     action didn't visibly do anything.
 *   - A resolved/rejected Promise per enqueued action, so callers can
 *     await individual actions or fire-and-collect a whole batch.
 *
 * This is intentionally a plain sequential queue, not a full task
 * scheduler with priorities/cancellation - that complexity isn't earned
 * yet at this stage of the project, and YAGNI (you aren't going to need
 * it) applies until a real use case demands it.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('actions.queue')
    : { debug() {}, warn() {}, error() {} };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  class ActionQueue {
    constructor(options) {
      const opts = options || {};
      this.maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : 2;
      this.retryDelayMs = typeof opts.retryDelayMs === 'number' ? opts.retryDelayMs : 300;
      this._queue = [];
      this._running = false;
    }

    /**
     * Adds an action to the queue and returns a Promise that resolves
     * with { success, actionResult, verification } once it (eventually)
     * runs, or rejects with an Error after all retries are exhausted.
     *
     * @param {Function} actionFn - async or sync function that performs the action
     * @param {Object} [config]
     * @param {string} [config.label] - human-readable name for logging
     * @param {Function} [config.verify] - optional function returning {verified, reason}
     */
    enqueue(actionFn, config) {
      const cfg = config || {};
      return new Promise((resolve, reject) => {
        this._queue.push({
          actionFn,
          label: cfg.label || 'unnamed action',
          verify: cfg.verify || null,
          resolve,
          reject,
        });
        this._process();
      });
    }

    get length() {
      return this._queue.length;
    }

    async _process() {
      if (this._running) return;
      this._running = true;

      while (this._queue.length > 0) {
        const item = this._queue.shift();
        const result = await this._runWithRetry(item);
        // Two distinct failure modes, handled differently on purpose:
        //  - The action itself threw on every attempt (e.g. element
        //    detached, invalid selector): this is an execution error,
        //    so the promise REJECTS - something is actually broken.
        //  - The action ran without throwing, but verification could
        //    never confirm it had an effect: this is a normal, expected
        //    outcome the caller should be able to react to (e.g. the
        //    planner picking a different element) without needing a
        //    try/catch - so the promise RESOLVES with success:false.
        if (result.threw) {
          item.reject(new Error(result.error));
        } else {
          item.resolve(result);
        }
      }

      this._running = false;
    }

    async _runWithRetry(item) {
      let lastError = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        let actionResult;
        try {
          actionResult = await item.actionFn();
        } catch (err) {
          lastError = (err && err.message) || String(err);
          logger.warn(`"${item.label}" attempt ${attempt + 1} threw`, lastError);
          if (attempt < this.maxRetries) {
            await sleep(this.retryDelayMs);
            continue;
          }
          return { success: false, threw: true, error: lastError };
        }

        if (item.verify) {
          const verification = await item.verify();
          if (!verification.verified) {
            lastError = `Verification failed: ${verification.reason}`;
            logger.warn(`"${item.label}" attempt ${attempt + 1} unverified`, verification.reason);
            if (attempt < this.maxRetries) {
              await sleep(this.retryDelayMs);
              continue;
            }
            // Ran without throwing on every attempt, but never verified -
            // resolve (not reject) per the documented contract above.
            return { success: false, threw: false, error: lastError, verification };
          }
          logger.debug(`"${item.label}" succeeded and verified`, verification.reason);
          return { success: true, actionResult, verification };
        }

        logger.debug(`"${item.label}" succeeded (no verification configured)`);
        return { success: true, actionResult };
      }

      return { success: false, threw: true, error: lastError || 'Unknown error running action.' };
    }
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.ActionQueue = ActionQueue;
})();
