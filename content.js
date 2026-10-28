// Tasks Filter Pro – content script (runs on app.browswave.com).
// It never touches the page on its own: it only reacts to messages sent by the open popup.
(() => {
  const HEADERS = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'bw-dev-app-environment': 'production',
    'bw-dev-es-environment': 'production',
    'content-type': 'application/json; charset=utf-8'
  };

  const onTasksPage = () => location.pathname.startsWith('/i/tasks');

  const findInput = () =>
    [...document.querySelectorAll('form label')]
      .find((x) => x.textContent.trim() === 'Query String')
      ?.parentElement.querySelector('input') || null;

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function setInputValue(input, value) {
    if (input.value === value) return false;
    nativeSetter.call(input, value); // bypass React's value tracker
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- close the suggestion list (ul[role=listbox]) the page opens when the input changes ----
  // Programmatic input events make the page's combobox open its popup, but it only closes on blur
  // (which never happens because the user never touched the field). So we simulate that blur.
  const suggestionsOpen = (input) => {
    if (input.getAttribute('aria-expanded') === 'true') return true;
    const id = input.getAttribute('aria-controls');
    return !!(id && document.getElementById(id));
  };

  const blurInput = (input) => {
    if (document.activeElement === input) input.blur();
    // React 16 listens to "blur" (captured), React 17+ to "focusout" – send both
    input.dispatchEvent(new FocusEvent('blur', { bubbles: false, relatedTarget: null }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  };

  async function dismissSuggestions(input) {
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 0 : 150);
      if (document.hasFocus() && document.activeElement === input) return; // the user is typing in the page itself
      if (i > 0 && !suggestionsOpen(input)) return;
      blurInput(input);
      if (i >= 2) {
        // last resort: Escape closes an open combobox popup (it does not clear the value while it is open)
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      }
    }
  }

  async function applyQuery(query) {
    for (let i = 0; i < 6; i++) {
      if (onTasksPage()) {
        const input = findInput();
        if (input) {
          if (setInputValue(input, query)) dismissSuggestions(input); // fire and forget
          return { ok: true };
        }
      }
      await sleep(250);
    }
    return { ok: false };
  }

  // ---- brands currently visible in the results table ----
  function scanBrands() {
    const th = [...document.querySelectorAll('table thead th')].find((x) => x.id === 'data.subject.brand');
    if (!th) return { ok: false, reason: 'no-column' };
    const idx = th.cellIndex;
    const seen = new Set();
    const brands = [];
    (th.closest('table') || document).querySelectorAll('tbody tr').forEach((tr) => {
      const text = (tr.cells[idx]?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || /^[-–—]+$/.test(text)) return;
      const k = text.toLowerCase();
      if (!seen.has(k)) { seen.add(k); brands.push(text); }
    });
    return { ok: true, brands, query: findInput()?.value ?? '' };
  }

  // ---- option loading (same-origin, so session cookies are sent) ----
  const post = async (path, body) => {
    const res = await fetch(location.origin + path, {
      method: 'POST',
      headers: HEADERS,
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  };

  const filterBody = (attribute) => ({
    filter: { status: ['NEW', 'IN_PROGRESS'], updated_at: { gte: 'now-1y', lte: 'now' } },
    attribute,
    fromHistory: false
  });

  const asOption = (v) => {
    const s = typeof v === 'object' && v !== null ? v.value ?? v.name ?? v.title ?? JSON.stringify(v) : String(v);
    return { value: s, label: s };
  };

  async function fetchOptions() {
    const data = {};
    const errors = {};
    await Promise.all([
      post('/iui-api/nats', { command: 'categories.filter', payload: {}, timeout: 30000 })
        .then((j) => {
          data.category = (j?.data?.items || []).map((i) => ({
            value: String(i.id),
            label: String(i.title ?? i.id)
          }));
        })
        .catch((e) => (errors.category = e.message)),
      ...['country', 'company'].map((attr) =>
        post('/iui-api/tasks/filter-options', filterBody(attr))
          .then((j) => {
            data[attr] = (j?.data || []).map(asOption);
          })
          .catch((e) => (errors[attr] = e.message))
      )
    ]);
    return { data, errors };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'fetchOptions') {
      fetchOptions().then(sendResponse);
      return true;
    }
    if (msg?.type === 'apply') {
      applyQuery(String(msg.query ?? '')).then(sendResponse);
      return true;
    }
    if (msg?.type === 'scanBrands') {
      sendResponse(scanBrands());
    }
  });
})();
