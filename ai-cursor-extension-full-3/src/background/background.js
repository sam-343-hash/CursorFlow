/**
 * src/background/background.js
 *
 * The background service worker entry point. Two responsibilities only:
 *
 *  1. Run the AI ensemble (RUN_ENSEMBLE) - this is the ONLY place API
 *     keys are read from storage and used, which is why the content
 *     script never calls a provider directly; it always asks the
 *     background worker to do it.
 *
 *  2. Relay messages from the popup/options page to the content script
 *     (RELAY_TO_CONTENT), with SELF-HEALING injection: if the content
 *     script hasn't been injected into a tab yet (a real, common
 *     situation right after installing or reloading the extension,
 *     since Chrome only auto-injects content scripts into NEW page
 *     loads, not tabs that were already open), this automatically
 *     injects it and retries, instead of failing with a confusing
 *     "could not establish connection" error.
 *
 * This file uses importScripts() (classic worker, not ES modules) so
 * every src/ file can stay in the same self.AICursor namespace pattern
 * used by the content script and popup/options pages - one consistent
 * loading mechanism across the whole extension, no build step required.
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
  '../ai/ensemble.js'
);

const logger = self.AICursor.Logger.create('background');

// This list MUST stay in sync with manifest.json's content_scripts.js
// array (same files, same order). It exists here separately because
// chrome.scripting.executeScript needs an explicit file list at runtime
// and manifest.json cannot be read as JS data from inside a service
// worker without an extra fetch - duplicating a short, rarely-changed
// list is simpler and more transparent than that indirection. The
// project's build-time file-existence check (test/validate-manifest.js)
// guards against this list and the manifest drifting apart silently.
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

  if (message.type === 'RELAY_TO_CONTENT') {
    sendToContentScript(message.tabId, message.payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

logger.info('Background service worker started');
