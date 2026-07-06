/**
 * src/planner/plannerStates.js
 *
 * The formal set of states the Planner can be in, kept as plain string
 * constants (not a class) so they serialize trivially into progress
 * events and log lines without any special handling. Separated into its
 * own file so the state machine's vocabulary is documented in one place,
 * independent of the orchestration logic that uses it.
 */
(function () {
  const STATES = {
    IDLE: 'idle',
    SCANNING: 'scanning',
    THINKING: 'thinking',
    ACTING: 'acting',
    VERIFYING: 'verifying',
    DONE: 'done',
    FAILED: 'failed',
    STOPPED: 'stopped',
    LOOP_DETECTED: 'loop_detected',
    MAX_STEPS_REACHED: 'max_steps_reached',
    AWAITING_CONFIRMATION: 'awaiting_confirmation',
  };

  // States that end a planning run - once reached, the planner does not
  // continue looping. Used by the planner to decide when to stop, and by
  // any UI to decide when to stop showing a "thinking" indicator.
  const TERMINAL_STATES = new Set([
    STATES.DONE,
    STATES.FAILED,
    STATES.STOPPED,
    STATES.LOOP_DETECTED,
    STATES.MAX_STEPS_REACHED,
    STATES.AWAITING_CONFIRMATION,
  ]);

  function isTerminal(state) {
    return TERMINAL_STATES.has(state);
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.PlannerStates = { STATES, isTerminal };
})();
