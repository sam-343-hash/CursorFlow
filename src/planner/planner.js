/**
 * src/planner/planner.js
 *
 * This is the orchestration layer connecting Modules 1-3 into an actual
 * multi-step execution engine:
 *
 *   Scan -> AI ensemble decision -> Execute action -> Verify -> Re-scan -> repeat
 *
 * Design principle: EVERY dependency is injected via the constructor
 * (domScanner, actionQueue, verification, elementActions, runEnsemble,
 * providers, settings, logger). The Planner itself never touches
 * `document`, `chrome.*`, or any specific AI provider directly. This is
 * what "provider-agnostic and browser-agnostic" means in practice: the
 * exact same Planner class can be unit-tested with fully fake
 * dependencies (see test/run-module4-node.js, which does this with zero
 * DOM and zero network calls), and later wired into the real extension
 * by passing in the real modules from Modules 1-3 - with no changes to
 * this file required either way.
 *
 * The Planner never throws out of run() - every failure path resolves
 * with a structured { status, reason, steps } result, because a
 * multi-step autonomous loop that can throw at an arbitrary point is
 * much harder to build a reliable UI on top of than one with a single,
 * predictable "how did it end" contract.
 */
(function () {
  const STATES = self.AICursor.PlannerStates.STATES;

  class Planner {
    /**
     * @param {Object} deps
     * @param {Object} deps.domScanner - object with .scan() and .getElementByIndex(i)
     * @param {Object} deps.actionQueue - an ActionQueue instance (see src/actions/actionQueue.js)
     * @param {Object} deps.verification - object with .snapshot(el) and .verify(before, el)
     * @param {Object} deps.elementActions - object with .click(el) (and other primitives, for future action types)
     * @param {Function} deps.runEnsemble - async ({goal, elements, providers, settings}) => {index, note, alreadyDone}
     * @param {Array} deps.providers - array of configured AI providers to pass to runEnsemble
     * @param {Object} [deps.settings] - provider settings (API keys, etc.)
     * @param {Object} [deps.logger] - AICursor.Logger-shaped logger; defaults to a real one if available
     * @param {number} [deps.maxSteps=10]
     * @param {number} [deps.maxConsecutiveFailures=3]
     * @param {number} [deps.maxRepeatedFailuresPerLabel=2]
     */
    constructor(deps) {
      if (!deps || !deps.domScanner || !deps.actionQueue || !deps.verification || !deps.elementActions || !deps.runEnsemble) {
        throw new Error('Planner: missing required dependency (domScanner, actionQueue, verification, elementActions, runEnsemble are all required).');
      }

      this.domScanner = deps.domScanner;
      this.actionQueue = deps.actionQueue;
      this.verification = deps.verification;
      this.elementActions = deps.elementActions;
      this.runEnsemble = deps.runEnsemble;
      this.providers = deps.providers || [];
      this.settings = deps.settings || {};
      this.logger = deps.logger || (self.AICursor.Logger ? self.AICursor.Logger.create('planner') : {
        debug() {}, info() {}, warn() {}, error() {}, time() {}, timeEnd() {},
      });

      this.loopGuard = new self.AICursor.LoopGuard({
        maxSteps: deps.maxSteps,
        maxConsecutiveFailures: deps.maxConsecutiveFailures,
        maxRepeatedFailuresPerLabel: deps.maxRepeatedFailuresPerLabel,
      });

      this._stopRequested = false;
      this.state = STATES.IDLE;
    }

    /**
     * Cooperative cancellation - the loop checks this flag at the start
     * of every iteration. It is not preemptive (an in-flight action will
     * still finish), which is the correct behavior: half-executed clicks
     * are worse than a one-iteration delay in stopping.
     */
    stop() {
      this._stopRequested = true;
    }

    /**
     * Runs the full plan-execute-verify loop for a given goal.
     * @param {string} goal
     * @param {Object} [options]
     * @param {Function} [options.onProgress] - called with a structured event after every phase transition
     * @returns {Promise<{status: string, reason: string, steps: Array}>}
     */
    async run(goal, options) {
      const onProgress = (options && options.onProgress) || (() => {});
      const steps = [];

      const emit = (phase, detail) => {
        const event = { phase, stepNumber: this.loopGuard.stepCount, detail, timestamp: Date.now() };
        this.logger.debug(`[${phase}]`, detail);
        try {
          onProgress(event);
        } catch (callbackErr) {
          // A broken UI callback must never crash the planning loop.
          this.logger.warn('onProgress callback threw', String(callbackErr));
        }
      };

      if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
        this.state = STATES.FAILED;
        emit(STATES.FAILED, 'Goal is empty.');
        return { status: STATES.FAILED, reason: 'Goal is empty.', steps };
      }

      this.logger.info('Planner run started', goal);

      while (true) {
        if (this._stopRequested) {
          this.state = STATES.STOPPED;
          emit(STATES.STOPPED, 'Stop requested by caller.');
          return { status: STATES.STOPPED, reason: 'Stop requested by caller.', steps };
        }

        if (this.loopGuard.hasReachedMaxSteps()) {
          this.state = STATES.MAX_STEPS_REACHED;
          emit(STATES.MAX_STEPS_REACHED, `Reached maximum of ${this.loopGuard.maxSteps} steps.`);
          return { status: STATES.MAX_STEPS_REACHED, reason: `Reached maximum of ${this.loopGuard.maxSteps} steps without completing the goal.`, steps };
        }

        // --- SCAN ------------------------------------------------------
        this.state = STATES.SCANNING;
        emit(STATES.SCANNING, 'Scanning page for interactive elements.');
        let scanResult;
        try {
          scanResult = await this.domScanner.scan();
        } catch (err) {
          this.state = STATES.FAILED;
          const reason = `Scanning failed: ${(err && err.message) || err}`;
          emit(STATES.FAILED, reason);
          return { status: STATES.FAILED, reason, steps };
        }

        const elements = (scanResult && scanResult.elements) || [];
        if (elements.length === 0) {
          this.state = STATES.FAILED;
          emit(STATES.FAILED, 'No interactive elements found on the page.');
          return { status: STATES.FAILED, reason: 'No interactive elements found on the page.', steps };
        }

        // --- THINK (AI ensemble decides the next action) ----------------
        this.state = STATES.THINKING;
        emit(STATES.THINKING, `Asking AI ensemble to choose next action toward: "${goal}"`);
        let ensembleResult;
        try {
          ensembleResult = await this.runEnsemble({ goal, elements, providers: this.providers, settings: this.settings });
        } catch (err) {
          this.state = STATES.FAILED;
          const reason = `AI ensemble threw unexpectedly: ${(err && err.message) || err}`;
          emit(STATES.FAILED, reason);
          return { status: STATES.FAILED, reason, steps };
        }

        if (ensembleResult.alreadyDone) {
          this.state = STATES.DONE;
          emit(STATES.DONE, ensembleResult.note || 'Goal already accomplished on current screen.');
          return { status: STATES.DONE, reason: ensembleResult.note || 'Goal already accomplished.', steps };
        }

        if (ensembleResult.index === null || ensembleResult.index === undefined) {
          this.state = STATES.FAILED;
          const reason = ensembleResult.note || 'No reasonable next action found.';
          emit(STATES.FAILED, reason);
          return { status: STATES.FAILED, reason, steps };
        }

        const targetMeta = elements[ensembleResult.index];
        const targetElement = this.domScanner.getElementByIndex(ensembleResult.index);
        if (!targetElement || !targetMeta) {
          // The AI picked an index that doesn't map to a real element -
          // treat this as a failed step (counts toward loop/failure
          // guards) rather than crashing the whole run.
          const failCount = this.loopGuard.recordFailure('(invalid index)');
          this.loopGuard.recordStep();
          steps.push({ stepNumber: this.loopGuard.stepCount, label: null, success: false, reason: 'AI chose an index with no matching element.' });
          emit(STATES.FAILED, `AI chose index ${ensembleResult.index}, but no matching element exists. (failure ${failCount})`);
          if (this.loopGuard.hasTooManyConsecutiveFailures()) {
            this.state = STATES.FAILED;
            return { status: STATES.FAILED, reason: 'Repeated invalid element selections.', steps };
          }
          continue; // re-scan and try again
        }

        // --- LOOP GUARD: same element chosen too many times in a row ----
        // Checked BEFORE acting, and regardless of sensitivity or of
        // what verification will later report - this is intentionally
        // independent of the action's outcome, since a real bug once
        // let a weak verification signal mask this exact failure mode
        // (see browser/verification.js's focus-change fix for the root
        // cause). Repeated selection of the identical element, even if
        // each individual click "succeeds," means no real progress.
        const repeatCount = this.loopGuard.recordSelection(targetMeta.label);
        if (this.loopGuard.hasRepeatedSameSelectionTooManyTimes()) {
          this.state = STATES.LOOP_DETECTED;
          const reason = `The same element ("${targetMeta.label}") was chosen ${repeatCount} times in a row without reaching the goal - stopping to avoid an infinite loop.`;
          emit(STATES.LOOP_DETECTED, reason);
          return { status: STATES.LOOP_DETECTED, reason, steps };
        }

        // --- SAFETY GUARD: never auto-click a sensitive action ----------
        // This check is deliberately non-negotiable and cannot be
        // disabled via settings, options, or provider confidence. If the
        // scanned metadata flags this element as sensitive (payments,
        // deletions, logouts, etc. - see SensitiveActionGuard), the
        // planner stops here and hands control back to a human instead
        // of proceeding to ACT.
        if (targetMeta.sensitive) {
          this.state = STATES.AWAITING_CONFIRMATION;
          const detail = {
            message: `Found "${targetMeta.label}" but it looks like a ${targetMeta.category} action.`,
            elementIndex: ensembleResult.index,
            label: targetMeta.label,
            sensitive: true,
            category: targetMeta.category,
          };
          emit(STATES.AWAITING_CONFIRMATION, detail);
          return {
            status: STATES.AWAITING_CONFIRMATION,
            reason: `"${targetMeta.label}" looks like a ${targetMeta.category} action, so it requires your manual click for safety.`,
            steps,
          };
        }

        // --- ACT ---------------------------------------------------------
        this.state = STATES.ACTING;
        emit(STATES.ACTING, {
          message: `Clicking: "${targetMeta.label}" (${ensembleResult.note || ''})`,
          elementIndex: ensembleResult.index,
          label: targetMeta.label,
          sensitive: false,
        });

        const beforeSnapshot = this.verification.snapshot(targetElement);
        let actionOutcome;
        try {
          actionOutcome = await this.actionQueue.enqueue(
            () => this.elementActions.click(targetElement),
            {
              label: targetMeta.label,
              verify: () => this.verification.verify(beforeSnapshot, targetElement),
            }
          );
        } catch (err) {
          // ActionQueue rejects only on a genuine execution error (the
          // action itself threw on every retry) - a real, not-recoverable
          // problem with this specific element.
          actionOutcome = { success: false, threw: true, error: (err && err.message) || String(err) };
        }

        // --- VERIFY (result already computed by ActionQueue above) ------
        this.state = STATES.VERIFYING;
        this.loopGuard.recordStep();

        if (actionOutcome.success) {
          this.loopGuard.recordSuccess(targetMeta.label);
          steps.push({
            stepNumber: this.loopGuard.stepCount,
            label: targetMeta.label,
            success: true,
            note: ensembleResult.note,
            verificationReason: actionOutcome.verification ? actionOutcome.verification.reason : null,
          });
          emit(STATES.VERIFYING, `Verified: ${actionOutcome.verification ? actionOutcome.verification.reason : 'action completed'}`);
          this.domScanner.invalidate();
          continue; // loop back to SCAN for the next step
        }

        // Action failed (either threw, or ran but was never verified).
        const failCount = this.loopGuard.recordFailure(targetMeta.label);
        steps.push({
          stepNumber: this.loopGuard.stepCount,
          label: targetMeta.label,
          success: false,
          reason: actionOutcome.error,
        });
        emit(STATES.VERIFYING, `Action failed (attempt ${failCount} on "${targetMeta.label}"): ${actionOutcome.error}`);

        if (this.loopGuard.isLabelLooping(targetMeta.label)) {
          this.state = STATES.LOOP_DETECTED;
          const reason = `Repeatedly failed on the same element ("${targetMeta.label}") - stopping to avoid an infinite loop.`;
          emit(STATES.LOOP_DETECTED, reason);
          return { status: STATES.LOOP_DETECTED, reason, steps };
        }

        if (this.loopGuard.hasTooManyConsecutiveFailures()) {
          this.state = STATES.FAILED;
          const reason = `Stopped after ${this.loopGuard.consecutiveFailures} consecutive failed actions.`;
          emit(STATES.FAILED, reason);
          return { status: STATES.FAILED, reason, steps };
        }

        this.domScanner.invalidate();
        // Loop back to SCAN and let the AI try something different.
      }
    }
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Planner = Planner;
})();
