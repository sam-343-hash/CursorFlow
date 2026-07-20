/**
 * src/background/background.js
 *
 * The background service worker entry point. Responsibilities:
 *
 *  1. Run the AI ensemble (RUN_ENSEMBLE) - the ONLY place API keys are
 *     read from storage and used.
 *
 *  2. Relay messages from the popup/options page to the content script
 *     (RELAY_TO_CONTENT), with SELF-HEALING injection if the content
 *     script hasn't been injected into a tab yet.
 *
 *  3. Handle cross-page navigation (NAVIGATE_TAB / OPEN_TAB) - the only
 *     context that can call chrome.tabs, since content scripts cannot.
 *     Every navigation request is validated twice before it's allowed:
 *     the URL must be a plain http/https address (not chrome://,
 *     file://, javascript:, etc.), AND the destination must have been
 *     explicitly named in the user's own goal text - the AI is not
 *     permitted to choose a website on its own.
 *
 *  4. Auto-continue a goal after an extension-initiated navigation
 *     completes (see src/mission/missionController.js) - this is what
 *     lets a task survive moving to a new page, which a lone
 *     content-script-bound Planner instance cannot do by itself.
 */

importScripts(
  '../utils/logger.js',
  '../utils/storage.js',
  '../security/inputValidation.js',
  '../ai/httpRetry.js',
  '../ai/promptBuilder.js',
  '../ai/providerInterface.js',
  '../ai/providers/geminiProvider.js',
  '../ai/providers/groqProvider.js',
  '../ai/providers/ollamaProvider.js',
  '../ai/keywordFallback.js',
  '../ai/providerRegistry.js',
  '../ai/ensemble.js',
  '../actions/navigationActions.js',
  '../mission/missionController.js'
);

const logger = self.AICursor.Logger.create('background');

// This list MUST stay in sync with manifest.json's content_scripts.js
// array (same files, same order). Duplicated here because
// chrome.scripting.executeScript needs an explicit file list at
// runtime; test/validate-manifest.js guards against these drifting
// apart silently.
const CONTENT_SCRIPT_FILES = [
  'src/utils/logger.js',
  'src/utils/storage.js',
  'src/security/permissions.js',
  'src/security/sensitiveActionGuard.js',
  'src/security/inputValidation.js',
  'src/browser/domScanner.js',
  'src/browser/verification.js',
  'src/actions/elementActions.js',
  'src/actions/actionQueue.js',
  'src/planner/plannerStates.js',
  'src/planner/loopGuard.js',
  'src/planner/planner.js',
  'src/ui/overlay/overlay.js',
  'src/content/contentBootstrap.js',
];
const CONTENT_SCRIPT_CSS = ['src/ui/overlay/overlay.css'];

/**
 * Sends a message to a tab's content script, auto-injecting the content
 * script into that tab first if it isn't there yet, then retrying once.
 */
async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    logger.debug('Content script not reachable, attempting injection', firstError.message);
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_SCRIPT_CSS });
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
    } catch (injectError) {
      throw new Error('This page does not allow extensions to run on it (e.g. a Chrome system page or the Web Store).');
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (secondError) {
      throw new Error('Could not connect after injecting. Try reloading the page once, then try again.');
    }
  }
}

async function handleRunEnsemble(goal, elements) {
  const settings = await self.AICursor.Storage.get([
    'geminiApiKey', 'groqApiKey', 'ollamaEnabled', 'ollamaUrl', 'ollamaModel',
  ]);

  const configuredProviders = self.AICursor.ProviderRegistry.getConfiguredProviders(settings);
  logger.debug(`Running ensemble with ${configuredProviders.length} configured provider(s)`, configuredProviders.map((p) => p.name));

  return self.AICursor.Ensemble.runEnsemble({ goal, elements, providers: configuredProviders, settings });
}

/**
 * Handles a NAVIGATE_TAB or OPEN_TAB request from a content script's
 * Planner. Two independent safety checks gate every request, and both
 * must pass before chrome.tabs is ever touched:
 *   1. isSafeUrl - only http/https, never chrome://, file://, javascript:.
 *   2. isUrlMentionedInGoal - the destination must be explicitly named
 *      in the goal the user actually typed, not chosen by the AI.
 * On success, a mission record is created/updated so that when the
 * destination page finishes loading, the goal automatically continues
 * there instead of silently stopping.
 */
async function handleNavigationRequest(message, sender) {
  const { url, goal } = message;
  const nav = self.AICursor.NavigationActions;

  if (!nav.isSafeUrl(url)) {
    throw new Error(`Refused to navigate: "${url}" is not a plain web address.`);
  }
  if (!nav.isUrlMentionedInGoal(goal, url)) {
    throw new Error(
      `Refused to navigate to ${url}: this site was not named in your goal, so the AI is not allowed to choose it on its own.`
    );
  }

  const sourceTabId = sender && sender.tab && sender.tab.id;

  if (message.type === 'NAVIGATE_TAB') {
    if (!sourceTabId) throw new Error('Could not determine which tab to navigate.');
    const result = await nav.navigateTab(sourceTabId, url);
    await self.AICursor.MissionController.startOrUpdateMission(sourceTabId, goal);
    return result;
  }

  // OPEN_TAB: the mission continues in the NEW tab, not the one that requested it.
  const result = await nav.openTab(url);
  await self.AICursor.MissionController.startOrUpdateMission(result.tabId, goal);
  return result;
}

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

  if (message.type === 'RUN_ENSEMBLE') {
    handleRunEnsemble(message.goal, message.elements)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_PROVIDER_STATUS') {
    self.AICursor.Storage.get(['geminiApiKey', 'groqApiKey', 'ollamaEnabled', 'ollamaUrl', 'ollamaModel'])
      .then((settings) => {
        const configured = self.AICursor.ProviderRegistry.getConfiguredProviders(settings);
        sendResponse({ providerNames: configured.map((p) => p.name) });
      });
    return true;
  }

  if (message.type === 'NAVIGATE_TAB' || message.type === 'OPEN_TAB') {
    handleNavigationRequest(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'RELAY_TO_CONTENT') {
    sendToContentScript(message.tabId, message.payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

/**
 * Fires whenever ANY tab finishes loading a page. Only acts if that tab
 * has an active mission recorded (created exclusively inside
 * handleNavigationRequest above, right after THIS extension navigated
 * it) - a tab the user navigates manually on their own never has a
 * mission record, so this never hijacks ordinary browsing.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  self.AICursor.MissionController.getMission(tabId).then(async (mission) => {
    if (!mission) return;

    if (self.AICursor.MissionController.hasExceededTransitionLimit(mission)) {
      logger.warn(`Mission on tab ${tabId} exceeded ${self.AICursor.MissionController.MAX_PAGE_TRANSITIONS} page transitions - stopping.`, mission.goal);
      await self.AICursor.MissionController.endMission(tabId);
      return;
    }

    await self.AICursor.MissionController.markContinued(tabId);
    logger.debug(`Auto-continuing mission on tab ${tabId} after page load`, mission.goal);

    try {
      const result = await sendToContentScript(tabId, { type: 'RUN_GOAL', goal: mission.goal });
      if (!result || result.status !== 'navigating') {
        await self.AICursor.MissionController.endMission(tabId);
      }
    } catch (err) {
      logger.warn(`Failed to auto-continue mission on tab ${tabId}`, err.message);
      await self.AICursor.MissionController.endMission(tabId);
    }
  });
});

logger.info('Background service worker started');
