/**
 * src/actions/elementActions.js
 *
 * Low-level action primitives that operate on a single DOM element.
 * Every action dispatches real, bubbling browser events in addition to
 * calling native methods where available, because many modern sites
 * (especially React/Vue apps) attach listeners that only fire on actual
 * event dispatch, not on programmatic property changes alone.
 *
 * Notable production detail - the "React value setter" problem:
 * React overrides the native <input>/<textarea> value setter so it can
 * track changes through its own synthetic event system. If you set
 * `el.value = "text"` directly, React never notices, because its
 * override is bypassed by direct property assignment from outside
 * React's own code. The fix is to call the ORIGINAL native setter
 * (retrieved via Object.getOwnPropertyDescriptor on the prototype)
 * before dispatching an `input` event - this makes React (and similar
 * frameworks) see the change as if a real user typed it.
 */
(function () {
  const logger = self.AICursor && self.AICursor.Logger
    ? self.AICursor.Logger.create('actions.element')
    : { debug() {}, warn() {}, error() {} };

  function assertElement(el, actionName) {
    if (!el) {
      throw new Error(`${actionName}: element is null or undefined.`);
    }
  }

  function centerOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function dispatchMouseEvent(el, type, extra) {
    const { x, y } = centerOf(el);
    const event = new MouseEvent(type, Object.assign({
      bubbles: true,
      cancelable: true,
      view: typeof window !== 'undefined' ? window : undefined,
      clientX: x,
      clientY: y,
      button: 0,
    }, extra || {}));
    el.dispatchEvent(event);
  }

  function click(el) {
    assertElement(el, 'click');
    dispatchMouseEvent(el, 'mousedown');
    dispatchMouseEvent(el, 'mouseup');
    // Also call the native .click() method: this is what makes default
    // browser behavior work correctly (link navigation, form submission,
    // checkbox toggling) in addition to the synthetic events above,
    // which is what makes JS event listeners fire.
    if (typeof el.click === 'function') el.click();
    logger.debug('click dispatched', el.tagName);
    return true;
  }

  function doubleClick(el) {
    assertElement(el, 'doubleClick');
    dispatchMouseEvent(el, 'mousedown');
    dispatchMouseEvent(el, 'mouseup');
    dispatchMouseEvent(el, 'click');
    dispatchMouseEvent(el, 'mousedown');
    dispatchMouseEvent(el, 'mouseup');
    dispatchMouseEvent(el, 'dblclick');
    logger.debug('doubleClick dispatched', el.tagName);
    return true;
  }

  function rightClick(el) {
    assertElement(el, 'rightClick');
    dispatchMouseEvent(el, 'mousedown', { button: 2 });
    dispatchMouseEvent(el, 'mouseup', { button: 2 });
    dispatchMouseEvent(el, 'contextmenu', { button: 2 });
    logger.debug('rightClick dispatched', el.tagName);
    return true;
  }

  function hover(el) {
    assertElement(el, 'hover');
    dispatchMouseEvent(el, 'mouseover');
    dispatchMouseEvent(el, 'mouseenter');
    dispatchMouseEvent(el, 'mousemove');
    logger.debug('hover dispatched', el.tagName);
    return true;
  }

  function scrollIntoView(el) {
    assertElement(el, 'scrollIntoView');
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return true;
  }

  function getNativeValueSetter(el) {
    const tag = el.tagName;
    let proto = null;
    if (tag === 'TEXTAREA' && typeof window !== 'undefined' && window.HTMLTextAreaElement) {
      proto = window.HTMLTextAreaElement.prototype;
    } else if (typeof window !== 'undefined' && window.HTMLInputElement) {
      proto = window.HTMLInputElement.prototype;
    }
    if (!proto) return null;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    return descriptor && descriptor.set ? descriptor.set : null;
  }

  function typeText(el, text) {
    assertElement(el, 'typeText');
    if (typeof text !== 'string') {
      throw new Error('typeText: text must be a string.');
    }
    if (typeof el.focus === 'function') el.focus();

    const nativeSetter = getNativeValueSetter(el);
    if (nativeSetter) {
      nativeSetter.call(el, text);
    } else {
      el.value = text;
    }

    // Dispatch both input and change so frameworks listening to either
    // (React typically listens to "input", plain forms often to "change")
    // pick up the new value.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    logger.debug('typeText dispatched', { tag: el.tagName, length: text.length });
    return true;
  }

  function pressKey(target, key, options) {
    const el = target || (typeof document !== 'undefined' ? document.activeElement : null) || (typeof document !== 'undefined' ? document.body : null);
    if (!el) throw new Error('pressKey: no element to dispatch to and no active element/body available.');

    const opts = Object.assign({ key, bubbles: true, cancelable: true }, options || {});
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    logger.debug('pressKey dispatched', key);
    return true;
  }

  /**
   * Selects an option in a native <select> element by matching either
   * its value attribute or its visible text. Returns false (rather than
   * throwing) if no option matches, since "the option doesn't exist" is
   * an expected, recoverable outcome the caller should handle, not an
   * exceptional one.
   */
  function selectOption(selectEl, matchValueOrText) {
    assertElement(selectEl, 'selectOption');
    if (selectEl.tagName !== 'SELECT') {
      throw new Error('selectOption: element is not a <select>.');
    }

    let matched = null;
    for (const option of selectEl.options) {
      if (option.value === matchValueOrText || option.text.trim() === matchValueOrText) {
        matched = option;
        break;
      }
    }
    if (!matched) {
      logger.warn('selectOption: no matching option found', matchValueOrText);
      return false;
    }

    selectEl.value = matched.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    logger.debug('selectOption applied', matched.value);
    return true;
  }

  self.AICursor = self.AICursor || {};
  self.AICursor.ElementActions = {
    click,
    doubleClick,
    rightClick,
    hover,
    scrollIntoView,
    typeText,
    pressKey,
    selectOption,
  };
})();
