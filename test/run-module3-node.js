/**
 * test/run-module3-node.js
 *
 * Tests the real src/ai files. Network calls are the one thing we DO
 * stub here (global.fetch) - not because the module logic is faked, but
 * because hitting real Gemini/Groq/Ollama endpoints in an automated test
 * would require live API keys and a running local server, and would make
 * the test suite flaky and non-reproducible. Every assertion is about
 * how the real provider code builds requests and interprets responses,
 * not about the fake server itself.
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
  'ai/httpRetry.js',
  'ai/promptBuilder.js',
  'ai/providerInterface.js',
  'ai/providers/geminiProvider.js',
  'ai/providers/groqProvider.js',
  'ai/providers/ollamaProvider.js',
  'ai/keywordFallback.js',
  'ai/providerRegistry.js',
  'ai/ensemble.js',
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

const SAMPLE_ELEMENTS = [
  { index: 0, tag: 'button', label: 'More options' },
  { index: 1, tag: 'button', label: 'Settings' },
  { index: 2, tag: 'a', label: 'Home' },
];

/** Installs a scripted global.fetch for the duration of one test, then restores it. */
function withFetch(fetchImpl, testFn) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  return Promise.resolve(testFn()).finally(() => { global.fetch = original; });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function main() {
  // --- providerInterface -----------------------------------------------
  check(
    'providerInterface: validates a well-formed provider',
    AICursor.ProviderInterface.isValidProvider({ name: 'X', isConfigured: () => true, matchIntent: async () => null })
  );
  check(
    'providerInterface: rejects a malformed provider (missing matchIntent)',
    AICursor.ProviderInterface.isValidProvider({ name: 'X', isConfigured: () => true }) === false
  );
  check(
    'providerInterface: all three real providers satisfy the contract',
    AICursor.ProviderInterface.isValidProvider(AICursor.Providers.gemini) &&
    AICursor.ProviderInterface.isValidProvider(AICursor.Providers.groq) &&
    AICursor.ProviderInterface.isValidProvider(AICursor.Providers.ollama)
  );

  // --- promptBuilder.parseModelReply --------------------------------------
  check('parseModelReply: parses a valid numeric index', AICursor.PromptBuilder.parseModelReply('1', 3) === 1);
  check('parseModelReply: "none" maps to null', AICursor.PromptBuilder.parseModelReply('none', 3) === null);
  check('parseModelReply: "done" maps to DONE sentinel', AICursor.PromptBuilder.parseModelReply('done', 3) === 'DONE');
  check('parseModelReply: out-of-range index maps to null', AICursor.PromptBuilder.parseModelReply('99', 3) === null);
  check('parseModelReply: garbage text maps to null', AICursor.PromptBuilder.parseModelReply('sure thing!', 3) === null);

  // --- Gemini provider: isConfigured -------------------------------------
  check('gemini.isConfigured: true when key present', AICursor.Providers.gemini.isConfigured({ geminiApiKey: 'abc' }) === true);
  check('gemini.isConfigured: false when key missing', AICursor.Providers.gemini.isConfigured({}) === false);

  // --- Gemini provider: successful match ----------------------------------
  await withFetch(
    async (url) => {
      check('gemini request: URL includes the API key', url.includes('key=test-gemini-key'));
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: '1' }] } }] });
    },
    async () => {
      const result = await AICursor.Providers.gemini.matchIntent({
        goal: 'open settings', elements: SAMPLE_ELEMENTS, settings: { geminiApiKey: 'test-gemini-key' },
      });
      check('gemini.matchIntent: returns parsed index from a successful response', result === 1);
    }
  );

  // --- Gemini provider: invalid key ---------------------------------------
  await withFetch(
    async () => jsonResponse(403, { error: 'forbidden' }),
    async () => {
      let threw = null;
      try {
        await AICursor.Providers.gemini.matchIntent({ goal: 'x', elements: SAMPLE_ELEMENTS, settings: { geminiApiKey: 'bad' } });
      } catch (e) { threw = e.message; }
      check('gemini.matchIntent: throws a clear error on 403', threw && threw.includes('Invalid or unauthorized'), threw);
    }
  );

  // --- Gemini provider: retries on 429 then succeeds -----------------------
  await withFetch(
    (() => {
      let callCount = 0;
      return async () => {
        callCount++;
        if (callCount < 2) return jsonResponse(429, {});
        return jsonResponse(200, { candidates: [{ content: { parts: [{ text: '0' }] } }] });
      };
    })(),
    async () => {
      const result = await AICursor.Providers.gemini.matchIntent({
        goal: 'x', elements: SAMPLE_ELEMENTS, settings: { geminiApiKey: 'k' },
      });
      check('gemini.matchIntent: retries once on 429 and then succeeds', result === 0);
    }
  );

  // --- Groq provider: successful match + auth header ----------------------
  await withFetch(
    async (url, opts) => {
      check('groq request: sends Bearer auth header', opts.headers.Authorization === 'Bearer test-groq-key');
      return jsonResponse(200, { choices: [{ message: { content: 'done' } }] });
    },
    async () => {
      const result = await AICursor.Providers.groq.matchIntent({
        goal: 'x', elements: SAMPLE_ELEMENTS, settings: { groqApiKey: 'test-groq-key' },
      });
      check('groq.matchIntent: returns DONE sentinel correctly', result === 'DONE');
    }
  );

  // --- Ollama provider: network failure produces a helpful message --------
  await withFetch(
    async () => { throw new Error('ECONNREFUSED'); },
    async () => {
      let threw = null;
      try {
        await AICursor.Providers.ollama.matchIntent({ goal: 'x', elements: SAMPLE_ELEMENTS, settings: { ollamaEnabled: true } });
      } catch (e) { threw = e.message; }
      check(
        'ollama.matchIntent: connection failure gives an actionable error message',
        threw && threw.includes('Is Ollama running'),
        threw
      );
    }
  );

  // --- Ollama provider: isConfigured is a boolean flag, not a key check ---
  check('ollama.isConfigured: true only when explicitly enabled', AICursor.Providers.ollama.isConfigured({ ollamaEnabled: true }) === true);
  check('ollama.isConfigured: false by default', AICursor.Providers.ollama.isConfigured({}) === false);

  // --- keywordFallback ------------------------------------------------------
  const fallbackMatch1 = AICursor.KeywordFallback.match('open settings', SAMPLE_ELEMENTS);
  check('keywordFallback: matches literal word overlap', fallbackMatch1 === 1, `got index ${fallbackMatch1}`);
  const fallbackMatch2 = AICursor.KeywordFallback.match('completely unrelated goal xyz', SAMPLE_ELEMENTS);
  check('keywordFallback: returns null when nothing overlaps', fallbackMatch2 === null);

  // --- providerRegistry -------------------------------------------------
  const allProviders = AICursor.ProviderRegistry.getAllProviders();
  check('providerRegistry: lists all three registered providers', allProviders.length === 3, allProviders.map(p => p.name));

  const configuredOnlyGemini = AICursor.ProviderRegistry.getConfiguredProviders({ geminiApiKey: 'k' });
  check(
    'providerRegistry: filters to only configured providers',
    configuredOnlyGemini.length === 1 && configuredOnlyGemini[0].name === 'Gemini',
    configuredOnlyGemini.map(p => p.name)
  );

  const configuredNone = AICursor.ProviderRegistry.getConfiguredProviders({});
  check('providerRegistry: returns empty array when nothing configured', configuredNone.length === 0);

  // --- ensemble: zero providers -> fallback --------------------------------
  const ensembleNoProviders = await AICursor.Ensemble.runEnsemble({
    goal: 'open settings', elements: SAMPLE_ELEMENTS, providers: [], settings: {},
  });
  check(
    'ensemble: falls back to keyword match when no providers configured',
    ensembleNoProviders.index === 1 && ensembleNoProviders.note.includes('keyword'),
    JSON.stringify(ensembleNoProviders)
  );

  // --- ensemble: providers agree --------------------------------------------
  const agreeingProviders = [
    { name: 'FakeA', isConfigured: () => true, matchIntent: async () => 1 },
    { name: 'FakeB', isConfigured: () => true, matchIntent: async () => 1 },
  ];
  const ensembleAgree = await AICursor.Ensemble.runEnsemble({
    goal: 'x', elements: SAMPLE_ELEMENTS, providers: agreeingProviders, settings: {},
  });
  check(
    'ensemble: reports agreement when providers pick the same index',
    ensembleAgree.index === 1 && ensembleAgree.note.includes('agree'),
    JSON.stringify(ensembleAgree)
  );

  // --- ensemble: providers disagree, priority order wins --------------------
  const disagreeingProviders = [
    { name: 'Primary', isConfigured: () => true, matchIntent: async () => 1 },
    { name: 'Secondary', isConfigured: () => true, matchIntent: async () => 0 },
  ];
  const ensembleDisagree = await AICursor.Ensemble.runEnsemble({
    goal: 'x', elements: SAMPLE_ELEMENTS, providers: disagreeingProviders, settings: {},
  });
  check(
    'ensemble: uses first (priority) provider on disagreement, discloses the split',
    ensembleDisagree.index === 1 && ensembleDisagree.note.includes('Primary') && ensembleDisagree.note.includes('Secondary'),
    JSON.stringify(ensembleDisagree)
  );

  // --- ensemble: all providers fail -> fallback with error summary --------
  const failingProviders = [
    { name: 'Broken', isConfigured: () => true, matchIntent: async () => { throw new Error('boom'); } },
  ];
  const ensembleAllFail = await AICursor.Ensemble.runEnsemble({
    goal: 'open settings', elements: SAMPLE_ELEMENTS, providers: failingProviders, settings: {},
  });
  check(
    'ensemble: falls back to keyword match and reports the provider error when all providers fail',
    ensembleAllFail.index === 1 && ensembleAllFail.note.includes('boom'),
    JSON.stringify(ensembleAllFail)
  );

  // --- ensemble: all providers say DONE -----------------------------------
  const doneProviders = [
    { name: 'FakeA', isConfigured: () => true, matchIntent: async () => 'DONE' },
  ];
  const ensembleDone = await AICursor.Ensemble.runEnsemble({
    goal: 'x', elements: SAMPLE_ELEMENTS, providers: doneProviders, settings: {},
  });
  check(
    'ensemble: reports alreadyDone without moving cursor when providers agree the goal is met',
    ensembleDone.alreadyDone === true && ensembleDone.index === null,
    JSON.stringify(ensembleDone)
  );

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
