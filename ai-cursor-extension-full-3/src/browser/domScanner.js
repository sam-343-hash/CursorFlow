/**
 * src/browser/domScanner.js
 *
 * Finds interactive elements on the current page (buttons, links, inputs,
 * ARIA-role elements) and turns them into a serializable, numbered list
 * that the AI planner can reason about, while keeping the real DOM
 * element references privately available for the actions module to act
 * on later.
 *
 * Performance design (per project requirements: caching, MutationObserver,
 * lazy scanning, low CPU usage):
 * - A full scan walks the DOM once and is then CACHED.
 * - A MutationObserver watches for changes (new elements, attribute
 *   changes like style/class/hidden/disabled) and marks the cache dirty
 *   instead of re-scanning immediately. The next scan() call after a
 *   mutation does a fresh pass; scans with no intervening DOM change
 *   reuse the cached result instantly.
 * - This means a page with no dynamic content only gets scanned once no
 *   matter how many times the AI asks "what's on screen," while a page
 *   that's actively re-rendering (SPA) still always sees fresh data.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('browser.domScanner')
    : { debug() {}, warn() {} };

  const guard = self.AICursor && self.AICursor.SensitiveActionGuard;

  const INTERACTIVE_SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[onclick]', '[contenteditable="true"]',
  ].join(', ');

  const MAX_ELEMENTS = 150;

  let cachedResult = null; // { elements: [...serializable], domRefs: [...] }
  let isDirty = true;
  let observer = null;

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = (typeof window !== 'undefined' && window.getComputedStyle)
      ? window.getComputedStyle(el)
      : {};
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0' &&
      !el.disabled &&
      !el.hasAttribute('aria-hidden')
    );
  }

  function getElementLabel(el) {
    // Priority order matters: explicit accessibility labels are the most
    // reliable signal of intent, followed by visible text, then value/alt
    // as last resorts for icon-only elements (e.g. an image-only button).
    const fromAria = el.getAttribute('aria-label');
    if (fromAria) return clean(fromAria);

    const fromPlaceholder = el.getAttribute('placeholder');
    if (fromPlaceholder) return clean(fromPlaceholder);

    const fromTitle = el.getAttribute('title');
    if (fromTitle) return clean(fromTitle);

    const text = el.innerText || el.textContent;
    if (text && text.trim()) return clean(text);

    if (el.value) return clean(el.value);

    // Icon-only buttons often wrap an <img alt="..."> - fall back to that.
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && img.getAttribute('alt')) return clean(img.getAttribute('alt'));

    return '';
  }

  function clean(text) {
    return text.trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  function scan(root) {
    const scanRoot = root || (typeof document !== 'undefined' ? document : null);
    if (!scanRoot) {
      logger.warn('scan() called with no document available');
      return { elements: [], domRefs: [] };
    }

    if (!isDirty && cachedResult) {
      logger.debug('scan: cache hit, skipping DOM walk');
      return cachedResult;
    }

    logger.time('domScan');
    const nodeList = scanRoot.querySelectorAll(INTERACTIVE_SELECTOR);
    const seenLabels = new Set();
    const elements = [];
    const domRefs = [];

    for (const el of nodeList) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (!isVisible(el)) continue;

      const label = getElementLabel(el);
      if (!label) continue;

      const dedupeKey = `${el.tagName}:${label.toLowerCase()}`;
      if (seenLabels.has(dedupeKey)) continue;
      seenLabels.add(dedupeKey);

      const sensitive = guard ? guard.isSensitive(label) : false;
      const category = guard ? guard.classify(label) : null;

      elements.push({
        index: elements.length,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        label,
        sensitive,
        category,
      });
      domRefs.push(el);
    }

    cachedResult = { elements, domRefs };
    isDirty = false;
    logger.timeEnd('domScan');
    logger.debug(`scan complete: ${elements.length} interactive elements found`);
    return cachedResult;
  }

  function invalidate() {
    isDirty = true;
  }

  function startObserving(root) {
    const target = root || (typeof document !== 'undefined' ? document.body : null);
    if (!target || observer) return;
    if (typeof MutationObserver === 'undefined') {
      logger.warn('MutationObserver unavailable in this environment - caching disabled');
      return;
    }
    observer = new MutationObserver(() => invalidate());
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'disabled', 'aria-hidden'],
    });
    logger.debug('MutationObserver attached');
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
      logger.debug('MutationObserver detached');
    }
  }

  function getElementByIndex(index) {
    if (!cachedResult) return null;
    return cachedResult.domRefs[index] || null;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.DomScanner = {
    scan,
    invalidate,
    startObserving,
    stopObserving,
    getElementByIndex,
    isVisible,
    getElementLabel,
  };
})();
