/**
 * src/utils/logger.js
 *
 * Centralized logging for the whole extension. Every context (background,
 * content script, popup, voice window) loads this same file and gets a
 * consistent Logger with levels, timing, and a small in-memory ring buffer
 * so recent logs can be inspected or exported for bug reports.
 *
 * Design decisions:
 * - No external logging library (Sentry, LogRocket, etc.) - those are
 *   paid/hosted services and this project must stay 100% free with no
 *   external dependencies of any kind.
 * - Debug mode is OFF by default in production use, ON by default during
 *   local development detection (unpacked extensions have no update_url).
 *   This means a user who loads this via "Load unpacked" sees debug logs
 *   automatically, while a hypothetical Web Store install would not spam
 *   the console - a real quality-of-life distinction between dev and prod.
 * - Uses a shared-namespace pattern (`self.AICursor`) instead of ES
 *   `export`, because this file is loaded as a plain classic script in
 *   content scripts, background (via importScripts), and popup/voice
 *   pages alike - one file, three loading mechanisms, zero build step.
 */
(function () {
  const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
  const LEVEL_NAMES = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR' };
  const MAX_BUFFER_SIZE = 200;

  // A module-level ring buffer of recent log entries, shared by every
  // Logger instance created in this execution context (background OR
  // content script OR popup - each has its own JS realm, so this buffer
  // is naturally scoped per-context, which is what we want).
  const buffer = [];

  function pushToBuffer(entry) {
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  function isLikelyDevelopmentBuild() {
    // An extension installed from the Chrome Web Store always has an
    // updateUrl in its manifest metadata; unpacked/development loads do
    // not. This lets us default debug logging on for developers without
    // requiring a manual toggle, while staying quiet for real users.
    try {
      return !('update_url' in (chrome.runtime.getManifest() || {}));
    } catch (e) {
      return false;
    }
  }

  let currentMinLevel = isLikelyDevelopmentBuild() ? LEVELS.DEBUG : LEVELS.WARN;
  let debugModeLoaded = false;

  // Debug mode can also be explicitly overridden and persisted, so a user
  // can turn on verbose logging in production to help diagnose a bug
  // report, or a developer can quiet it down without editing code.
  function loadPersistedDebugMode() {
    if (debugModeLoaded) return;
    debugModeLoaded = true;
    try {
      chrome.storage.local.get(['aicursor_debug_mode'], (result) => {
        if (chrome.runtime.lastError) return;
        if (typeof result.aicursor_debug_mode === 'boolean') {
          currentMinLevel = result.aicursor_debug_mode ? LEVELS.DEBUG : LEVELS.WARN;
        }
      });
    } catch (e) {
      // chrome.storage may be unavailable in some contexts (e.g. a
      // detached test page) - fail silently and keep the default level.
    }
  }
  loadPersistedDebugMode();

  function setDebugMode(enabled) {
    currentMinLevel = enabled ? LEVELS.DEBUG : LEVELS.WARN;
    try {
      chrome.storage.local.set({ aicursor_debug_mode: !!enabled });
    } catch (e) {
      /* non-fatal */
    }
  }

  function formatPrefix(context, levelName) {
    const time = new Date().toISOString().split('T')[1].replace('Z', '');
    return `[${time}] [${levelName}] [${context}]`;
  }

  function consoleMethodFor(levelValue) {
    if (levelValue >= LEVELS.ERROR) return console.error;
    if (levelValue >= LEVELS.WARN) return console.warn;
    if (levelValue >= LEVELS.INFO) return console.info;
    return console.debug || console.log;
  }

  function log(context, levelValue, message, data) {
    const levelName = LEVEL_NAMES[levelValue];
    const entry = {
      timestamp: Date.now(),
      context,
      level: levelName,
      message,
      data: data !== undefined ? data : null,
    };
    pushToBuffer(entry);

    if (levelValue < currentMinLevel) return;

    const prefix = formatPrefix(context, levelName);
    const fn = consoleMethodFor(levelValue);
    if (data !== undefined) {
      fn(prefix, message, data);
    } else {
      fn(prefix, message);
    }
  }

  /**
   * Creates a Logger bound to a specific context name (e.g. "background",
   * "content", "popup") so every line is traceable to where it came from
   * without repeating the context string at every call site.
   */
  function createLogger(context) {
    const timers = new Map();

    return {
      debug: (message, data) => log(context, LEVELS.DEBUG, message, data),
      info: (message, data) => log(context, LEVELS.INFO, message, data),
      warn: (message, data) => log(context, LEVELS.WARN, message, data),
      error: (message, data) => log(context, LEVELS.ERROR, message, data),

      /**
       * Starts a named timer. Call `.timeEnd(label)` later to log the
       * elapsed duration - useful for measuring AI call latency, DOM
       * scan duration, etc. without manual Date.now() bookkeeping at
       * every call site.
       */
      time: (label) => {
        timers.set(label, performance.now());
      },
      timeEnd: (label) => {
        const start = timers.get(label);
        if (start === undefined) {
          log(context, LEVELS.WARN, `timeEnd("${label}") called without matching time()`);
          return null;
        }
        timers.delete(label);
        const durationMs = Math.round(performance.now() - start);
        log(context, LEVELS.DEBUG, `${label} took ${durationMs}ms`);
        return durationMs;
      },
    };
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Logger = {
    create: createLogger,
    setDebugMode,
    getBuffer: () => buffer.slice(),
    clearBuffer: () => {
      buffer.length = 0;
    },
    LEVELS,
  };
})();
