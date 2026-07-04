# AI Cursor Assistant

Tell it a goal in plain English or by voice - *"change my profile picture"* -
and it scans the page, reasons about the right next click using AI
(not just keyword matching), shows you exactly where with an animated
arrow, and can click it for you when safe to do so.

**Cost: $0.** Runs on free tiers of Gemini and Groq (no credit card), or
entirely offline/local via Ollama, with a zero-setup local keyword
fallback if you configure no provider at all.

---

## Install it (2 minutes)

1. Download/unzip this project folder somewhere on your computer.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select this project's root folder (the one containing `manifest.json`).
6. You should see "AI Cursor Assistant" appear as an installed extension, with no errors.

That's it - no build step, no `npm install`, nothing else required. Pin the extension icon (puzzle-piece icon in Chrome's toolbar → pin) for easy access.

### First use on any site
1. Visit any website.
2. Click the extension icon → click **"Enable on this site"** (or click Allow on the banner that appears on the page).
3. Type a goal (or click 🎤 and speak it) → click **Run**.
4. Watch the arrow find and point at the right element.

### Adding a free AI provider (optional, recommended)
Click the ⚙ icon in the popup (or right-click the extension icon → Options) to open Settings:
- **Gemini**: free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- **Groq**: free key at [console.groq.com](https://console.groq.com)
- **Ollama**: install [ollama.com](https://ollama.com) locally, run it, then enable it in Settings - fully offline, no key needed

Works with zero providers configured too (local keyword-matching fallback), but a real AI provider is what enables reasoning like "a '...' menu is the right first click for 'change my profile picture'" instead of literal word matching.

---

## Architecture

```
src/
  utils/         logger.js, storage.js               - shared foundation
  security/      permissions.js, sensitiveActionGuard.js, inputValidation.js
  browser/       domScanner.js, verification.js       - DOM-dependent, content-script only
  actions/       elementActions.js, actionQueue.js    - DOM-dependent, content-script only
  ai/            httpRetry.js, promptBuilder.js, providerInterface.js,
                 providers/{gemini,groq,ollama}Provider.js,
                 keywordFallback.js, providerRegistry.js, ensemble.js
  planner/       plannerStates.js, loopGuard.js, planner.js
  content/       contentBootstrap.js                  - content script entry point
  background/    background.js                        - service worker entry point
  ui/
    overlay/     overlay.js, overlay.css               - on-page arrow cursor, banner, badge
    popup/       popup.html, popup.js, popup.css
    options/     options.html, options.js, options.css
    voice/       voice.html, voice.js
icons/           icon16.png, icon48.png, icon128.png
test/            automated test suites (see below)
manifest.json
```

### The execution loop
```
User goal (typed or spoken)
        |
        v
popup/voice -> background.js (RELAY_TO_CONTENT, self-healing injection)
        |
        v
content script's Planner:
   SCAN (domScanner) -> THINK (AI ensemble, via background) -> ACT (click)
   -> VERIFY -> re-SCAN -> repeat, until:
     - AI reports the goal is already visible (DONE)
     - the matched element is sensitive (AWAITING_CONFIRMATION - never auto-clicked)
     - no reasonable next action exists (FAILED)
     - max steps reached (MAX_STEPS_REACHED)
     - the same element keeps failing (LOOP_DETECTED)
     - the same element keeps failing back-to-back regardless of which one (FAILED, consecutive-failure guard)
```

### Why the AI call goes through the background worker
The Planner and all DOM-dependent modules (`domScanner`, `actionQueue`,
`elementActions`, `verification`) run entirely inside the **content
script**, because only the content script has access to the actual
page's DOM. The Planner's `runEnsemble` function, however, is wired to
send a message to the **background service worker**, which is the only
place API keys are ever read from storage and used. This keeps API keys
out of the page-adjacent content script context entirely.

### Why background.js self-heals content script injection
Chrome only auto-injects content scripts into **new** page loads, not
tabs that were already open when the extension was installed or
reloaded. Without handling this, every message to a tab opened before a
fresh install would fail with a confusing "could not establish
connection" error. `background.js`'s `sendToContentScript()` detects
this and automatically injects the content script into the tab before
retrying - this was a real, previously-encountered bug in an earlier
version of this project, now fixed structurally rather than by asking
the user to remember to refresh tabs.

---

## Safety design (non-negotiable, not configurable)

- **Per-origin permission**: nothing runs on a site until you explicitly grant it there. A denial is remembered so you're not re-prompted every visit.
- **Sensitive-action guard**: the Planner will never auto-click anything classified as destructive, financial, account-related, or a broadcast/communication action (delete, pay, checkout, log out, unsubscribe, etc. - see `sensitiveActionGuard.js` for the full list). It points the cursor there and stops, requiring your manual click. This cannot be disabled via settings.
- **Loop protection**: a hard cap on total steps, on consecutive failures, and on repeated failures against the same element, so a misbehaving page can't cause an infinite loop.
- **API keys never leave your machine** except to their own provider's official API endpoint - Gemini's key only ever goes to `generativelanguage.googleapis.com`, Groq's only to `api.groq.com`.

## Known limitations

- Doesn't see inside `<iframe>` elements yet.
- No vision/OCR yet - fully DOM-based, so canvas-only UIs (e.g. Figma-style apps) with no DOM labels won't be detected. Planned for a future module.
- Free API tiers have real rate limits - fine for personal use.
- Very long multi-step tasks (well beyond the default 8-step cap) may run into Chrome's service worker idle-suspension behavior mid-task; this hasn't been an issue in testing at the default step count, but is a known area to watch if `maxSteps` is raised significantly.
- OpenAI/ChatGPT is intentionally not included as a provider: unlike Gemini, Groq, and Ollama, it has no genuine ongoing free tier (only small expiring trial credits), so it doesn't fit this project's zero-cost goal.

---

## Developer guide

No build step - everything is plain JavaScript using a shared
`self.AICursor` namespace pattern (not ES modules), so it works as
classic `<script>` tags, `importScripts()`, and content script entries
identically, with zero bundler/webpack/vite required.

### Running the automated tests
Each module has its own Node-based test suite (real source files, no
mocking of the logic under test - only external calls like `fetch` are
stubbed):

```bash
node test/run-module1-node.js      # utils + security            (9 tests)
node test/run-module2-node.js      # browser + actions            (16 tests)
node test/run-module3-node.js      # ai (providers + ensemble)     (29 tests)
node test/run-module4-node.js      # planner                      (24 tests)
node test/validate-manifest.js     # manifest/file-existence/syntax (5 checks)
```

All should print `RESULT: N passed, 0 failed`.

### Adding a new AI provider
1. Create `src/ai/providers/yourProvider.js` implementing the shared interface: `{ name, isConfigured(settings), matchIntent({goal, elements, settings}) }`.
2. Register it in `src/ai/providerRegistry.js`'s `getAllProviders()` list (position determines tiebreak priority when providers disagree).
3. Load the new file in `src/background/background.js`'s `importScripts(...)` call.
4. Add its settings fields to the options page if it needs an API key or config.

Nothing else needs to change - the ensemble, the planner, and the UI are all provider-count-agnostic by design.
