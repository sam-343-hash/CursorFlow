/**
 * src/ui/voice/voice.js
 *
 * Runs in its own window (opened by popup.js), not inside the popup
 * itself, because Chrome closes extension popups the instant they lose
 * focus - which would kill an in-progress microphone permission prompt
 * or an active listening session. Uses the browser's built-in
 * SpeechRecognition (free, no API key).
 */

const micBtn = document.getElementById('micBtn');
const transcriptEl = document.getElementById('transcript');
const statusEl = document.getElementById('status');

const params = new URLSearchParams(window.location.search);
const targetTabId = parseInt(params.get('tabId'), 10);

const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionClass) {
  transcriptEl.textContent = 'Voice recognition is not supported in this browser.';
  micBtn.disabled = true;
  statusEl.textContent = 'Use the text box in the popup instead.';
} else {
  const recognition = new SpeechRecognitionClass();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;

  let isListening = false;

  micBtn.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
    } catch (e) {
      statusEl.textContent = 'Could not start microphone: ' + e.message;
    }
  });

  recognition.onstart = () => {
    isListening = true;
    micBtn.classList.add('listening');
    transcriptEl.textContent = 'Listening...';
    statusEl.textContent = '';
  };

  recognition.onresult = (event) => {
    let text = '';
    for (let i = 0; i < event.results.length; i++) {
      text += event.results[i][0].transcript;
    }
    transcriptEl.textContent = `"${text}"`;

    if (event.results[event.results.length - 1].isFinal) {
      runVoiceGoal(text.trim());
    }
  };

  recognition.onerror = (event) => {
    isListening = false;
    micBtn.classList.remove('listening');
    if (event.error === 'not-allowed') {
      statusEl.textContent = 'Microphone permission was blocked. Click the lock icon in the address bar to allow it, then try again.';
    } else if (event.error === 'no-speech') {
      statusEl.textContent = 'No speech detected. Click the mic and try again.';
    } else {
      statusEl.textContent = 'Voice error: ' + event.error;
    }
  };

  recognition.onend = () => {
    isListening = false;
    micBtn.classList.remove('listening');
  };
}

function runVoiceGoal(goal) {
  if (!goal) {
    statusEl.textContent = 'Did not catch that. Try again.';
    return;
  }
  if (!targetTabId || Number.isNaN(targetTabId)) {
    statusEl.textContent = 'No target page found. Reopen this from the extension popup.';
    return;
  }

  statusEl.textContent = 'Thinking...';

  chrome.runtime.sendMessage(
    { type: 'RELAY_TO_CONTENT', tabId: targetTabId, payload: { type: 'RUN_GOAL', goal } },
    (result) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = 'Error contacting the extension. Close this window and try again.';
        return;
      }
      if (result && result.error) {
        statusEl.textContent = result.error;
        statusEl.style.color = '#ff6b6b';
        return;
      }
      statusEl.textContent = `${result.status}: ${result.reason || 'Check the page - the cursor may have moved.'} You can close this window.`;
      statusEl.style.color = result.status === 'done' ? '#4ade80' : '#e2a34a';
    }
  );
}
