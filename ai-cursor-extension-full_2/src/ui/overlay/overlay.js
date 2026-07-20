/**
 * src/ui/overlay/overlay.js
 *
 * All visible, on-page UI the extension draws directly onto the user's
 * webpage: the first-visit permission banner, a small "active" badge,
 * and the animated cursor (with a glass-morphism label bubble) that
 * glides to whatever element the Planner is currently acting on or
 * awaiting confirmation for.
 *
 * Movement design: rather than teleporting straight to the target, the
 * cursor starts its animation from the user's OWN real mouse position
 * (tracked via a lightweight mousemove listener) and glides to the
 * destination - the same way watching someone else move their mouse
 * looks natural, versus a UI element just appearing somewhere. This is
 * done by briefly disabling the CSS transition, snapping to the start
 * position with zero animation, forcing a layout reflow, then
 * re-enabling the transition and setting the real destination - a
 * standard technique for "animate FROM a specific point" with pure CSS
 * transitions (as opposed to keyframe animations, which can't easily
 * take a dynamic start point).
 *
 * This module only manipulates the DOM for its OWN injected elements
 * (identified by fixed IDs/classes) - it never assumes anything about
 * the host page's structure, so it's safe to load on any site.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('ui.overlay')
    : { debug() {}, warn() {} };

  // --- Track the user's real mouse position, so the AI cursor can glide
  // from wherever their actual mouse last was, rather than an arbitrary
  // fixed start point. Passive + lightweight (just two numbers updated
  // on mousemove) - negligible overhead even on a busy page.
  let lastMouseX = window.innerWidth / 2;
  let lastMouseY = window.innerHeight / 3;
  let hasRealMousePosition = false;

  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    hasRealMousePosition = true;
  }, { passive: true });

  function showPermissionBanner(onAllow, onDeny) {
    if (document.getElementById('aicursor-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'aicursor-banner';
    banner.innerHTML = `
      <div class="aicursor-banner-text">
        <strong>AI Cursor Assistant</strong> wants to help you on this site by reading page content and moving a visual cursor.
      </div>
      <div class="aicursor-banner-actions">
        <button class="aicursor-btn aicursor-btn-allow">Allow</button>
        <button class="aicursor-btn aicursor-btn-deny">Deny</button>
      </div>
    `;
    document.body.appendChild(banner);

    banner.querySelector('.aicursor-btn-allow').addEventListener('click', () => {
      banner.remove();
      if (onAllow) onAllow();
    });
    banner.querySelector('.aicursor-btn-deny').addEventListener('click', () => {
      banner.remove();
      if (onDeny) onDeny();
    });
  }

  function removePermissionBanner() {
    const banner = document.getElementById('aicursor-banner');
    if (banner) banner.remove();
  }

  function showActiveBadge() {
    if (document.getElementById('aicursor-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'aicursor-badge';
    badge.innerHTML = `<span class="aicursor-badge-dot"></span>AI Cursor active`;
    document.body.appendChild(badge);
  }

  function removeActiveBadge() {
    const badge = document.getElementById('aicursor-badge');
    if (badge) badge.remove();
  }

  function ensureCursorEl() {
    let cursor = document.getElementById('aicursor-pointer');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = 'aicursor-pointer';
      // A real pointer-arrow shape (like an OS mouse cursor), not a
      // straight up-arrow - this is what makes it read as "a cursor
      // moving," not "a marker appearing."
      cursor.innerHTML = `
        <svg class="aicursor-pointer-arrow" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="aicursor-arrow-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#c084fc"/>
              <stop offset="100%" stop-color="#7c3aed"/>
            </linearGradient>
          </defs>
          <path d="M4 2 L4 20 L8.5 16.2 L11.2 22.4 L14 21.2 L11.3 15 L17.5 15 Z"
                stroke="rgba(0,0,0,0.35)" stroke-width="1" stroke-linejoin="round"/>
        </svg>
        <div class="aicursor-pointer-label">
          <span class="aicursor-label-dot"></span>
          <span class="aicursor-label-text"></span>
        </div>
      `;
      document.body.appendChild(cursor);
    }
    return cursor;
  }

  function clearHighlights() {
    document.querySelectorAll('.aicursor-highlight, .aicursor-highlight-sensitive').forEach((el) => {
      el.classList.remove('aicursor-highlight', 'aicursor-highlight-sensitive');
    });
  }

  function spawnClickRipple(x, y, sensitive) {
    const ripple = document.createElement('div');
    ripple.className = 'aicursor-click-ripple' + (sensitive ? ' aicursor-click-ripple-sensitive' : '');
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    document.body.appendChild(ripple);
    // The ripple's own CSS animation runs once and stops ("forwards"),
    // but the element itself needs removing afterward or these would
    // silently accumulate in the DOM over a long session.
    setTimeout(() => ripple.remove(), 650);
  }

  /**
   * Points the visible cursor at a DOM element, animating a glide from
   * the user's last known real mouse position to the target, with a
   * glass-morphism label bubble describing what was found. `sensitive`
   * changes the color scheme so a user can visually tell "this needs
   * your manual click" apart from a normal auto-clicked step. A ripple
   * fires once the cursor arrives, as a clear "action happened here"
   * confirmation distinct from the ambient glow.
   */
  function pointAt(element, labelText, sensitive) {
    if (!element || typeof element.scrollIntoView !== 'function') return;

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Wait for the scroll to settle before measuring the target's final
    // position - measuring mid-scroll would animate to a stale location.
    setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const cursor = ensureCursorEl();

      // --- Step 1: snap instantly to the start point (no transition) ---
      const startX = hasRealMousePosition ? lastMouseX : window.innerWidth / 2;
      const startY = hasRealMousePosition ? lastMouseY : window.innerHeight / 3;

      cursor.style.transition = 'none';
      cursor.style.display = 'block';
      cursor.style.left = startX + 'px';
      cursor.style.top = startY + 'px';
      cursor.classList.add('aicursor-gliding'); // pauses the idle float during movement

      // Force a layout reflow so the browser "commits" the start
      // position before we change it again - without this, the browser
      // would batch both position changes together and skip the
      // animation entirely.
      // eslint-disable-next-line no-unused-expressions
      cursor.offsetHeight;

      // --- Step 2: re-enable the transition and set the real target ---
      const targetX = rect.left + rect.width / 2;
      const targetY = rect.top;
      cursor.style.transition = '';
      cursor.style.left = targetX + 'px';
      cursor.style.top = targetY + 'px';
      cursor.classList.toggle('aicursor-pointer-sensitive', !!sensitive);

      const labelTextEl = cursor.querySelector('.aicursor-label-text');
      if (labelTextEl) {
        const text = labelText || '';
        labelTextEl.textContent = text.length > 42 ? text.slice(0, 42) + '...' : text;
      }

      clearHighlights();
      element.classList.add(sensitive ? 'aicursor-highlight-sensitive' : 'aicursor-highlight');

      // Once the glide's CSS transition finishes (matches overlay.css's
      // 0.55s), resume the idle float and fire the arrival ripple.
      setTimeout(() => {
        cursor.classList.remove('aicursor-gliding');
        spawnClickRipple(targetX, targetY, sensitive);
      }, 560);

      logger.debug('Cursor gliding to target', { from: [startX, startY], to: [targetX, targetY], label: labelText });
    }, 350);
  }

  function hideCursor() {
    const cursor = document.getElementById('aicursor-pointer');
    if (cursor) cursor.style.display = 'none';
    clearHighlights();
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.Overlay = {
    showPermissionBanner,
    removePermissionBanner,
    showActiveBadge,
    removeActiveBadge,
    pointAt,
    hideCursor,
    clearHighlights,
    spawnClickRipple,
  };
})();
