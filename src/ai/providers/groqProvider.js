/**
 * src/ai/providers/groqProvider.js
 *
 * Implements the shared provider interface for Groq's free-tier API,
 * which serves open models (Llama 3.3) at very high inference speed.
 * Groq's endpoint is OpenAI-compatible in request/response shape, which
 * is why this file's structure differs slightly from geminiProvider.js
 * despite doing the same conceptual job.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('ai.provider.groq')
    : { debug() {}, warn() {} };

  const MODEL = 'llama-3.3-70b-versatile';
  const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

  function isConfigured(settings) {
    return !!(settings && typeof settings.groqApiKey === 'string' && settings.groqApiKey.trim().length > 0);
  }

  async function matchIntent({ goal, elements, settings }) {
    const prompt = self.AICursor.PromptBuilder.buildIntentPrompt(goal, elements);

    const response = await self.AICursor.HttpRetry.fetchWithRetry(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.groqApiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
      },
      { isRetryable: (res) => res.status === 429 }
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid or unauthorized Groq API key.');
    }
    if (response.status === 429) {
      throw new Error('Groq free tier rate limit exceeded. Please wait a moment and try again.');
    }
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 150)}`);
    }

    const data = await response.json();
    const rawText = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;

    const result = self.AICursor.PromptBuilder.parseModelReply(rawText, elements.length);
    logger.debug('matchIntent result', result);
    return result;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Providers = self.AICursor.Providers || {};
  self.AICursor.Providers.groq = { name: 'Groq', isConfigured, matchIntent };
})();
