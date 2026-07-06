/**
 * src/ai/providers/geminiProvider.js
 *
 * Implements the shared provider interface (see providerInterface.js)
 * for Google's Gemini API. Uses the 2.5 Flash model specifically because
 * it has a genuine, ongoing free tier requiring no credit card - a hard
 * requirement of this project, not just a cost optimization.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('ai.provider.gemini')
    : { debug() {}, warn() {} };

  const MODEL = 'gemini-2.5-flash';
  const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  function isConfigured(settings) {
    return !!(settings && typeof settings.geminiApiKey === 'string' && settings.geminiApiKey.trim().length > 0);
  }

  async function matchIntent({ goal, elements, settings }) {
    const prompt = self.AICursor.PromptBuilder.buildIntentPrompt(goal, elements);

    const response = await self.AICursor.HttpRetry.fetchWithRetry(
      `${ENDPOINT}?key=${settings.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      },
      { isRetryable: (res) => res.status === 429 }
    );

    if (response.status === 400 || response.status === 403) {
      throw new Error('Invalid or unauthorized Gemini API key.');
    }
    if (response.status === 429) {
      throw new Error('Gemini free tier rate limit exceeded. Please wait a moment and try again.');
    }
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 150)}`);
    }

    const data = await response.json();
    const rawText = data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts
      && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

    const result = self.AICursor.PromptBuilder.parseModelReply(rawText, elements.length);
    logger.debug('matchIntent result', result);
    return result;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Providers = self.AICursor.Providers || {};
  self.AICursor.Providers.gemini = { name: 'Gemini', isConfigured, matchIntent };
})();
