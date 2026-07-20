/**
 * test/run-module6-node.js
 *
 * Tests navigationActions.js, missionController.js, and background.js's
 * navigation/mission integration. background.js itself is loaded and
 * executed (not reimplemented in the test) by stubbing the browser APIs
 * it touches (chrome.tabs, chrome.storage.session, chrome.scripting)
 * and capturing the listeners it registers, so these tests exercise the
 * real file.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.self = global;
global.performance = global.performance || { now: () => Date.now() };

// --- Fake chrome APIs -------------------------------------------------------
const fakeLocalStorage = {};
const fakeSessionStorage = {};
const fakeTabs = {}; // tabId -> { url }
let nextTabId = 100;
let capturedOnMessageListener = null;
let capturedOnUpdatedListener = null;
const navigateCalls = [];
const createCalls = [];
const sentMessages = []; // messages sent via chrome.tabs.sendMessage, for assertions

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    getManifest: () => ({}),
    onMessage: { addListener: (fn) => { capturedOnMessageListener = fn; } },
  },
  storage: {
    local: {
      get: (keys, cb) => {
        const result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in fakeLocalStorage) result[k] = fakeLocalStorage[k]; });
        cb(result);
      },
      set: (obj, cb) => { Object.assign(fakeLocalStorage, obj); cb && cb(); },
      remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete fakeLocalStorage[k]); cb && cb(); },
    },
    session: {
      get: (keys, cb) => {
        const result = {};
        if (keys === null) Object.assign(result, fakeSessionStorage);
        else (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in fakeSessionStorage) result[k] = fakeSessionStorage[k]; });
        cb(result);
      },
      set: (obj, cb) => { Object.assign(fakeSessionStorage, obj); cb && cb(); },
      remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete fakeSessionStorage[k]); cb && cb(); },
    },
  },
  tabs: {
    update: (tabId, props) => {
      navigateCalls.push({ tabId, url: props.url });
      fakeTabs[tabId] = { url: props.url };
      return Promise.resolve();
    },
    create: (props) => {
      const tabId = nextTabId++;
      createCalls.push({ tabId, url: props.url });
      fakeTabs[tabId] = { url: props.url };
      return Promise.resolve({ id: tabId });
    },
    sendMessage: (tabId, message) => {
      sentMessages.push({ tabId, message });
      return Promise.resolve(global.__fakeContentScriptResponse || { status: 'done', reason: 'ok', steps: [] });
    },
    onUpdated: { addListener: (fn) => { capturedOnUpdatedListener = fn; } },
  },
  scripting: {
    executeScript: () => Promise.resolve(),
    insertCSS: () => Promise.resolve(),
  },
};

// importScripts inside background.js: since this test harness already
// loads every dependency manually, in the correct order, BEFORE
// background.js itself, importScripts here is a safe no-op.
global.importScripts = function () {};

const srcRoot = path.join(__dirname, '..', 'src');
const filesInOrder = [
  'utils/logger.js',
  'utils/storage.js',
  'security/inputValidation.js',
  'ai/httpRetry.js',
  'ai/promptBuilder.js',
  'ai/providerInterface.js',
  'ai/providers/geminiProvider.js',
  'ai/providers/groqProvider.js',
  'ai/providers/ollamaProvider.js',
  'ai/keywordFallback.js',
  'ai/providerRegistry.js',
  'ai/ensemble.js',
  'actions/navigationActions.js',
  'mission/missionController.js',
  'background/background.js',
];
for (const relPath of filesInOrder) {
  const fullPath = path.join(srcRoot, relPath);
  vm.runInThisContext(fs.readFileSync(fullPath, 'utf8'), { filename: fullPath });
}

let pass = 0, fail = 0;
function check(name, condition, details) {
  if (condition) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); if (details) console.log(`      ${details}`); }
}

function sendMessage(message, sender) {
  return new Promise((resolve) => {
    capturedOnMessageListener(message, sender || { id: 'test-extension-id', tab: { id: 1 } }, resolve);
  });
}

async function main() {
  check('background.js registered an onMessage listener', typeof capturedOnMessageListener === 'function');
  check('background.js registered a tabs.onUpdated listener', typeof capturedOnUpdatedListener === 'function');

  // --- navigationActions: real chrome.tabs calls -----------------------
  const navResult = await AICursor.NavigationActions.navigateTab(1, 'https://github.com');
  check(
    'navigationActions.navigateTab: calls chrome.tabs.update with the right tab and URL',
    navigateCalls.some((c) => c.tabId === 1 && c.url === 'https://github.com') && navResult.success,
    JSON.stringify(navigateCalls)
  );

  const openResult = await AICursor.NavigationActions.openTab('https://outlook.com');
  check(
    'navigationActions.openTab: calls chrome.tabs.create and returns the new tab id',
    createCalls.some((c) => c.url === 'https://outlook.com') && typeof openResult.tabId === 'number',
    JSON.stringify(createCalls)
  );

  let threwOnUnsafe = false;
  try { await AICursor.NavigationActions.navigateTab(1, 'javascript:alert(1)'); } catch (e) { threwOnUnsafe = true; }
  check('navigationActions.navigateTab: refuses an unsafe URL scheme', threwOnUnsafe === true);

  // --- missionController: full lifecycle --------------------------------
  const m1 = await AICursor.MissionController.startOrUpdateMission(42, 'go to github.com');
  check('missionController.startOrUpdateMission: creates a mission with transitions=1', m1.transitions === 1);

  const m2 = await AICursor.MissionController.startOrUpdateMission(42, 'go to github.com');
  check('missionController.startOrUpdateMission: increments transitions on repeat calls for the same tab', m2.transitions === 2);

  const fetched = await AICursor.MissionController.getMission(42);
  check('missionController.getMission: retrieves the stored mission', fetched && fetched.goal === 'go to github.com');

  const continued = await AICursor.MissionController.markContinued(42);
  check('missionController.markContinued: updates status to active', continued.status === 'active');

  await AICursor.MissionController.endMission(42);
  const afterEnd = await AICursor.MissionController.getMission(42);
  check('missionController.endMission: removes the mission record', afterEnd === null);

  const noMission = await AICursor.MissionController.getMission(9999);
  check('missionController.getMission: returns null for a tab with no mission', noMission === null);

  const limitTest = { transitions: 5 };
  check('missionController.hasExceededTransitionLimit: true at the cap', AICursor.MissionController.hasExceededTransitionLimit(limitTest) === true);
  check('missionController.hasExceededTransitionLimit: false below the cap', AICursor.MissionController.hasExceededTransitionLimit({ transitions: 2 }) === false);

  // --- background.js: NAVIGATE_TAB message handling ----------------------
  const navMsgResult = await sendMessage(
    { type: 'NAVIGATE_TAB', url: 'https://github.com', goal: 'go to github.com and check notifications' },
    { id: 'test-extension-id', tab: { id: 7 } }
  );
  check(
    'background: NAVIGATE_TAB with a goal-matching URL succeeds and creates a mission',
    navMsgResult.success === true,
    JSON.stringify(navMsgResult)
  );
  const missionAfterNav = await AICursor.MissionController.getMission(7);
  check('background: NAVIGATE_TAB creates a mission record for the source tab', missionAfterNav && missionAfterNav.goal.includes('github'));
  await AICursor.MissionController.endMission(7);

  // --- background.js: refuses navigation to a site NOT named in the goal ---
  const refusedResult = await sendMessage(
    { type: 'NAVIGATE_TAB', url: 'https://some-random-airline.example.com', goal: 'book me the cheapest flight to Mumbai' },
    { id: 'test-extension-id', tab: { id: 8 } }
  );
  check(
    'background: NAVIGATE_TAB refuses a site the AI chose on its own (not named in the goal) - the flight-booking safety case',
    !!refusedResult.error && refusedResult.error.includes('not named in your goal'),
    JSON.stringify(refusedResult)
  );

  // --- background.js: refuses an unsafe URL scheme ------------------------
  const unsafeResult = await sendMessage(
    { type: 'NAVIGATE_TAB', url: 'javascript:alert(1)', goal: 'javascript:alert(1) is my goal' },
    { id: 'test-extension-id', tab: { id: 9 } }
  );
  check('background: NAVIGATE_TAB refuses an unsafe URL scheme even if it superficially "matches" the goal text', !!unsafeResult.error);

  // --- background.js: tabs.onUpdated auto-continues an active mission -----
  await AICursor.MissionController.startOrUpdateMission(55, 'go to github.com and check notifications');
  global.__fakeContentScriptResponse = { status: 'done', reason: 'found notifications', steps: [] };
  capturedOnUpdatedListener(55, { status: 'complete' });
  await new Promise((r) => setTimeout(r, 20));

  check(
    'background: tabs.onUpdated auto-sends RUN_GOAL to the tab with an active mission',
    sentMessages.some((m) => m.tabId === 55 && m.message.type === 'RUN_GOAL' && m.message.goal.includes('github')),
    JSON.stringify(sentMessages.filter((m) => m.tabId === 55))
  );

  const missionAfterAutoContinue = await AICursor.MissionController.getMission(55);
  check(
    'background: mission is cleaned up automatically once the continued run reaches a non-navigating terminal state',
    missionAfterAutoContinue === null,
    JSON.stringify(missionAfterAutoContinue)
  );

  // --- background.js: tabs.onUpdated ignores tabs with no active mission ---
  const messagesBefore = sentMessages.length;
  capturedOnUpdatedListener(999, { status: 'complete' });
  await new Promise((r) => setTimeout(r, 20));
  check(
    'background: tabs.onUpdated does nothing for a tab with no active mission (never hijacks ordinary browsing)',
    sentMessages.length === messagesBefore
  );

  // --- background.js: mission continues across multiple page loads --------
  await AICursor.MissionController.startOrUpdateMission(77, 'go to github.com then check settings');
  global.__fakeContentScriptResponse = { status: 'navigating', reason: 'moving to another page', steps: [] };
  capturedOnUpdatedListener(77, { status: 'complete' });
  await new Promise((r) => setTimeout(r, 20));
  const missionStillActive = await AICursor.MissionController.getMission(77);
  check(
    'background: mission is NOT cleaned up if the continued run itself navigates again (multi-page task continues)',
    missionStillActive !== null,
    JSON.stringify(missionStillActive)
  );

  // --- background.js: transition limit stops a runaway mission -----------
  await AICursor.MissionController.endMission(88);
  for (let i = 0; i < AICursor.MissionController.MAX_PAGE_TRANSITIONS; i++) {
    await AICursor.MissionController.startOrUpdateMission(88, 'an endlessly navigating goal');
  }
  const messagesBeforeCap = sentMessages.length;
  capturedOnUpdatedListener(88, { status: 'complete' });
  await new Promise((r) => setTimeout(r, 20));
  check(
    'background: a mission that exceeds MAX_PAGE_TRANSITIONS is stopped instead of auto-continuing forever',
    sentMessages.length === messagesBeforeCap,
    `sent before=${messagesBeforeCap}, after=${sentMessages.length}`
  );
  const missionAfterCap = await AICursor.MissionController.getMission(88);
  check('background: the runaway mission record is cleaned up after hitting the cap', missionAfterCap === null);

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
