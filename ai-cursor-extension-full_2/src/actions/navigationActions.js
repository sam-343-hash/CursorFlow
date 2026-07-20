/**
 * src/actions/navigationActions.js
 *
 * Real cross-page navigation - navigating the current tab to a URL, or
 * opening a URL in a new tab. This deliberately lives in the BACKGROUND
 * service worker, not the content script: `chrome.tabs` is only
 * available to extension pages (background, popup, options), not to
 * content scripts running inside a webpage's isolated world. Any
 * navigation request from the Planner (which runs in the content
 * script) has to be relayed here via message passing - see
 * background.js's NAVIGATE_TAB / OPEN_TAB handlers.
 *
 * Safety validation: only http/https URLs are ever allowed. This blocks
 * an AI decision (or a manipulated page trying to influence one) from
 * navigating to `chrome://`, `file://`, `javascript:`, or `data:` URLs -
 * schemes that could access internal browser pages, local files, or
 * execute arbitrary script content instead of just loading a normal
 * webpage.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('actions.navigation')
    : { debug() {}, warn() {} };

  function isSafeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  async function navigateTab(tabId, url) {
    if (!isSafeUrl(url)) {
      throw new Error(`Refused to navigate to an unsafe or invalid URL: ${url}`);
    }
    logger.debug('Navigating tab', { tabId, url });
    await chrome.tabs.update(tabId, { url });
    return { success: true, url };
  }

  async function openTab(url) {
    if (!isSafeUrl(url)) {
      throw new Error(`Refused to open an unsafe or invalid URL: ${url}`);
    }
    logger.debug('Opening new tab', { url });
    const tab = await chrome.tabs.create({ url });
    return { success: true, url, tabId: tab.id };
  }

  function extractHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) {
      return null;
    }
  }

  /**
   * Confirms the navigation target was actually named by the USER in
   * their own goal text (e.g. "go to github.com and...", "check my
   * email on outlook.com"), not just decided by the AI on its own. This
   * is the core safety boundary for Module 6: the AI can navigate
   * somewhere the user asked for, but cannot autonomously choose which
   * websites to visit for a broader, unspecified goal like "find me the
   * best flight" - that kind of open-ended site selection is a bigger
   * trust decision reserved for a future module with its own explicit,
   * user-configured allowlist.
   */
  function isUrlMentionedInGoal(goal, url) {
    const hostname = extractHostname(url);
    if (!hostname) return false;
    const goalLower = (goal || '').toLowerCase();
    if (goalLower.includes(hostname)) return true;
    const mainPart = hostname.split('.')[0];
    return mainPart.length >= 3 && goalLower.includes(mainPart);
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.NavigationActions = { navigateTab, openTab, isSafeUrl, isUrlMentionedInGoal, extractHostname };
})();
