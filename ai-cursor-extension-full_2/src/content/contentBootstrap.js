/**
 * src/content/contentBootstrap.js
 *
 * The entry point of the content script - the LAST file loaded (per
 * manifest.json's content_scripts order), since it depends on every
 * other module already being attached to `self.AICursor`.
 *
 * Responsibilities:
 *  1. Show the permission banner on first visit to this origin; respect
 *     a stored "deny" silently on future visits.
 *  2. Start the DomScanner's MutationObserver so later scans are cheap.
 *  3. Build a fresh Planner per goal (so loop-guard state never leaks
 *     between unrelated tasks), wired to:
 *       - the REAL DomScanner/ActionQueue/Verification/ElementActions
 *         (all DOM-dependent, so they must live here in the content
 *         script, not in the background service worker)
 *       - a `runEnsemble` function that delegates the actual AI network
 *         call to the background service worker via message passing,
 *         so API keys never need to exist in this (page-adjacent)
 *         execution context.
 *  4. Drive the Overlay (arrow cursor, highlight) from Planner progress
 *     events.
 *  5. Respond to RUN_GOAL / STOP_GOAL / permission messages from the
 *     popup (relayed through background.js).
 */
(function () {
  const logger = self.AICursor.Logger.create('content');
  const ORIGIN = window.location.origin;

  let currentPlanner = null;

  // --- Permission handling on load -----------------------------------------
  async function initPermissionUi() {
    const status = await self.AICursor.PermissionStore.check(ORIGIN);
    if (status === undefined) {
      self.AICursor.Overlay.showPermissionBanner(
        async () => {
          await self.AICursor.PermissionStore.grant(ORIGIN);
          self.AICursor.Overlay.showActiveBadge();
        },
        async () => {
          await self.AICursor.PermissionStore.deny(ORIGIN);
        }
      );
    } else if (status === true) {
      self.AICursor.Overlay.showActiveBadge();
    }
    // status === false (explicitly denied) -> stay completely silent
  }

  try {
    initPermissionUi();
    self.AICursor.DomScanner.startObserving(document.body);
  } catch (err) {
    // Some special pages (certain PDF viewers, restricted internal
    // pages) can throw when touched this early - fail silently rather
    // than breaking page load for the user.
    logger.warn('Failed to initialize on this page', String(err));
  }

  // --- Bridge: Planner's AI calls go through the background worker --------
  // This keeps API keys out of the content script's (page-adjacent)
  // execution context entirely - they live only in the background
  // service worker's access to chrome.storage.
  function runEnsembleViaBackground({ goal, elements }) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'RUN_ENSEMBLE', goal, elements }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  // --- Bridge: navigation requests go through the background worker -------
  // chrome.tabs is not available inside a content script, so any
  // navigate/open-tab decision the Planner makes has to be relayed to
  // the background service worker, which validates it (safe URL scheme,
  // AND explicitly named in the user's own goal) before ever touching
  // chrome.tabs. See background.js's handleNavigationRequest.
  function navigateViaBackground(action, url, goal) {
    return new Promise((resolve, reject) => {
      const messageType = action === 'navigate' ? 'NAVIGATE_TAB' : 'OPEN_TAB';
      chrome.runtime.sendMessage({ type: messageType, url, goal }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  function createPlanner(goal) {
    return new self.AICursor.Planner({
      domScanner: self.AICursor.DomScanner,
      actionQueue: new self.AICursor.ActionQueue({ maxRetries: 2, retryDelayMs: 300 }),
      verification: self.AICursor.Verification,
      elementActions: self.AICursor.ElementActions,
      runEnsemble: runEnsembleViaBackground,
      navigator: (action, url) => navigateViaBackground(action, url, goal),
      providers: [], // unused directly here - runEnsemble delegates provider selection to the background worker
      settings: {},
      logger: self.AICursor.Logger.create('planner'),
      maxSteps: 8,
      maxConsecutiveFailures: 3,
      maxRepeatedFailuresPerLabel: 2,
    });
  }

  // --- Drive the visible overlay from Planner progress events --------------
  function handleProgress(event) {
    const STATES = self.AICursor.PlannerStates.STATES;
    if ((event.phase === STATES.ACTING || event.phase === STATES.AWAITING_CONFIRMATION) && event.detail && typeof event.detail === 'object') {
      const el = self.AICursor.DomScanner.getElementByIndex(event.detail.elementIndex);
      if (el) {
        self.AICursor.Overlay.pointAt(el, event.detail.label, event.detail.sensitive);
      }
    }
    // Best-effort broadcast to the popup, if it happens to be open. This
    // is genuinely optional - if the popup is closed, this send fails
    // silently and the planner keeps running regardless.
    try {
      chrome.runtime.sendMessage({
        type: 'PLANNER_PROGRESS',
        phase: event.phase,
        detail: typeof event.detail === 'string' ? event.detail : (event.detail && event.detail.message) || null,
      });
    } catch (e) {
      /* popup not listening - fine */
    }
  }

  // --- Message handling ------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const validation = self.AICursor.InputValidation.validateMessage(message);
    if (!validation.valid) {
      logger.warn('Rejected invalid message', validation.reason);
      sendResponse({ error: validation.reason });
      return false;
    }
    if (!self.AICursor.InputValidation.isSenderTrusted(sender)) {
      logger.warn('Rejected message from untrusted sender');
      sendResponse({ error: 'Untrusted sender.' });
      return false;
    }

    if (message.type === 'CHECK_PERMISSION') {
      self.AICursor.PermissionStore.check(ORIGIN).then((status) => sendResponse({ status }));
      return true;
    }

    if (message.type === 'GRANT_PERMISSION') {
      self.AICursor.PermissionStore.grant(ORIGIN).then(() => {
        self.AICursor.Overlay.removePermissionBanner();
        self.AICursor.Overlay.showActiveBadge();
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.type === 'DISABLE_PERMISSION') {
      self.AICursor.PermissionStore.deny(ORIGIN).then(() => {
        self.AICursor.Overlay.removeActiveBadge();
        self.AICursor.Overlay.hideCursor();
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.type === 'RUN_GOAL') {
      (async () => {
        const status = await self.AICursor.PermissionStore.check(ORIGIN);
        if (status !== true) {
          sendResponse({ status: 'failed', reason: 'AI Cursor is not enabled on this site yet.' });
          return;
        }
        currentPlanner = createPlanner(message.goal);
        const result = await currentPlanner.run(message.goal, { onProgress: handleProgress });
        sendResponse(result);
      })();
      return true;
    }

    if (message.type === 'STOP_GOAL') {
      if (currentPlanner) currentPlanner.stop();
      sendResponse({ success: true });
      return true;
    }

    return false;
  });

  logger.info('Content script initialized on', ORIGIN);
})();
