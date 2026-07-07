/**
 * test/run-module4-node.js
 *
 * Tests the real Planner class with 100% fake, injected dependencies -
 * no jsdom, no real DOM, no network call, no real AI provider. This is
 * itself a demonstration of the module's core design goal: if the
 * Planner required a real browser or a real AI provider to test, it
 * would not actually be browser-agnostic/provider-agnostic, regardless
 * of what its documentation claimed.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.self = global;
global.performance = global.performance || { now: () => Date.now() };
global.chrome = {
  runtime: { id: 'test-extension-id', getManifest: () => ({}) },
  storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
};

const srcRoot = path.join(__dirname, '..', 'src');
const filesInOrder = [
  'utils/logger.js',
  'utils/storage.js',
  'actions/actionQueue.js',
  'planner/plannerStates.js',
  'planner/loopGuard.js',
  'planner/planner.js',
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

/**
 * Builds a fully fake dependency set for the Planner. Each test
 * overrides only the pieces it needs to exercise, keeping every test
 * focused on one behavior.
 */
function buildFakeDeps(overrides) {
  const fakeElementActions = { click: async () => true };
  const fakeVerification = {
    snapshot: () => ({}),
    verify: () => ({ verified: true, reason: 'fake: assumed success' }),
  };
  const fakeDomScanner = {
    scan: async () => ({ elements: [{ index: 0, tag: 'button', label: 'Next' }] }),
    getElementByIndex: (i) => ({ fakeElementRef: true, index: i }),
    invalidate: () => {},
  };
  const fakeRunEnsemble = async () => ({ index: 0, note: 'fake match' });

  const deps = {
    domScanner: fakeDomScanner,
    actionQueue: new AICursor.ActionQueue({ maxRetries: 0, retryDelayMs: 1 }),
    verification: fakeVerification,
    elementActions: fakeElementActions,
    runEnsemble: fakeRunEnsemble,
    providers: [],
    settings: {},
    logger: { debug() {}, info() {}, warn() {}, error() {}, time() {}, timeEnd() {} },
    maxSteps: 5,
    maxConsecutiveFailures: 3,
    maxRepeatedFailuresPerLabel: 2,
  };

  return Object.assign(deps, overrides || {});
}

