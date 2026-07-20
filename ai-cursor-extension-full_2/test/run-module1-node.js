/**
 * test/run-module1-node.js
 *
 * Executes the REAL src/utils and src/security files (unmodified,
 * byte-for-byte) in a minimal Node environment that stubs only the
 * browser APIs they touch (chrome.storage, performance.now). This lets
 * us verify the actual shipped code is correct without needing a full
 * browser - useful here because headless Chromium can't be downloaded
 * in this sandboxed environment, but it's also just a legitimately
 * lightweight way to unit test extension logic in CI later.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- Minimal browser API stubs -------------------------------------------
const fakeStorage = {};
global.chrome = {
  runtime: {
    id: 'test-extension-id',
    getManifest: () => ({}), // no update_url -> logger treats this as a dev build
    lastError: null,
  },
  storage: {
    local: {
      get(keys, cb) {
        const result = {};
        if (keys === null) Object.assign(result, fakeStorage);
        else (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
          if (k in fakeStorage) result[k] = fakeStorage[k];
        });
        cb(result);
      },
      set(obj, cb) { Object.assign(fakeStorage, obj); cb && cb(); },
      remove(keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete fakeStorage[k]);
        cb && cb();
      },
    },
  },
};
global.performance = global.performance || { now: () => Date.now() };
global.self = global; // the modules attach to `self.AICursor`; in Node, self === global here
global.console = console;

// --- Load the real source files in dependency order -----------------------
const srcRoot = path.join(__dirname, '..', 'src');
const filesInOrder = [
  'utils/logger.js',
  'utils/storage.js',
  'security/permissions.js',
  'security/sensitiveActionGuard.js',
  'security/inputValidation.js',
];

for (const relPath of filesInOrder) {
  const fullPath = path.join(srcRoot, relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInThisContext(code, { filename: fullPath });
}

// --- Tiny assertion helper -------------------------------------------------
let pass = 0;
let fail = 0;
function check(name, condition, details) {
  if (condition) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
    if (details) console.log(`      ${details}`);
  }
}

async function main() {
  // Logger
  const logger = AICursor.Logger.create('node-test');
  logger.info('logger works');
  logger.time('t');
  await new Promise((r) => setTimeout(r, 30));
  const elapsed = logger.timeEnd('t');
  check('Logger.time/timeEnd measures real elapsed time', typeof elapsed === 'number' && elapsed >= 20, `elapsed=${elapsed}`);

  const bufBefore = AICursor.Logger.getBuffer().length;
  logger.warn('test warning');
  check('Logger ring buffer grows on each call', AICursor.Logger.getBuffer().length === bufBefore + 1);

  // Storage
  await AICursor.Storage.set({ 'test:key': 'hello' });
  const readBack = await AICursor.Storage.get(['test:key']);
  check('Storage set/get round-trip', readBack['test:key'] === 'hello', JSON.stringify(readBack));

  await AICursor.Storage.remove(['test:key']);
  const afterRemove = await AICursor.Storage.get(['test:key']);
  check('Storage remove deletes the key', afterRemove['test:key'] === undefined);

  // PermissionStore full lifecycle
  const origin = 'https://example.com';
  const beforeGrant = await AICursor.PermissionStore.check(origin);
  await AICursor.PermissionStore.grant(origin);
  const afterGrant = await AICursor.PermissionStore.check(origin);
  await AICursor.PermissionStore.deny(origin);
  const afterDeny = await AICursor.PermissionStore.check(origin);
  await AICursor.PermissionStore.revoke(origin);
  const afterRevoke = await AICursor.PermissionStore.check(origin);
  check(
    'PermissionStore lifecycle: undefined -> true -> false -> undefined',
    beforeGrant === undefined && afterGrant === true && afterDeny === false && afterRevoke === undefined,
    `${beforeGrant}, ${afterGrant}, ${afterDeny}, ${afterRevoke}`
  );

  const granted1 = 'https://a.com';
  const granted2 = 'https://b.com';
  await AICursor.PermissionStore.grant(granted1);
  await AICursor.PermissionStore.grant(granted2);
  await AICursor.PermissionStore.deny('https://c.com');
  const list = await AICursor.PermissionStore.listGrantedOrigins();
  check(
    'PermissionStore.listGrantedOrigins returns only granted origins',
    list.includes(granted1) && list.includes(granted2) && !list.includes('https://c.com'),
    JSON.stringify(list)
  );

  // SensitiveActionGuard
  const guardCases = [
    ['Delete my account', true, 'destructive'],
    ['Buy now', true, 'financial'],
    ['Log Out', true, 'account'],
    ['Transfer funds', true, 'financial'],
    ['English', false, null],
    ['Search', false, null],
    ['', false, null],
  ];
  let guardOk = true;
  for (const [label, expectSensitive, expectCategory] of guardCases) {
    const actualSensitive = AICursor.SensitiveActionGuard.isSensitive(label);
    const actualCategory = AICursor.SensitiveActionGuard.classify(label);
    if (actualSensitive !== expectSensitive || actualCategory !== expectCategory) {
      guardOk = false;
      console.log(`      mismatch: "${label}" -> sensitive=${actualSensitive} category=${actualCategory} (expected ${expectSensitive}, ${expectCategory})`);
    }
  }
  check('SensitiveActionGuard classifies all test labels correctly', guardOk);

  // InputValidation
  const validationCases = [
    [{ type: 'RUN_GOAL', goal: 'change my picture' }, true],
    [{ type: 'RUN_GOAL', goal: '' }, false],
    [{ type: 'RUN_GOAL', goal: 'x'.repeat(400) }, false],
    [{ type: 'RUN_GOAL', goal: 42 }, false],
    [{ type: 'NOT_REAL' }, false],
    [{ type: 'STOP_GOAL' }, true],
    [{ type: 'RUN_ENSEMBLE', goal: 'x', elements: [] }, true],
    [{ type: 'GET_PROVIDER_STATUS' }, true],
    [null, false],
    [{}, false],
  ];
  let validationOk = true;
  for (const [msg, expectValid] of validationCases) {
    const result = AICursor.InputValidation.validateMessage(msg);
    if (result.valid !== expectValid) {
      validationOk = false;
      console.log(`      mismatch: ${JSON.stringify(msg)} -> valid=${result.valid} (${result.reason})`);
    }
  }
  check('InputValidation.validateMessage handles all schema cases', validationOk);

  const trusted = AICursor.InputValidation.isSenderTrusted({ id: 'test-extension-id' });
  const untrusted = AICursor.InputValidation.isSenderTrusted({ id: 'some-other-extension' });
  check('InputValidation.isSenderTrusted distinguishes self from others', trusted === true && untrusted === false);

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
