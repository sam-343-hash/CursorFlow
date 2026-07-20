/**
 * src/planner/loopGuard.js
 *
 * Isolated, independently testable loop-protection logic. Three distinct
 * safety limits, each catching a different failure mode:
 *
 * 1. maxSteps - a hard ceiling on total actions taken, regardless of
 *    whether they're succeeding or failing. Catches "technically making
 *    progress but never finishing" scenarios (e.g. a wizard with more
 *    steps than expected).
 *
 * 2. maxConsecutiveFailures - if actions are failing back-to-back
 *    (regardless of which element), something is systemically wrong
 *    (page didn't load, permission issue, site blocks synthetic events)
 *    and continuing to try is unlikely to help.
 *
 * 3. Repeated-failure signatures (per-label) - the specific "stuck in a
 *    loop" case: the SAME element keeps getting chosen and keeps
 *    failing. This is deliberately keyed on FAILURE, not selection -
 *    legitimately clicking the same "Next" button multiple times across
 *    a real multi-step wizard is normal and should not trip this guard;
 *    only repeatedly failing on the same element should.
 */
(function () {
  class LoopGuard {
    constructor(options) {
      const opts = options || {};
      this.maxSteps = typeof opts.maxSteps === 'number' ? opts.maxSteps : 10;
      this.maxConsecutiveFailures = typeof opts.maxConsecutiveFailures === 'number' ? opts.maxConsecutiveFailures : 3;
      this.maxRepeatedFailuresPerLabel = typeof opts.maxRepeatedFailuresPerLabel === 'number' ? opts.maxRepeatedFailuresPerLabel : 2;

      this.stepCount = 0;
      this.consecutiveFailures = 0;
      this._failureCountsByLabel = new Map();
      this._lastSelectedLabel = null;
      this._consecutiveSameSelection = 0;
      this.maxConsecutiveSameSelection = typeof opts.maxConsecutiveSameSelection === 'number' ? opts.maxConsecutiveSameSelection : 3;
    }

    /**
     * Records that a given label was chosen as this step's target,
     * REGARDLESS of whether the action goes on to succeed or fail.
     * Returns how many times in a row (including this one) the exact
     * same element has now been chosen.
     *
     * This exists as defense in depth against a real bug found in
     * practice: a weak verification signal (see browser/verification.js)
     * once caused the planner to treat repeatedly clicking the SAME
     * unhelpful element as N separate "successes," never triggering the
     * failure-based loop guard at all. Tracking repeated SELECTION
     * (not just repeated failure) catches that failure mode even if a
     * future verification heuristic has a similar blind spot.
     */
    recordSelection(label) {
      const key = label || '(unknown)';
      if (key === this._lastSelectedLabel) {
        this._consecutiveSameSelection += 1;
      } else {
        this._lastSelectedLabel = key;
        this._consecutiveSameSelection = 1;
      }
      return this._consecutiveSameSelection;
    }

    hasRepeatedSameSelectionTooManyTimes() {
      return this._consecutiveSameSelection >= this.maxConsecutiveSameSelection;
    }

    recordStep() {
      this.stepCount += 1;
    }

    recordSuccess(label) {
      this.consecutiveFailures = 0;
      if (label) this._failureCountsByLabel.set(label, 0);
    }

    /**
     * Records a failure for a given element label and returns how many
     * times (including this one) that same label has now failed.
     */
    recordFailure(label) {
      this.consecutiveFailures += 1;
      const key = label || '(unknown)';
      const nextCount = (this._failureCountsByLabel.get(key) || 0) + 1;
      this._failureCountsByLabel.set(key, nextCount);
      return nextCount;
    }

    hasReachedMaxSteps() {
      return this.stepCount >= this.maxSteps;
    }

    hasTooManyConsecutiveFailures() {
      return this.consecutiveFailures >= this.maxConsecutiveFailures;
    }

    isLabelLooping(label) {
      const key = label || '(unknown)';
      return (this._failureCountsByLabel.get(key) || 0) >= this.maxRepeatedFailuresPerLabel;
    }
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.LoopGuard = LoopGuard;
})();
