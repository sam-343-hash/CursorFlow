/**
 * src/utils/storage.js
 *
 * Thin, consistent wrapper around chrome.storage.local. This exists so
 * that every other module talks to storage through one predictable API
 * (Promise-based, always resolves rather than throwing, logs failures)
 * instead of each file reimplementing its own get/set error handling.
 *
 * Namespacing convention: all keys written by this extension are prefixed
 * with "aicursor_" or a structured pattern like "permission:<origin>", to
 * avoid collisions if this storage area is ever shared or inspected
 * alongside other data.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('storage')
    : { debug() {}, warn() {}, error() {} };

  /**
   * Reads one or more keys. Always resolves - on error, resolves with an
   * empty object rather than rejecting, because a storage failure should
   * degrade gracefully (e.g. "no permission recorded yet") rather than
   * crash a calling feature.
   */
  function get(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) {
            logger.warn('storage.get failed', chrome.runtime.lastError.message);
            resolve({});
            return;
          }
          resolve(result || {});
        });
      } catch (e) {
        logger.error('storage.get threw', String(e));
        resolve({});
      }
    });
  }

  /**
   * Writes one or more key/value pairs. Resolves true/false rather than
   * throwing, so callers can decide how to handle a failed write without
   * a try/catch at every call site.
   */
  function set(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => {
          if (chrome.runtime.lastError) {
            logger.warn('storage.set failed', chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (e) {
        logger.error('storage.set threw', String(e));
        resolve(false);
      }
    });
  }

  function remove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) {
            logger.warn('storage.remove failed', chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (e) {
        logger.error('storage.remove threw', String(e));
        resolve(false);
      }
    });
  }

  /**
   * Lists all keys currently in storage that start with the given prefix.
   * Used by memory/history features later to enumerate e.g. all
   * "history:" entries without tracking a separate index.
   */
  function getAllWithPrefix(prefix) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (all) => {
          if (chrome.runtime.lastError) {
            logger.warn('storage.getAllWithPrefix failed', chrome.runtime.lastError.message);
            resolve({});
            return;
          }
          const matched = {};
          for (const key of Object.keys(all || {})) {
            if (key.startsWith(prefix)) matched[key] = all[key];
          }
          resolve(matched);
        });
      } catch (e) {
        logger.error('storage.getAllWithPrefix threw', String(e));
        resolve({});
      }
    });
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Storage = { get, set, remove, getAllWithPrefix };
})();
