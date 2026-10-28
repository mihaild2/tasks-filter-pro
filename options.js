// Tasks Filter Pro – settings page (opens in a tab): brand lists, import / export, page scan.
let brands = { [ALL]: [] };
let categories = []; // [{ value, label }] – cached by the popup when it connects to the page
let current = ALL;
const $ = (id) => document.getElementById(id);

const labelOf = (key) =>
  key === ALL ? 'All categories (shared)'
  : key.startsWith(PENDING) ? key.slice(PENDING.length) + ' (not matched yet)'
  : categories.find((c) => c.value === key)?.label || 'Category ' + key;

// read-modify-write so edits made by the popup in the meantime aren't lost
async function mutate(fn) {
  const st = await chrome.storage.local.get(BRANDS_KEY);
  const b = { [ALL]: [], ...(st[BRANDS_KEY] || {}) };
  const result = fn(b);
  await chrome.storage.local.set({ [BRANDS_KEY]: b });
  brands = b;
  render();
  return result;
}

async function load() {
  const st = await chrome.storage.local.get([BRANDS_KEY, 'bw_options', 'bw_theme']);
  document.documentElement.dataset.theme = st.bw_theme || 'auto';
  categories = st.bw_options?.category || [];
  brands = { [ALL]: [], ...(st[BRANDS_KEY] || {}) };
  if (resolvePending(brands, categories)) await chrome.storage.local.set({ [BRANDS_KEY]: brands });
  render();
}

function listKeys() {
  const cats = [...categories].sort((a, b) => sortCI(a.label, b.label)).map((c) => c.value);
  const known = new Set([ALL, ...cats]);
  const extra = Object.keys(brands).filter((k) => !known.has(k)).sort((a, b) => sortCI(labelOf(a), labelOf(b)));
  return [ALL, ...cats, ...extra];
}

function render() {
  const keys = listKeys();
  if (!keys.includes(current)) current = ALL;

  const nav = $('lists');
  nav.innerHTML = '';
  for (const k of keys) {
    const b = document.createElement('button');
    b.className = k === current ? 'on' : '';
    b.title = labelOf(k);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = labelOf(k);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = (brands[k] || []).length;
    b.append(nm, n);
    b.addEventListener('click', () => { current = k; $('filter').value = ''; $('clearList').classList.remove('confirm'); $('clearList').textContent = 'Remove all'; render(); });
    nav.appendChild(b);
  }
  $('catNote').hidden = categories.length > 0;

  const list = brands[current] || [];
  const term = $('filter').value.trim().toLowerCase();
  const shown = term ? list.filter((n) => n.toLowerCase().includes(term)) : list;
  $('listTitle').textContent = labelOf(current);
  $('listCount').textContent = list.length ? (term ? `${shown.length} of ${list.length}` : `${list.length} brands`) : '';
  $('empty').hidden = list.length > 0;
  $('clearList').disabled = !list.length;

  const chips = $('chips');
  chips.innerHTML = '';
  for (const name of shown) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = name;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
    x.addEventListener('click', () => mutate((b) => { b[current] = (b[current] || []).filter((n) => n !== name); }));
    chip.append(lbl, x);
    chips.appendChild(chip);
  }
}

const splitNames = (t) => t.split(/[\n,;|]+/);

async function addFromInput() {
  const names = splitNames($('add').value);
  $('add').value = '';
  await mutate((b) => addNames(b, current, names));
}

// ---- remove all (two clicks) ----
let confirmTimer = null;
$('clearList').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm'); btn.textContent = 'Click again to confirm';
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = 'Remove all'; }, 2500);
    return;
  }
  clearTimeout(confirmTimer);
  btn.classList.remove('confirm'); btn.textContent = 'Remove all';
  await mutate((b) => { b[current] = []; });
});

$('addBtn').addEventListener('click', addFromInput);
$('add').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addFromInput(); } });
$('add').addEventListener('paste', () => setTimeout(() => { if (/[\n,;|]/.test($('add').value)) addFromInput(); }, 0));
$('filter').addEventListener('input', render);

// ---- export / import ----
const note = (id, text) => { $(id).textContent = text; };

$('export').addEventListener('click', () => {
  const data = toFile(brands, categories);
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tasks-filter-pro-brands.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  const total = data.lists.reduce((n, l) => n + l.brands.length, 0);
  note('ioNote', `Exported ${total} brands in ${data.lists.length} lists.`);
});

async function importText(text, plainTarget) {
  const parsed = parseBrandFile(text, categories);
  if (parsed) {
    const added = await mutate((b) => mergeParsed(b, parsed));
    const lists = new Set(parsed.map((p) => p.key)).size;
    return `Imported ${added} new brands (${lists} lists in the file).`;
  }
  // not JSON: one brand per line / comma separated, into the selected list
  const added = await mutate((b) => addNames(b, plainTarget, splitNames(text)));
  return `Imported ${added} new brands into “${labelOf(plainTarget)}”.`;
}

$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  try { note('ioNote', await importText(await f.text(), current)); }
  catch { note('ioNote', 'Couldn’t read that file.'); }
});

$('defaults').addEventListener('click', async () => {
  const text = await fetchBundledText();
  if (!text) return note('ioNote', 'brands.json wasn’t found in the extension.');
  note('ioNote', (await importText(text, ALL)).replace('Imported', 'Loaded from brands.json:'));
});

// ---- scan an open Browswave tab ----
$('scan').addEventListener('click', async () => {
  note('scanNote', 'Scanning…');
  try {
    const tabs = await chrome.tabs.query({ url: 'https://app.browswave.com/*' });
    const tab = tabs.find((t) => t.active && t.url.includes('/i/tasks')) || tabs.find((t) => t.url.includes('/i/tasks')) || tabs[0];
    if (!tab) return note('scanNote', 'Open app.browswave.com/i/tasks in a tab first.');
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'scanBrands' });
    if (!r?.ok) return note('scanNote', 'No “data.subject.brand” column found on that page.');
    const added = await mutate((b) => addNames(b, current, r.brands));
    note('scanNote', `Found ${r.brands.length}, ${added} new → “${labelOf(current)}”.`);
  } catch {
    note('scanNote', 'Can’t reach the page. Reload the Browswave tab and try again.');
  }
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch[BRANDS_KEY] || ch.bw_options || ch.bw_theme)) load();
});
load();
