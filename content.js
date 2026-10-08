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
    if (input.value === value) return;
    nativeSetter.call(input, value); // bypass React's value tracker
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function applyQuery(query) {
    for (let i = 0; i < 6; i++) {
      if (onTasksPage()) {
        const input = findInput();
        if (input) {
          setInputValue(input, query);
          return { ok: true };
        }
      }
      await sleep(250);
    }
    return { ok: false };
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
  });
})();
