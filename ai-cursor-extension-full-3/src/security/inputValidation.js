/**
 * src/security/inputValidation.js
 *
 * Two responsibilities:
 *  1. Validate that messages arriving via chrome.runtime.onMessage match
 *     an expected shape before any handler acts on them. Without this,
 *     a malformed or malicious message (from a compromised page, a bug
 *     in a future feature, or - in principle - another extension with
 *     excess permissions) could reach handler code with unexpected
 *     types and cause crashes or unintended actions.
 *  2. Verify the *sender* of a message is actually this extension, not
 *     an external source. chrome.runtime.onMessage can receive messages
 *     from other extensions if this extension sets `externally_connectable`
 *     (it does not, currently) - but validating sender.id defensively
 *     costs nothing and prevents this from becoming a silent
 *     vulnerability if that ever changes.
 *
 * This module intentionally has zero dependencies on chrome.storage or
 * any async API - pure synchronous validation functions only, so it's
 * trivial to unit test in isolation later.
 */
(function () {
  // Every known message type this extension sends internally, and the
  // required shape of its payload. Anything not listed here is rejected
  // by validateMessage() by default - a safe "deny unknown" posture.
  //
  // Note: this list is deliberately SHORTER than an earlier version of
  // this project had. Before the Planner (src/planner/) existed,
  // separate message types were needed for SCAN_PAGE / MOVE_CURSOR /
  // CLICK_ELEMENT because scanning and clicking were driven step-by-step
  // from outside the content script. Now that the Planner runs its full
  // scan-think-act-verify loop in a single in-process call inside the
  // content script, those intermediate message types are gone entirely -
  // a real simplification the Planner's existence enabled, not just a
  // rename.
  const SCHEMAS = {
    CHECK_PERMISSION: {},
    GRANT_PERMISSION: {},
    DISABLE_PERMISSION: {},
    RUN_GOAL: { goal: 'string' },
    STOP_GOAL: {},
    RUN_ENSEMBLE: { goal: 'string', elements: 'object' },
    PLANNER_PROGRESS: { phase: 'string' },
    RELAY_TO_CONTENT: { tabId: 'number', payload: 'object' },
    GET_PROVIDER_STATUS: {},
  };

  /**
   * Validates a message against its declared schema.
   * Returns { valid: true } or { valid: false, reason: string }.
   */
  function validateMessage(message) {
    if (!message || typeof message !== 'object') {
      return { valid: false, reason: 'Message is not an object.' };
    }
    if (typeof message.type !== 'string' || !(message.type in SCHEMAS)) {
      return { valid: false, reason: `Unknown or missing message type: ${message.type}` };
    }

    const schema = SCHEMAS[message.type];
    for (const field of Object.keys(schema)) {
      const expectedType = schema[field];
      const actualValue = message[field];

      if (expectedType === 'number' && typeof actualValue !== 'number') {
        return { valid: false, reason: `Field "${field}" must be a number.` };
      }
      if (expectedType === 'string' && typeof actualValue !== 'string') {
        return { valid: false, reason: `Field "${field}" must be a string.` };
      }
      if (expectedType === 'object' && (typeof actualValue !== 'object' || actualValue === null)) {
        return { valid: false, reason: `Field "${field}" must be an object.` };
      }
    }

    // Extra guard specific to RUN_GOAL: reject empty or absurdly long
    // input early, before it reaches any AI call or storage write.
    if (message.type === 'RUN_GOAL') {
      const trimmed = message.goal.trim();
      if (trimmed.length === 0) {
        return { valid: false, reason: 'Goal cannot be empty.' };
      }
      if (trimmed.length > 300) {
        return { valid: false, reason: 'Goal is too long (max 300 characters).' };
      }
    }

    return { valid: true };
  }

  /**
   * Confirms a message sender is this same extension's own context, not
   * an external page or a different extension. Defense in depth: even
   * though this extension does not currently declare
   * `externally_connectable`, validating this here means the guarantee
   * holds even if manifest permissions change later without someone
   * remembering to re-audit every message handler.
   */
  function isSenderTrusted(sender) {
    try {
      return !!sender && sender.id === chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.InputValidation = { validateMessage, isSenderTrusted, SCHEMAS };
})();
