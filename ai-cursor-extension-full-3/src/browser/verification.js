/**
 * src/browser/verification.js
 *
 * Calling `.click()` on an element and having it not throw an error is
 * NOT the same as the click having actually done anything. A disabled
 * overlay, a mis-targeted element, or a site that swallows synthetic
 * events can all produce a "successful" call that changed nothing.
 *
 * This module takes a snapshot of observable page state before an
 * action, and compares it to a snapshot after, to give the action queue
 * real evidence of whether something happened - which is what allows
 * the retry logic in actionQueue.js to be meaningful instead of just
 * retrying blindly.
 *
 * This is a heuristic, not a guarantee - stated plainly rather than
 * oversold. A silent successful action (e.g. a background save with no
 * visible change) can look identical to a no-op. Combined with the
 * planner's own re-scan-and-reason step later, this is good enough
 * signal for retry decisions without needing a full accessibility-tree
 * diff engine.
 */
(function () {
  function isElementVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    const style = (typeof window !== 'undefined' && window.getComputedStyle)
      ? window.getComputedStyle(el)
      : {};
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function snapshot(target) {
    const doc = typeof document !== 'undefined' ? document : null;
    return {
      url: typeof location !== 'undefined' ? location.href : '',
      bodyChildCount: doc && doc.body ? doc.body.children.length : 0,
      targetInDom: target && doc ? doc.body.contains(target) : false,
      targetVisible: target ? isElementVisible(target) : false,
      activeElementTag: doc && doc.activeElement ? doc.activeElement.tagName : null,
    };
  }

  /**
   * Compares a "before" snapshot (taken prior to an action) against the
   * current page state, and returns whether the action appears to have
   * had a real effect, plus a human-readable reason for logging/UI.
   *
   * IMPORTANT: focus changing is deliberately NOT treated as sufficient
   * evidence of a real effect. Clicking almost any element moves
   * document.activeElement, whether or not anything meaningful actually
   * happened - treating that alone as "verified" produced a real bug in
   * practice: an element that does nothing useful (e.g. a nav link that
   * only steals focus) was reported as a successful step every single
   * time, defeating loop protection, because the failure-based loop
   * guard never saw a failure to count. Focus change is still recorded
   * for diagnostic purposes but no longer counts on its own.
   */
  function verify(beforeSnapshot, target) {
    const after = snapshot(target);

    const urlChanged = after.url !== beforeSnapshot.url;
    const domChanged = after.bodyChildCount !== beforeSnapshot.bodyChildCount;
    const targetRemoved = beforeSnapshot.targetInDom && !after.targetInDom;
    const targetHidden = beforeSnapshot.targetVisible && !after.targetVisible;
    const focusChanged = beforeSnapshot.activeElementTag !== after.activeElementTag;

    const verified = urlChanged || domChanged || targetRemoved || targetHidden;

    let reason = 'No observable change detected after the action.';
    if (urlChanged) reason = 'Page navigated to a new URL.';
    else if (targetRemoved) reason = 'Target element was removed from the page.';
    else if (targetHidden) reason = 'Target element became hidden.';
    else if (domChanged) reason = 'Page DOM structure changed.';
    else if (focusChanged) reason = 'Only keyboard focus moved - not treated as sufficient evidence of progress.';

    return { verified, reason, before: beforeSnapshot, after };
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Verification = { snapshot, verify, isElementVisible };
})();
