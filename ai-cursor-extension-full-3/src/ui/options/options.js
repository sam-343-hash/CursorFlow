/**
 * src/ui/options/options.js
 *
 * The options page is a full extension page (not a content script), so
 * it can use chrome.storage and the AICursor.Storage/PermissionStore
 * modules directly - no message relay needed, unlike the popup talking
 * to a webpage's content script.
 */

const geminiApiKeyInput = document.getElementById('geminiApiKey');
const saveGeminiBtn = document.getElementById('saveGemini');
const geminiStatusEl = document.getElementById('geminiStatus');

const groqApiKeyInput = document.getElementById('groqApiKey');
const saveGroqBtn = document.getElementById('saveGroq');
const groqStatusEl = document.getElementById('groqStatus');

const ollamaEnabledInput = document.getElementById('ollamaEnabled');
const ollamaUrlInput = document.getElementById('ollamaUrl');
const ollamaModelInput = document.getElementById('ollamaModel');
const saveOllamaBtn = document.getElementById('saveOllama');
const ollamaStatusEl = document.getElementById('ollamaStatus');

const debugModeInput = document.getElementById('debugMode');
const grantedSitesListEl = document.getElementById('grantedSitesList');

function flashStatus(el, text) {
  el.textContent = text;
  setTimeout(() => { el.textContent = ''; }, 2000);
}

async function loadExistingSettings() {
  const settings = await AICursor.Storage.get([
    'geminiApiKey', 'groqApiKey', 'ollamaEnabled', 'ollamaUrl', 'ollamaModel', 'aicursor_debug_mode',
  ]);

  if (settings.geminiApiKey) geminiApiKeyInput.value = settings.geminiApiKey;
  if (settings.groqApiKey) groqApiKeyInput.value = settings.groqApiKey;
  ollamaEnabledInput.checked = !!settings.ollamaEnabled;
  if (settings.ollamaUrl) ollamaUrlInput.value = settings.ollamaUrl;
  if (settings.ollamaModel) ollamaModelInput.value = settings.ollamaModel;
  debugModeInput.checked = !!settings.aicursor_debug_mode;
}

saveGeminiBtn.addEventListener('click', async () => {
  await AICursor.Storage.set({ geminiApiKey: geminiApiKeyInput.value.trim() });
  flashStatus(geminiStatusEl, 'Saved.');
});

saveGroqBtn.addEventListener('click', async () => {
  await AICursor.Storage.set({ groqApiKey: groqApiKeyInput.value.trim() });
  flashStatus(groqStatusEl, 'Saved.');
});

saveOllamaBtn.addEventListener('click', async () => {
  await AICursor.Storage.set({
    ollamaEnabled: ollamaEnabledInput.checked,
    ollamaUrl: ollamaUrlInput.value.trim(),
    ollamaModel: ollamaModelInput.value.trim(),
  });
  flashStatus(ollamaStatusEl, 'Saved.');
});

debugModeInput.addEventListener('change', () => {
  AICursor.Logger.setDebugMode(debugModeInput.checked);
});

async function renderGrantedSites() {
  const origins = await AICursor.PermissionStore.listGrantedOrigins();
  if (origins.length === 0) {
    grantedSitesListEl.innerHTML = '<div class="empty">No sites enabled yet.</div>';
    return;
  }

  grantedSitesListEl.innerHTML = '';
  for (const origin of origins) {
    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `<span>${origin}</span><button class="revoke-btn" data-origin="${origin}">Revoke</button>`;
    grantedSitesListEl.appendChild(row);
  }

  grantedSitesListEl.querySelectorAll('.revoke-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await AICursor.PermissionStore.revoke(btn.dataset.origin);
      renderGrantedSites();
    });
  });
}

loadExistingSettings();
renderGrantedSites();