async function main() {
  // --- plannerStates ---------------------------------------------------
  const S = AICursor.PlannerStates.STATES;
  check('plannerStates: DONE is terminal', AICursor.PlannerStates.isTerminal(S.DONE) === true);
  check('plannerStates: SCANNING is not terminal', AICursor.PlannerStates.isTerminal(S.SCANNING) === false);

  // --- loopGuard (unit-level, no Planner involved) --------------------------
  const guard = new AICursor.LoopGuard({ maxSteps: 3, maxConsecutiveFailures: 2, maxRepeatedFailuresPerLabel: 2 });
  check('loopGuard: not at max steps initially', guard.hasReachedMaxSteps() === false);
  guard.recordStep(); guard.recordStep(); guard.recordStep();
  check('loopGuard: reports max steps reached after 3 recorded steps (limit 3)', guard.hasReachedMaxSteps() === true);

  const guard2 = new AICursor.LoopGuard({ maxConsecutiveFailures: 2 });
  guard2.recordFailure('X');
  check('loopGuard: one failure is not yet "too many"', guard2.hasTooManyConsecutiveFailures() === false);
  guard2.recordFailure('X');
  check('loopGuard: two consecutive failures trips the consecutive-failure guard', guard2.hasTooManyConsecutiveFailures() === true);
  guard2.recordSuccess('X');
  check('loopGuard: a success resets the consecutive-failure counter', guard2.hasTooManyConsecutiveFailures() === false);

  const guard3 = new AICursor.LoopGuard({ maxRepeatedFailuresPerLabel: 2 });
  guard3.recordFailure('Same Button');
  check('loopGuard: one failure on a label is not yet looping', guard3.isLabelLooping('Same Button') === false);
  guard3.recordFailure('Same Button');
  check('loopGuard: two failures on the SAME label trips the loop guard', guard3.isLabelLooping('Same Button') === true);
  check('loopGuard: a different label is unaffected by another label\'s failures', guard3.isLabelLooping('Different Button') === false);

  // --- Planner: constructor validation --------------------------------------
  let threwOnMissingDeps = false;
  try { new AICursor.Planner({}); } catch (e) { threwOnMissingDeps = true; }
  check('Planner: throws on construction if required dependencies are missing', threwOnMissingDeps === true);

  // --- Planner: empty goal is rejected immediately --------------------------
  const plannerEmptyGoal = new AICursor.Planner(buildFakeDeps());
  const emptyGoalResult = await plannerEmptyGoal.run('   ');
  check(
    'Planner: rejects an empty/whitespace-only goal without scanning',
    emptyGoalResult.status === S.FAILED && emptyGoalResult.reason.includes('empty'),
    JSON.stringify(emptyGoalResult)
  );

  // --- Planner: happy path, done on the 2nd scan ----------------------------
  let ensembleCallCount = 0;
  const happyDeps = buildFakeDeps({
    runEnsemble: async () => {
      ensembleCallCount++;
      if (ensembleCallCount === 1) return { index: 0, note: 'first step' };
      return { index: null, alreadyDone: true, note: 'goal now visible' };
    },
  });
  const happyPlanner = new AICursor.Planner(happyDeps);
  const progressEvents = [];
  const happyResult = await happyPlanner.run('do the thing', { onProgress: (e) => progressEvents.push(e.phase) });
  check(
    'Planner: completes with DONE after AI reports the goal accomplished',
    happyResult.status === S.DONE && happyResult.steps.length === 1,
    JSON.stringify(happyResult)
  );
  check(
    'Planner: progress callback receives phases in the expected order',
    progressEvents[0] === S.SCANNING && progressEvents.includes(S.THINKING) && progressEvents.includes(S.ACTING) && progressEvents[progressEvents.length - 1] === S.DONE,
    JSON.stringify(progressEvents)
  );

  // --- Planner: no interactive elements on the page -------------------------
  const noElementsPlanner = new AICursor.Planner(buildFakeDeps({
    domScanner: { scan: async () => ({ elements: [] }), getElementByIndex: () => null, invalidate: () => {} },
  }));
  const noElementsResult = await noElementsPlanner.run('do something');
  check(
    'Planner: fails cleanly when the page has no interactive elements',
    noElementsResult.status === S.FAILED && noElementsResult.reason.includes('No interactive elements'),
    JSON.stringify(noElementsResult)
  );

  // --- Planner: AI finds no reasonable action --------------------------------
  const noActionPlanner = new AICursor.Planner(buildFakeDeps({
    runEnsemble: async () => ({ index: null, note: 'nothing on this page relates to the goal' }),
  }));
  const noActionResult = await noActionPlanner.run('do something unrelated');
  check(
    'Planner: fails with the ensemble\'s note when no reasonable action exists',
    noActionResult.status === S.FAILED && noActionResult.reason.includes('unrelated') === false && noActionResult.reason.includes('nothing'),
    JSON.stringify(noActionResult)
  );

  // --- Planner: max steps reached (never-ending, always-succeeding actions) --
  let neverDoneLabelCounter = 0;
  const neverDonePlanner = new AICursor.Planner(buildFakeDeps({
    maxSteps: 4,
    domScanner: {
      // A different label each scan represents genuinely distinct steps
      // (e.g. a multi-page wizard) - isolates "never finishes" behavior
      // from the same-element loop guard, which is intentionally testing
      // a different failure mode (see the regression test below).
      scan: async () => ({ elements: [{ index: 0, tag: 'button', label: `Step ${neverDoneLabelCounter++}` }] }),
      getElementByIndex: (i) => ({ fake: true, index: i }),
      invalidate: () => {},
    },
    runEnsemble: async () => ({ index: 0, note: 'always another step' }), // never reports alreadyDone
  }));
  const maxStepsResult = await neverDonePlanner.run('an endless task');
  check(
    'Planner: stops at maxSteps when the AI never reports completion',
    maxStepsResult.status === S.MAX_STEPS_REACHED && maxStepsResult.steps.length === 4,
    JSON.stringify(maxStepsResult)
  );

  // --- Planner: loop detection (same element keeps failing) -----------------
  const loopingPlanner = new AICursor.Planner(buildFakeDeps({
    maxSteps: 20,
    maxConsecutiveFailures: 10, // set high so loop detection (not consecutive-failure) is what triggers
    maxRepeatedFailuresPerLabel: 2,
    verification: { snapshot: () => ({}), verify: () => ({ verified: false, reason: 'nothing changed' }) },
  }));
  const loopResult = await loopingPlanner.run('stuck task');
  check(
    'Planner: detects a loop when the same element repeatedly fails to verify',
    loopResult.status === S.LOOP_DETECTED,
    JSON.stringify(loopResult)
  );

  // --- Planner: consecutive-failure guard (different labels each time) ------
  let labelCounter = 0;
  const consecutiveFailPlanner = new AICursor.Planner(buildFakeDeps({
    maxSteps: 20,
    maxConsecutiveFailures: 3,
    maxRepeatedFailuresPerLabel: 100, // set high so per-label loop detection does NOT trigger first
    domScanner: {
      scan: async () => ({ elements: [{ index: 0, tag: 'button', label: `Button ${labelCounter++}` }] }),
      getElementByIndex: (i) => ({ fake: true, index: i }),
      invalidate: () => {},
    },
    verification: { snapshot: () => ({}), verify: () => ({ verified: false, reason: 'nothing changed' }) },
  }));
  const consecutiveFailResult = await consecutiveFailPlanner.run('a task with varied failing buttons');
  check(
    'Planner: stops via consecutive-failure guard when different elements each fail in a row',
    consecutiveFailResult.status === S.FAILED && consecutiveFailResult.reason.includes('consecutive'),
    JSON.stringify(consecutiveFailResult)
  );

  // --- Planner: action throws outright (not just unverified) ----------------
  const throwingPlanner = new AICursor.Planner(buildFakeDeps({
    maxConsecutiveFailures: 1,
    elementActions: { click: async () => { throw new Error('element detached'); } },
  }));
  const throwingResult = await throwingPlanner.run('click something broken');
  check(
    'Planner: treats a thrown action error as a failed step, not a crash',
    throwingResult.status === S.FAILED && throwingResult.steps.some((s) => s.success === false),
    JSON.stringify(throwingResult)
  );

  // --- Planner: cooperative stop() ------------------------------------------
  const stoppablePlanner = new AICursor.Planner(buildFakeDeps());
  stoppablePlanner.stop(); // stop before even starting
  const stoppedResult = await stoppablePlanner.run('a task that should never run');
  check(
    'Planner: honors stop() called before run(), doing zero steps',
    stoppedResult.status === S.STOPPED && stoppedResult.steps.length === 0,
    JSON.stringify(stoppedResult)
  );

  // --- Planner: recovers from an invalid AI-chosen index ---------------------
  let ensembleAttempt = 0;
  const invalidIndexPlanner = new AICursor.Planner(buildFakeDeps({
    maxConsecutiveFailures: 5,
    runEnsemble: async () => {
      ensembleAttempt++;
      if (ensembleAttempt === 1) return { index: 99, note: 'out of range on purpose' }; // no such element
      return { index: null, alreadyDone: true, note: 'recovered' };
    },
    domScanner: {
      scan: async () => ({ elements: [{ index: 0, tag: 'button', label: 'Real Button' }] }),
      getElementByIndex: (i) => (i === 0 ? { fake: true } : null), // index 99 has no element
      invalidate: () => {},
    },
  }));
  const invalidIndexResult = await invalidIndexPlanner.run('recover from bad index');
  check(
    'Planner: records a failed step (not a crash) when AI picks a non-existent index, then continues',
    invalidIndexResult.status === S.DONE,
    JSON.stringify(invalidIndexResult)
  );

  // --- Planner: NEVER auto-clicks a sensitive-flagged element ----------------
  let sensitiveClickAttempted = false;
  const sensitivePlanner = new AICursor.Planner(buildFakeDeps({
    domScanner: {
      scan: async () => ({ elements: [{ index: 0, tag: 'button', label: 'Delete my account', sensitive: true, category: 'destructive' }] }),
      getElementByIndex: () => ({ fake: true }),
      invalidate: () => {},
    },
    elementActions: { click: async () => { sensitiveClickAttempted = true; return true; } },
    runEnsemble: async () => ({ index: 0, note: 'matched delete button' }),
  }));
  const sensitiveResult = await sensitivePlanner.run('delete my account');
  check(
    'Planner: stops at AWAITING_CONFIRMATION and never calls click() on a sensitive element',
    sensitiveResult.status === S.AWAITING_CONFIRMATION && sensitiveClickAttempted === false,
    JSON.stringify(sensitiveResult)
  );
  check(
    'Planner: AWAITING_CONFIRMATION is a terminal state',
    AICursor.PlannerStates.isTerminal(S.AWAITING_CONFIRMATION) === true
  );

  // --- Planner: real-world regression - repeated "successful" clicks on ----
  // the SAME unhelpful element must still trigger loop detection, even
  // when verification (incorrectly, or via a weak signal) reports each
  // individual click as a success. This reproduces an actual bug found
  // in real usage: an element whose only observable effect was a focus
  // change was endlessly re-selected and endlessly "verified," running
  // all the way to max_steps instead of stopping early.
  const fakeAlwaysVerifiedButNeverProgressing = new AICursor.Planner(buildFakeDeps({
    maxSteps: 20,
    maxConsecutiveFailures: 20, // set high so THIS guard isn't what catches it
    maxRepeatedFailuresPerLabel: 20, // same - isolate the selection-repeat guard specifically
    domScanner: {
      scan: async () => ({ elements: [{ index: 0, tag: 'a', label: 'Open Copilot' }] }),
      getElementByIndex: () => ({ fake: true }),
      invalidate: () => {},
    },
    runEnsemble: async () => ({ index: 0, note: 'Matched using free keyword search' }),
    verification: { snapshot: () => ({}), verify: () => ({ verified: true, reason: 'Only keyboard focus moved' }) },
  }));
  const neverProgressingResult = await fakeAlwaysVerifiedButNeverProgressing.run('open setting');
  check(
    'Planner: detects a loop from repeated identical selection even when each click is "verified"',
    neverProgressingResult.status === S.LOOP_DETECTED && neverProgressingResult.steps.length <= 3,
    JSON.stringify(neverProgressingResult)
  );

  // --- Planner: executes a TYPE action when the ensemble requests one -------
  // This is the direct fix for a real reported failure: "create a file
  // named train.csv" requires TYPING the filename, not just clicking -
  // the Planner previously had no code path for this at all.
  let typedValue = null;
  let typedIntoElement = null;
  const typingPlanner = new AICursor.Planner(buildFakeDeps({
    domScanner: {
      scan: async () => ({ elements: [{ index: 0, tag: 'input', type: 'text', label: 'File name' }] }),
      getElementByIndex: () => ({ fake: 'filename-input' }),
      invalidate: () => {},
    },
    elementActions: {
      click: async () => { throw new Error('click should NOT have been called for a type action'); },
      typeText: async (el, value) => { typedValue = value; typedIntoElement = el; return true; },
    },
    runEnsemble: async () => ({ index: 0, action: 'type', value: 'train.csv', note: 'typing the requested filename' }),
  }));
  const typingResult = await typingPlanner.run('create a file named train.csv');
  check(
    'Planner: executes typeText (not click) when the ensemble requests a type action',
    typedValue === 'train.csv' && typedIntoElement && typedIntoElement.fake === 'filename-input',
    JSON.stringify({ typedValue, typingResult })
  );

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
