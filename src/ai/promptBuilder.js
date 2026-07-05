/**
 * src/ai/promptBuilder.js
 *
 * The prompt that turns a user's goal + a list of on-screen elements into
 * an AI decision. Kept in exactly one place so every provider reasons
 * identically - if the prompt needs tuning later (e.g. better handling
 * of a specific site pattern), it changes once for all providers instead
 * of drifting out of sync between Gemini/Groq/Ollama versions.
 *
 * Core design choice: this explicitly instructs the model to reason
 * about INTENT, not literal keyword overlap - e.g. recognizing that a
 * "..." overflow menu is often the correct first step toward a goal like
 * "change my profile picture," even though the goal text and the menu's
 * label share no words at all. This is what separates real AI matching
 * from the free keyword fallback, which can only do literal overlap.
 */
(function () {
  function buildIntentPrompt(goal, elements) {
    const elementListText = elements
      .map((el) => `${el.index}: [${el.tag}${el.type ? ' type=' + el.type : ''}] "${el.label}"`)
      .join('\n');

    return `You are a browser navigation assistant. You are NOT doing keyword matching - you are reasoning about how to actually accomplish a goal, the way an experienced user of this kind of app would.

The user's GOAL is: "${goal}"

Here is a numbered list of clickable elements currently visible on the page:
${elementListText}

Important reasoning rules:
- The right next element to click often does NOT contain any of the user's literal words. For example, to reach profile/account settings, the correct first click is frequently a "..." / "More" / "\u22ee" / "\u2261" (menu) icon, an avatar image, a gear/settings icon, or a hamburger menu - even though the user never said "menu" or "settings."
- Think one step at a time: what is the SINGLE next click that moves toward the goal from THIS current screen? It does not have to complete the goal by itself.
- If the goal already looks accomplished by what's currently visible (e.g. the exact settings panel the user wants is already open on screen), reply with exactly: done
- If truly nothing on this screen is a reasonable step toward the goal, reply with exactly: none
- Otherwise reply with ONLY the number of the single best next element to click.

Reply with ONLY one of: a number, the word done, or the word none. No explanation, no punctuation.`;
  }

  /**
   * Parses a raw model reply into one of: a valid element index (number),
   * the string 'DONE', or null (meaning "none"/unparseable/out of range).
   * Shared across providers so index-bounds-checking and the done/none
   * sentinels are interpreted identically everywhere.
   */
  function parseModelReply(rawText, elementCount) {
    if (!rawText || typeof rawText !== 'string') return null;
    const trimmed = rawText.trim();
    const lower = trimmed.toLowerCase();

    if (lower === 'none') return null;
    if (lower === 'done') return 'DONE';

    const parsed = parseInt(trimmed, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed >= elementCount) return null;
    return parsed;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.PromptBuilder = { buildIntentPrompt, parseModelReply };
})();
