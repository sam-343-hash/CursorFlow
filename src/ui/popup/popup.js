/**
 * src/ui/popup/popup.js
 *
 * The popup never talks to the content script directly - every message
 * goes through background.js's RELAY_TO_CONTENT, which self-heals by
 * injecting the content script if it's missing from the tab (see
 * background.js's sendToContentScript for why this matters).
 */

const goalInput = document.getElementById('goalInput');
const runBtn = document.getElementById('runBtn');
const stopBtn = document.getElementById('stopBtn');
const allowBtn = document.getElementById('allowBtn');
const disableBtn = document.getElementById('disableBtn');
const voiceBtn = document.getElementById('voiceBtn');
const optionsBtn = document.getElementById('optionsBtn');
const statusEl = document.getElementById('status');
const progressLogEl = document.getElementById('progressLog');
const providerStatusEl = document.getElementById('providerStatus');

function checkProviderStatus() {
  chrome.runtime.sendMessage({ type: 'GET_PROVIDER_STATUS' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      providerStatusEl.textContent = 'Could not check AI provider status.';
      return;
    }
    const names = response.providerNames || [];
    if (names.length === 0) {
      providerStatusEl.className = 'provider-status status-fallback-only';
      providerStatusEl.innerHTML = '⚠️ No AI provider configured - using basic keyword matching only, which cannot understand intent (e.g. menus/icons with no matching text). <a id="setupProviderLink">Add a free key</a> for real reasoning.';
      const link = document.getElementById('setupProviderLink');
      if (link) link.addEventListener('click', () => chrome.runtime.openOptionsPage());
    } else {
      providerStatusEl.className = 'provider-status status-ai-active';
      providerStatusEl.textContent = `⚡ AI active: ${names.join(' + ')}`;
    }
  });
}
checkProviderStatus();

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ? `status-${kind}` : '';
}

function appendProgress(phase, detail) {
  const line = document.createElement('div');
  line.textContent = `[${phase}] ${detail || ''}`;
  progressLogEl.appendChild(line);
  progressLogEl.scrollTop = progressLogEl.scrollHeight;
}

function relayToContent(tabId, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', tabId, payload }, (result) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(result || {});
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Live progress updates broadcast by the content script while a goal is running.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'PLANNER_PROGRESS') {
    appendProgress(message.phase, message.detail);
  }
});

optionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

allowBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  setStatus('Enabling...');
  const result = await relayToContent(tab.id, { type: 'GRANT_PERMISSION' });
  setStatus(result.error || 'AI Cursor enabled on this site.', result.error ? 'error' : 'success');
});

disableBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  const result = await relayToContent(tab.id, { type: 'DISABLE_PERMISSION' });
  setStatus(result.error || 'AI Cursor disabled on this site.', result.error ? 'error' : undefined);
});

function describeResult(result) {
  switch (result.status) {
    case 'done':
      return { text: `Done! ${result.reason || ''}`, kind: 'success' };
    case 'awaiting_confirmation':
      return { text: result.reason, kind: 'warn' };
    case 'stopped':
      return { text: 'Stopped.', kind: undefined };
    case 'max_steps_reached':
      return { text: result.reason, kind: 'warn' };
    case 'loop_detected':
      return { text: result.reason, kind: 'error' };
    default:
      return { text: result.reason || 'Something went wrong.', kind: 'error' };
  }
}

runBtn.addEventListener('click', async () => {
  const goal = goalInput.value.trim();
  if (!goal) {
    setStatus('Type a goal first, e.g. "change my profile picture".', 'error');
    return;
  }

  progressLogEl.innerHTML = '';
  setStatus('Starting...');
  runBtn.disabled = true;
  runBtn.style.display = 'none';
  stopBtn.style.display = 'block';

  const tab = await getActiveTab();
  const result = await relayToContent(tab.id, { type: 'RUN_GOAL', goal });

  runBtn.disabled = false;
  runBtn.style.display = 'block';
  stopBtn.style.display = 'none';

  if (result.error) {
    setStatus(result.error, 'error');
    return;
  }
  const { text, kind } = describeResult(result);
  setStatus(text, kind);
});

stopBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  await relayToContent(tab.id, { type: 'STOP_GOAL' });
  setStatus('Stopping...');
});

voiceBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  chrome.windows.create({
    url: chrome.runtime.getURL(`src/ui/voice/voice.html?tabId=${tab.id}`),
    type: 'popup',
    width: 360,
    height: 420,
  });
  window.close();
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runBtn.click();
});
