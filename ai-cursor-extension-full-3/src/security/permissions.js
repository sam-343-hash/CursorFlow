/**
 * src/security/permissions.js
 *
 * Single source of truth for per-site permission state. Previously,
 * permission checks were scattered across content.js as raw
 * chrome.storage.local.get/set calls with hand-built key strings - easy
 * to typo, hard to audit. This module gives every other file one clear
 * API: check / grant / deny / revoke, all keyed by origin.
 *
 * Security model:
 * - Permission is per-origin (e.g. "https://wikipedia.org"), not per-page
 *   and not global. Granting on one site never implicitly grants on
 *   another - this is the core trust boundary of the whole extension.
 * - Three possible states: undefined (never asked), true (granted),
 *   false (denied). "Denied" is remembered so the user isn't re-prompted
 *   every visit after saying no once.
 * - This module does NOT decide what happens with permission once
 *   granted (that's the browser/actions modules) - it only answers
 *   "is this origin allowed."
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('security.permissions')
    : { debug() {}, warn() {} };

  const storage = self.AICursor && self.AICursor.Storage;

  function keyFor(origin) {
    if (!origin || typeof origin !== 'string') {
      throw new Error('PermissionStore: origin must be a non-empty string');
    }
    return `permission:${origin}`;
  }

  /**
   * Returns true, false, or undefined (never asked) for the given origin.
   */
  async function check(origin) {
    if (!storage) {
      logger.warn('Storage module not loaded - denying by default (fail closed)');
      return false;
    }
    const key = keyFor(origin);
    const result = await storage.get([key]);
    return result[key]; // undefined | true | false
  }

  async function grant(origin) {
    logger.debug('Granting permission', origin);
    return storage.set({ [keyFor(origin)]: true });
  }

  async function deny(origin) {
    logger.debug('Denying permission', origin);
    return storage.set({ [keyFor(origin)]: false });
  }

  /**
   * Revoke removes the stored decision entirely (back to "never asked"),
   * distinct from deny() which explicitly remembers a "no." Used if a
   * user wants to be re-prompted next visit instead of staying silently
   * blocked forever.
   */
  async function revoke(origin) {
    logger.debug('Revoking permission record', origin);
    return storage.remove([keyFor(origin)]);
  }

  /**
   * Returns every origin the user has ever granted permission to, for a
   * future "manage sites" settings screen. Fails safe to an empty list.
   */
  async function listGrantedOrigins() {
    if (!storage) return [];
    const all = await storage.getAllWithPrefix('permission:');
    return Object.keys(all)
      .filter((key) => all[key] === true)
      .map((key) => key.slice('permission:'.length));
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.PermissionStore = { check, grant, deny, revoke, listGrantedOrigins };
})();
