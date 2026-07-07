/**
 * src/ai/providers/ollamaProvider.js
 *
 * Implements the shared provider interface for Ollama - a free, local
 * AI runtime the user installs on their own machine (ollama.com). This
 * is the "genuinely $0 forever, works offline" option in the provider
 * lineup: no API key, no account, no rate limit imposed by a company,
 * because the model runs entirely on the user's own hardware.
 *
 * Setup requirements (real, worth documenting honestly rather than
 * hiding): the user must have Ollama installed and running locally, and
 * must allow this extension's origin to reach it, since Ollama's server
 * rejects requests from origins it doesn't recognize by default. This is
 * done by setting the OLLAMA_ORIGINS environment variable before starting
 * Ollama - covered in the setup docs, not something this code can do for
 * the user.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('ai.provider.ollama')
    : { debug() {}, warn() {} };

  const DEFAULT_BASE_URL = 'http://localhost:11434';
  const DEFAULT_MODEL = 'llama3.2';

  function isConfigured(settings) {
    return !!(settings && settings.ollamaEnabled);
  }

  async function matchIntent({ goal, elements, settings }) {
    const baseUrl = (settings && settings.ollamaUrl) || DEFAULT_BASE_URL;
    const model = (settings && settings.ollamaModel) || DEFAULT_MODEL;
    const prompt = self.AICursor.PromptBuilder.buildIntentPrompt(goal, elements);

    let response;
    try {
      response = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
    } catch (networkErr) {
      throw new Error(
        `Could not reach local Ollama server at ${baseUrl}. Is Ollama running? ` +
        `(${(networkErr && networkErr.message) || networkErr})`
      );
    }

    if (response.status === 404) {
      throw new Error(`Ollama model "${model}" not found. Run: ollama pull ${model}`);
    }
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama error ${response.status}: ${errText.slice(0, 150)}`);
    }

    const data = await response.json();
    const rawText = data && data.response;

    const result = self.AICursor.PromptBuilder.parseModelReply(rawText, elements.length);
    logger.debug('matchIntent result', result);
    return result;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Providers = self.AICursor.Providers || {};
  self.AICursor.Providers.ollama = { name: 'Ollama (local)', isConfigured, matchIntent };
})();
