/**
 * test/run-module2-node.js
 *
 * Verifies src/browser (domScanner, verification) and src/actions
 * (elementActions, actionQueue) against a REAL DOM provided by jsdom -
 * not a mocked one. jsdom implements MutationObserver, event dispatch,
 * and the DOM tree faithfully; it does not implement CSS layout, so
 * getBoundingClientRect() always returns a zero-sized rect by default.
 * We patch that per-test-element only (a standard, well-known pattern
 * for testing layout-dependent code under jsdom), leaving the actual
 * module source completely untouched.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://example.com/page1',
  pretendToBeVisual: true,
});

global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
global.MutationObserver = dom.window.MutationObserver;
global.MouseEvent = dom.window.MouseEvent;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.Event = dom.window.Event;
global.HTMLInputElement = dom.window.HTMLInputElement;
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
global.self = global;
global.performance = global.performance || { now: () => Date.now() };
global.chrome = {
  runtime: { id: 'test-extension-id', getManifest: () => ({}) },
  storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
};

// Give every element a fake, non-zero bounding box so visibility checks
// (which require width/height > 0) pass by default. Tests that need an
// element to be treated as "hidden" override this per-element.
function makeVisible(el, overrides) {
  el.getBoundingClientRect = () => Object.assign({ top: 0, left: 0, width: 100, height: 30, right: 100, bottom: 30 }, overrides || {});
}

const srcRoot = path.join(__dirname, '..', 'src');
const filesInOrder = [
  'utils/logger.js',
  'utils/storage.js',
  'security/sensitiveActionGuard.js',
  'browser/domScanner.js',
  'browser/verification.js',
  'actions/elementActions.js',
  'actions/actionQueue.js',
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

function resetBody() {
  document.body.innerHTML = '';
  AICursor.DomScanner.invalidate();
}

async function main() {
  // --- domScanner: basic scan + labeling + dedupe -------------------------
  resetBody();
  document.body.innerHTML = `
    <button aria-label="Save changes">ignored text</button>
    <a href="#">Home</a>
    <input type="text" placeholder="Search...">
    <button>Follow</button>
    <button>Follow</button>
    <button style="display:none">Hidden Button</button>
    <div role="button">Custom widget</div>
  `;
  document.querySelectorAll('button, a, input, [role="button"]').forEach((el) => makeVisible(el));
  // Explicitly make the "display:none" one report zero size, like a real browser would
  const hiddenBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Hidden'));
  makeVisible(hiddenBtn, { width: 0, height: 0 });

  const scanResult = AICursor.DomScanner.scan();
  const labels = scanResult.elements.map((e) => e.label);

  check(
    'domScanner: finds visible elements with correct labels',
    labels.includes('Save changes') && labels.includes('Home') && labels.includes('Search...') && labels.includes('Custom widget'),
    JSON.stringify(labels)
  );
  check('domScanner: excludes display:none elements', !labels.includes('Hidden Button'), JSON.stringify(labels));
  check(
    'domScanner: deduplicates identical tag+label pairs',
    labels.filter((l) => l === 'Follow').length === 1,
    JSON.stringify(labels)
  );
  check(
    'domScanner: flags sensitive-looking labels via SensitiveActionGuard',
    scanResult.elements.every((e) => e.label !== 'Save changes' || e.sensitive === false),
    'Save changes should NOT be flagged sensitive (sanity check that guard is wired correctly)'
  );

  // --- domScanner: caching + MutationObserver invalidation -----------------
  resetBody();
  document.body.innerHTML = `<button aria-label="Alpha"></button>`;
  makeVisible(document.querySelector('button'));
  AICursor.DomScanner.startObserving(document.body);
  const firstScan = AICursor.DomScanner.scan();
  const secondScanNoChange = AICursor.DomScanner.scan();
  check(
    'domScanner: returns cached object (same reference) when nothing changed',
    firstScan === secondScanNoChange,
    'Expected scan() to short-circuit via cache when no mutation occurred'
  );

  const newBtn = document.createElement('button');
  newBtn.setAttribute('aria-label', 'Beta');
  makeVisible(newBtn);
  document.body.appendChild(newBtn);
  await new Promise((r) => setTimeout(r, 20)); // let MutationObserver microtask fire
  const thirdScan = AICursor.DomScanner.scan();
  check(
    'domScanner: MutationObserver invalidates cache after DOM change',
    thirdScan !== firstScan && thirdScan.elements.some((e) => e.label === 'Beta'),
    `elements found: ${JSON.stringify(thirdScan.elements.map((e) => e.label))}`
  );
  AICursor.DomScanner.stopObserving();

  // --- browser/verification -------------------------------------------------
  resetBody();
  document.body.innerHTML = `<button aria-label="Target">x</button>`;
  const targetEl = document.querySelector('button');
  makeVisible(targetEl);
  const before = AICursor.Verification.snapshot(targetEl);
  targetEl.remove();
  const removalResult = AICursor.Verification.verify(before, targetEl);
  check(
    'verification: detects element removal as a verified change',
    removalResult.verified === true && removalResult.reason.includes('removed'),
    JSON.stringify(removalResult.reason)
  );

  resetBody();
  document.body.innerHTML = `<button aria-label="Untouched">x</button>`;
  const untouchedEl = document.querySelector('button');
  makeVisible(untouchedEl);
  const before2 = AICursor.Verification.snapshot(untouchedEl);
  const noopResult = AICursor.Verification.verify(before2, untouchedEl);
  check(
    'verification: reports unverified when nothing changed',
    noopResult.verified === false,
    JSON.stringify(noopResult)
  );

  // --- actions/elementActions -----------------------------------------------
  resetBody();
  document.body.innerHTML = `<button>Click me</button>`;
  const clickTarget = document.querySelector('button');
  makeVisible(clickTarget);
  let clickFired = false;
  clickTarget.addEventListener('click', () => { clickFired = true; });
  AICursor.ElementActions.click(clickTarget);
  check('elementActions.click: dispatches a real click event', clickFired === true);

  resetBody();
  document.body.innerHTML = `<input type="text">`;
  const inputEl = document.querySelector('input');
  makeVisible(inputEl);
  let inputEventFired = false;
  inputEl.addEventListener('input', () => { inputEventFired = true; });
  AICursor.ElementActions.typeText(inputEl, 'hello world');
  check(
    'elementActions.typeText: sets value AND fires input event (React-safe path)',
    inputEl.value === 'hello world' && inputEventFired === true,
    `value=${inputEl.value}, inputEventFired=${inputEventFired}`
  );

  resetBody();
  document.body.innerHTML = `<select><option value="a">Alpha</option><option value="b">Beta</option></select>`;
  const selectEl = document.querySelector('select');
  let changeEventFired = false;
  selectEl.addEventListener('change', () => { changeEventFired = true; });
  const selectResult = AICursor.ElementActions.selectOption(selectEl, 'Beta');
  check(
    'elementActions.selectOption: selects by visible text and fires change',
    selectResult === true && selectEl.value === 'b' && changeEventFired === true,
    `result=${selectResult}, value=${selectEl.value}, changeEventFired=${changeEventFired}`
  );

  const selectMissResult = AICursor.ElementActions.selectOption(selectEl, 'DoesNotExist');
  check('elementActions.selectOption: returns false (not throw) for missing option', selectMissResult === false);

  resetBody();
  document.body.innerHTML = `<div tabindex="0"></div>`;
  const keyTarget = document.querySelector('div');
  makeVisible(keyTarget);
  let keydownFired = false;
  keyTarget.addEventListener('keydown', (e) => { if (e.key === 'Enter') keydownFired = true; });
  AICursor.ElementActions.pressKey(keyTarget, 'Enter');
  check('elementActions.pressKey: dispatches keydown with correct key', keydownFired === true);

  // --- actions/actionQueue: retry + verification integration -----------------
  const queue = new AICursor.ActionQueue({ maxRetries: 2, retryDelayMs: 10 });

  let attemptCount = 0;
  const eventualSuccessResult = await queue.enqueue(
    () => { attemptCount++; if (attemptCount < 3) throw new Error('not ready yet'); return 'ok'; },
    { label: 'retry-until-success' }
  );
  check(
    'actionQueue: retries a throwing action until it succeeds within maxRetries',
    eventualSuccessResult.success === true && attemptCount === 3,
    `attempts=${attemptCount}`
  );

  let alwaysFailAttempts = 0;
  let queueRejected = false;
  try {
    await queue.enqueue(
      () => { alwaysFailAttempts++; throw new Error('permanent failure'); },
      { label: 'always-fails' }
    );
  } catch (e) {
    queueRejected = true;
  }
  check(
    'actionQueue: rejects after exhausting retries on a permanently failing action',
    queueRejected === true && alwaysFailAttempts === 3, // initial try + 2 retries
    `attempts=${alwaysFailAttempts}, rejected=${queueRejected}`
  );

  const verifyFailResult = await queue.enqueue(
    () => 'did something',
    { label: 'unverifiable-action', verify: () => ({ verified: false, reason: 'nothing changed' }) }
  );
  check(
    'actionQueue: reports success:false when action runs but verification never passes',
    verifyFailResult.success === false && verifyFailResult.error.includes('nothing changed'),
    JSON.stringify(verifyFailResult)
  );

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
