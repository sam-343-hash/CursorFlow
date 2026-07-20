/**
 * src/mission/missionController.js
 *
 * The piece that makes a goal survive a page navigation. The Planner
 * itself is content-script-bound and dies the instant its page
 * navigates away - this module lives in the BACKGROUND service worker
 * instead, and remembers "tab 42 is mid-goal: 'go to github.com and
 * check notifications'" using chrome.storage.session (memory-based,
 * survives a service worker restart within the same browser session,
 * but doesn't persist forever - the right lifetime for an in-progress
 * task, not something that should silently resurrect days later).
 *
 * Safety property this preserves: auto-continuation ONLY happens for a
 * tab where THIS extension itself just navigated (via NAVIGATE_TAB or
 * OPEN_TAB) as part of an active goal - never for a tab the user
 * navigates manually on their own. A mission record is only ever
 * created inside background.js's navigation handler, right after a
 * successful extension-initiated navigation.
 *
 * A hard cap on page transitions (MAX_PAGE_TRANSITIONS) prevents a
 * goal from silently navigating forever across an unbounded chain of
 * pages if the AI keeps deciding "one more site" - mirrors the same
 * loop-protection philosophy as the Planner's own maxSteps.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('mission')
    : { debug() {}, warn() {} };

  const MAX_PAGE_TRANSITIONS = 5;

  function sessionGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(keys, (result) => {
          if (chrome.runtime.lastError) { resolve({}); return; }
          resolve(result || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function sessionSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.set(obj, () => resolve(!chrome.runtime.lastError));
      } catch (e) {
        resolve(false);
      }
    });
  }

  function sessionRemove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.remove(keys, () => resolve(!chrome.runtime.lastError));
      } catch (e) {
        resolve(false);
      }
    });
  }

  function keyFor(tabId) {
    return `mission:${tabId}`;
  }

  /**
   * Called right after this extension successfully navigates a tab (or
   * opens a new one) as part of an active goal. Creates a new mission
   * record, or increments the transition count on an existing one.
   */
  async function startOrUpdateMission(tabId, goal) {
    const key = keyFor(tabId);
    const existing = (await sessionGet([key]))[key];
    const transitions = existing ? existing.transitions + 1 : 1;
    const mission = {
      goal,
      tabId,
      transitions,
      startedAt: existing ? existing.startedAt : Date.now(),
      status: 'awaiting_page_load',
    };
    await sessionSet({ [key]: mission });
    logger.debug('Mission started/updated', mission);
    return mission;
  }

  async function getMission(tabId) {
    const key = keyFor(tabId);
    return (await sessionGet([key]))[key] || null;
  }

  async function markContinued(tabId) {
    const mission = await getMission(tabId);
    if (!mission) return null;
    mission.status = 'active';
    await sessionSet({ [keyFor(tabId)]: mission });
    return mission;
  }

  async function endMission(tabId) {
    logger.debug('Mission ended', tabId);
    return sessionRemove([keyFor(tabId)]);
  }

  function hasExceededTransitionLimit(mission) {
    return !!mission && mission.transitions >= MAX_PAGE_TRANSITIONS;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.MissionController = {
    startOrUpdateMission,
    getMission,
    markContinued,
    endMission,
    hasExceededTransitionLimit,
    MAX_PAGE_TRANSITIONS,
  };
})();
