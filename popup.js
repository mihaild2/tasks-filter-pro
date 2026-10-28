// sepInc / sepExc: text placed between values inside the parentheses
const FIELDS = [
  { key: 'category', title: 'Category', path: 'labels.category', sepInc: ' OR ', sepExc: ' AND ' },
  { key: 'brand', title: 'Brand', path: 'data.subject.brand', sepInc: '|', sepExc: '|' },
  { key: 'country', title: 'Country', path: 'labels.country', sepInc: ' OR ', sepExc: ' AND ' }, // AND matches your example; use ' OR ' to exclude "any of" the values
  { key: 'company', title: 'Company', path: 'labels.company', sepInc: ' OR ', sepExc: ' AND ' }
];
const STORE_KEY = 'bw_state';
const PRESETS_KEY = 'bw_presets';

const emptySel = () => Object.fromEntries(FIELDS.map((f) => [f.key, []]));
const normSel = (sel) => ({ ...emptySel(), ...(sel || {}) });
let state = { sel: emptySel(), created: 'off', query: '' };
let options = { category: [], country: [], company: [] };
let brands = { [ALL]: [] }; // { categoryId | '*': [brand names] }
let presets = [];
let tabId = null;
let connected = false;
const ui = {};

const ICON = {
  grip: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 5h2v2H9zM13 5h2v2h-2zM9 11h2v2H9zM13 11h2v2h-2zM9 17h2v2H9zM13 17h2v2h-2z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  save: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V7l-4-4zm-5 16a3 3 0 110-6 3 3 0 010 6zm3-10H6V5h9v4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
};

// ---------- query building ----------
const needsQuotes = (v) => /[\s"()\[\]{}:\\!^~*?\/&|]|^[-+]/.test(v);
const q = (v) => (needsQuotes(v) ? '"' + v.replace(/(["\\])/g, '\\$1') + '"' : v);

function group(path, items, sep, negate) {
  if (!items.length) return null;
  const vals = items.map((i) => q(i.value));
  const body = vals.length === 1 ? vals[0] : '(' + vals.join(sep) + ')';
  return (negate ? '!' : '') + path + ':' + body;
}

function buildQuery(s) {
  const parts = [];
  for (const { key, path, sepInc, sepExc } of FIELDS) {
    const sel = (s.sel && s.sel[key]) || [];
    parts.push(
      group(path, sel.filter((i) => !i.exclude), sepInc, false),
      group(path, sel.filter((i) => i.exclude), sepExc, true)
    );
  }
  if (s.created !== 'off') parts.push('data.subject.created_at:>now-' + s.created);
  return parts.filter(Boolean).join(' AND ');
}

// ---------- persistence + applying (popup is the only thing that writes to the page) ----------
function save() {
  state.query = buildQuery(state);
  chrome.storage.local.set({ [STORE_KEY]: state });
  ui.query.textContent = state.query || 'No filters';
  ui.query.classList.toggle('empty', !state.query);
  ui.saveToggle.disabled = !state.query;
  renderPresets(); // refresh "active" highlight
  applyToPage();
}

async function applyToPage() {
  if (tabId == null || !connected) return;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'apply', query: state.query });
    if (r?.ok) setStatus('ok', 'Connected · query applied to page');
    else setStatus('warn', 'Query String field not found on this page');
  } catch {
    setStatus('err', 'Can’t reach the page. Reload the Browswave tab and reopen.');
  }
}

const savePresets = () => chrome.storage.local.set({ [PRESETS_KEY]: presets });
const saveBrands = () => chrome.storage.local.set({ [BRANDS_KEY]: brands });

// ---------- brands ----------

// Brand suggestions: the shared list + the lists of the selected (included) categories;
// with no category selected, every list is offered.
function brandOptions() {
  const cats = state.sel.category.filter((i) => !i.exclude).map((i) => i.value);
  const lists = cats.length ? [brands[ALL], ...cats.map((c) => brands[c])] : Object.values(brands);
  const seen = new Map();
  for (const name of lists.flat()) if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  return [...seen.values()].sort(sortCI).map((n) => ({ value: n, label: n }));
}
const optionsFor = (key) => (key === 'brand' ? brandOptions() : options[key]);

// returns how many names were actually new
function addBrands(listKey, names) {
  const added = addNames(brands, listKey, names);
  if (added) { saveBrands(); updateCount('brand'); if (ddKey === 'brand') renderDropdown(); }
  return added;
}

// Read the brand column of the results table on the page and add what's found to a list:
// the single selected category when the page is showing our query, otherwise the shared list.
let scanTimer = null;
function scheduleScan(ms) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scanPage(false), ms);
}

async function scanPage(manual) {
  if (tabId == null || !connected) return null;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'scanBrands' });
    if (!r?.ok) return manual ? { found: 0, added: 0, noColumn: true } : null;
    const cats = state.sel.category.filter((i) => !i.exclude);
    const key = cats.length === 1 && r.query === state.query ? cats[0].value : ALL;
    const added = addBrands(key, r.brands);
    return { found: r.brands.length, added, key };
  } catch {
    return null;
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- suggestion popover ----------
let ddKey = null;
let ddActive = 0;
let ddShown = [];

function positionDropdown() {
  if (!ddKey) return;
  const input = ui[ddKey].input;
  const r = input.getBoundingClientRect();
  const dd = ui.dropdown;
  const gap = 4, max = 220, margin = 8;
  const below = window.innerHeight - r.bottom - margin - gap;
  const above = r.top - margin - gap;
  const useBelow = below >= 120 || below >= above;
  const space = Math.max(60, useBelow ? below : above);
  dd.style.left = r.left + 'px';
  dd.style.width = r.width + 'px';
  dd.style.maxHeight = Math.min(max, space) + 'px';
  if (useBelow) { dd.style.top = r.bottom + gap + 'px'; dd.style.bottom = 'auto'; }
  else { dd.style.bottom = window.innerHeight - r.top + gap + 'px'; dd.style.top = 'auto'; }
}

function openDropdown(key) {
  ddKey = key;
  renderDropdown();
}
function closeDropdown() {
  ddKey = null;
  ui.dropdown.hidden = true;
}

function renderDropdown() {
  if (!ddKey) return;
  const key = ddKey;
  const term = ui[key].input.value.trim().toLowerCase();
  const taken = new Set(state.sel[key].map((i) => i.value));
  const all = optionsFor(key);
  ddShown = all
    .filter((o) => !taken.has(o.value) && (!term || o.label.toLowerCase().includes(term)))
    .slice(0, 100);
  ddActive = Math.min(ddActive, Math.max(0, ddShown.length - 1));
  const dd = ui.dropdown;
  dd.innerHTML = '';
  if (!ddShown.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = all.length ? 'No matches' : 'No options loaded';
    dd.appendChild(li);
  } else {
    ddShown.forEach((o, i) => {
      const li = document.createElement('li');
      li.textContent = o.label;
      li.title = o.label;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); addChip(key, o); });
      li.addEventListener('mousemove', () => { if (ddActive !== i) { ddActive = i; highlight(false); } });
      dd.appendChild(li);
    });
  }
  dd.hidden = false;
  positionDropdown();
  highlight(false);
}

function highlight(scroll) {
  const dd = ui.dropdown;
  [...dd.children].forEach((li, i) => li.classList.toggle('active', i === ddActive));
  const el = dd.children[ddActive];
  if (scroll && el && ddShown.length) {
    // manual scroll so only the popover moves, never an ancestor
    if (el.offsetTop < dd.scrollTop) dd.scrollTop = el.offsetTop - 4;
    else if (el.offsetTop + el.offsetHeight > dd.scrollTop + dd.clientHeight)
      dd.scrollTop = el.offsetTop + el.offsetHeight - dd.clientHeight + 4;
  }
}

// ---------- fields ----------
function buildFields() {
  for (const f of FIELDS) {
    const sec = document.createElement('section');
    sec.className = 'field';
    sec.innerHTML = `
      <div class="field-head"><span>${f.title}</span><span class="head-actions"><span class="count"></span>${f.key === 'brand' ? '<button class="link addall" type="button">Add all</button>' : ''}</span></div>
      <input type="text" placeholder="Search ${f.title.toLowerCase()}…" autocomplete="off" spellcheck="false" />
      <div class="chips"></div>`;
    document.getElementById('fields').appendChild(sec);
    const input = sec.querySelector('input');
    ui[f.key] = { input, chips: sec.querySelector('.chips'), count: sec.querySelector('.count'), addAll: sec.querySelector('.addall') };
    if (ui[f.key].addAll) ui[f.key].addAll.addEventListener('click', addAllBrands);

    input.addEventListener('focus', () => { ddActive = 0; openDropdown(f.key); });
    input.addEventListener('input', () => { ddActive = 0; openDropdown(f.key); if (f.key === 'brand') updateAddAll(); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input && ddKey === f.key) closeDropdown(); }, 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { ddActive = Math.min(ddActive + 1, ddShown.length - 1); highlight(true); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { ddActive = Math.max(ddActive - 1, 0); highlight(true); e.preventDefault(); }
      else if (e.key === 'Enter' && ddShown[ddActive]) { addChip(f.key, ddShown[ddActive]); e.preventDefault(); }
      else if (e.key === 'Escape') { closeDropdown(); }
    });
  }
  ui.main.addEventListener('scroll', positionDropdown, { passive: true });
}

function addChip(key, opt) {
  if (state.sel[key].some((i) => i.value === opt.value)) return;
  state.sel[key].push({ value: opt.value, label: opt.label, exclude: false });
  ui[key].input.value = '';
  ddActive = 0;
  renderChips(key);
  renderDropdown();
  save();
}

function renderChips(key) {
  const u = ui[key];
  u.chips.innerHTML = '';
  state.sel[key].forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'chip' + (item.exclude ? ' ex' : '');
    chip.title = item.exclude ? 'Excluded – click to include' : 'Included – click to exclude';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = item.label;
    lbl.addEventListener('click', () => { item.exclude = !item.exclude; renderChips(key); save(); });
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', () => {
      state.sel[key] = state.sel[key].filter((i) => i !== item);
      renderChips(key);
      renderDropdown();
      save();
    });
    chip.append(lbl, x);
    u.chips.appendChild(chip);
  });
  updateCount(key);
  if (key === 'category') updateCount('brand'); // brand suggestions depend on the selected categories
  positionDropdown();
}

// brands that "Add all" would add: every suggestion matching what's typed in the Brand box, not already selected
function matchingBrands() {
  const term = ui.brand.input.value.trim().toLowerCase();
  const taken = new Set(state.sel.brand.map((i) => i.value));
  return brandOptions().filter((o) => !taken.has(o.value) && (!term || o.label.toLowerCase().includes(term)));
}

function updateAddAll() {
  const n = matchingBrands().length;
  const b = ui.brand.addAll;
  b.textContent = n ? `Add all (${n})` : 'Add all';
  b.disabled = !n;
}

function addAllBrands() {
  const list = matchingBrands();
  if (!list.length) return;
  list.forEach((o) => state.sel.brand.push({ value: o.value, label: o.label, exclude: false }));
  ui.brand.input.value = '';
  ddActive = 0;
  renderChips('brand');
  if (ddKey === 'brand') renderDropdown();
  save();
}

function updateCount(key) {
  const n = state.sel[key].length;
  const total = optionsFor(key).length;
  ui[key].count.textContent = (total ? total + ' options' : '') + (n ? (total ? ' · ' : '') + n + ' selected' : '');
  if (key === 'brand') updateAddAll();
}

function renderAll() {
  closeDropdown();
  FIELDS.forEach((f) => renderChips(f.key));
  document.querySelectorAll('#created button').forEach((b) => b.classList.toggle('on', b.dataset.val === state.created));
  ui.query.textContent = state.query || 'No filters';
  ui.query.classList.toggle('empty', !state.query);
  ui.saveToggle.disabled = !state.query;
  renderPresets();
}

// ---------- saved filters ----------
let editingId = null;
let confirmId = null;
let confirmTimer = null;
let dragId = null;

const isActive = (p) => !!state.query && buildQuery(p) === state.query;

function applyPreset(p) {
  state.sel = normSel(clone(p.sel));
  state.created = p.created;
  renderAll();
  save();
}

function commitRename(p, value) {
  const name = value.trim();
  if (editingId !== p.id) return;
  editingId = null;
  if (name) p.name = name;
  savePresets();
  renderPresets();
}

function btn(cls, html, title, onClick) {
  const b = document.createElement('button');
  b.className = 'ib ' + cls;
  b.innerHTML = html;
  b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function renderPresets() {
  const list = ui.presetList;
  list.innerHTML = '';
  ui.presetEmpty.hidden = presets.length > 0;

  presets.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'preset' + (isActive(p) ? ' active' : '');
    row.dataset.id = p.id;
    row.draggable = editingId !== p.id;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.title = 'Drag to reorder';
    grip.innerHTML = ICON.grip;
    row.appendChild(grip);

    if (editingId === p.id) {
      const inp = document.createElement('input');
      inp.className = 'rename';
      inp.value = p.name;
      inp.maxLength = 60;
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commitRename(p, inp.value);
        else if (e.key === 'Escape') { editingId = null; renderPresets(); }
      });
      inp.addEventListener('blur', () => commitRename(p, inp.value));
      row.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      const name = document.createElement('button');
      name.className = 'name';
      name.textContent = p.name;
      name.title = (buildQuery(p) || 'Empty filter') + '\n\nClick to apply';
      name.addEventListener('click', () => applyPreset(p));
      row.appendChild(name);
    }

    row.appendChild(btn('upd', ICON.save, 'Overwrite with current filters', () => {
      if (!state.query) return;
      p.sel = clone(state.sel);
      p.created = state.created;
      savePresets();
      renderPresets();
    }));
    row.appendChild(btn('ren', ICON.edit, 'Rename', () => { editingId = p.id; renderPresets(); }));

    if (confirmId === p.id) {
      const c = btn('confirm', 'Delete?', 'Click again to delete', () => {
        presets = presets.filter((x) => x.id !== p.id);
        confirmId = null;
        clearTimeout(confirmTimer);
        savePresets();
        renderPresets();
      });
      row.appendChild(c);
    } else {
      row.appendChild(btn('del', ICON.trash, 'Delete', () => {
        confirmId = p.id;
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => { confirmId = null; renderPresets(); }, 2500);
        renderPresets();
      }));
    }

    // drag & drop reordering
    row.addEventListener('dragstart', (e) => {
      dragId = p.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === p.id) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      clearDropMarks();
      row.classList.add(after ? 'drop-after' : 'drop-before');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === p.id) return;
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const moved = presets.find((x) => x.id === dragId);
      presets = presets.filter((x) => x.id !== dragId);
      const idx = presets.findIndex((x) => x.id === p.id);
      presets.splice(idx + (after ? 1 : 0), 0, moved);
      dragId = null;
      savePresets();
      renderPresets();
    });
    row.addEventListener('dragend', () => { dragId = null; clearDropMarks(); renderPresets(); });

    list.appendChild(row);
  });
}

function clearDropMarks() {
  ui.presetList.querySelectorAll('.drop-before,.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

function openSaveForm(open) {
  ui.saveForm.hidden = !open;
  if (open) { ui.saveName.value = ''; ui.saveName.focus(); }
}

function createPreset() {
  const name = ui.saveName.value.trim();
  if (!name || !state.query) { ui.saveName.focus(); return; }
  presets.unshift({ id: crypto.randomUUID(), name, sel: clone(state.sel), created: state.created });
  savePresets();
  openSaveForm(false);
  renderPresets();
}

// ---------- data ----------
function setStatus(cls, text) {
  ui.status.className = 'status ' + cls;
  ui.status.querySelector('span').textContent = text;
}

async function loadOptions() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let onSite = false;
  try { onSite = new URL(tab.url).hostname === 'app.browswave.com'; } catch { }
  if (!onSite) {
    setStatus('warn', 'Open app.browswave.com/i/tasks to load values and apply queries.');
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'fetchOptions' });
    tabId = tab.id;
    connected = true;
    const failed = Object.keys(res.errors || {});
    for (const f of FIELDS) if (res.data[f.key]) options[f.key] = res.data[f.key];
    chrome.storage.local.set({ bw_options: options });
    FIELDS.forEach((f) => renderChips(f.key));
    if (resolvePending(brands, options.category)) saveBrands();
    FIELDS.forEach((f) => renderChips(f.key));
    setStatus(failed.length ? 'warn' : 'ok',
      failed.length ? 'Some lists failed to load: ' + failed.join(', ') : 'Connected · values up to date');
    if (state.query) applyToPage(); // apply the saved selection once on open
  } catch {
    setStatus('err', 'Can’t reach the page. Reload the Browswave tab and reopen.');
  }
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', async () => {
  ui.status = document.getElementById('status');
  ui.query = document.getElementById('query');
  ui.main = document.getElementById('main');
  ui.dropdown = document.getElementById('dropdown');
  ui.presetList = document.getElementById('presetList');
  ui.presetEmpty = document.getElementById('presetEmpty');
  ui.saveToggle = document.getElementById('saveToggle');
  ui.saveForm = document.getElementById('saveForm');
  ui.saveName = document.getElementById('saveName');
  ui.gear = document.getElementById('gear');
  buildFields();

  const stored = await chrome.storage.local.get([STORE_KEY, 'bw_options', 'bw_theme', PRESETS_KEY, BRANDS_KEY, SEEDED_KEY]);
  if (!stored[SEEDED_KEY]) { // first run of this version: load the bundled brands.json once
    try { await seedBundled(); stored[BRANDS_KEY] = (await chrome.storage.local.get(BRANDS_KEY))[BRANDS_KEY]; } catch { }
  }
  if (stored[STORE_KEY]) state = { ...state, ...stored[STORE_KEY] };
  state.sel = normSel(state.sel);
  if (stored.bw_options) options = { ...options, ...stored.bw_options };
  if (Array.isArray(stored[PRESETS_KEY])) presets = stored[PRESETS_KEY];
  if (stored[BRANDS_KEY] && typeof stored[BRANDS_KEY] === 'object') brands = { [ALL]: [], ...stored[BRANDS_KEY] };
  if (resolvePending(brands, options.category)) saveBrands();

  const theme = stored.bw_theme || 'auto';
  document.documentElement.dataset.theme = theme;
  const sel = document.getElementById('theme');
  sel.value = theme;
  sel.addEventListener('change', () => {
    document.documentElement.dataset.theme = sel.value;
    chrome.storage.local.set({ bw_theme: sel.value });
  });

  renderAll();

  document.getElementById('created').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.created = b.dataset.val;
    renderAll();
    save();
  });
  document.getElementById('clear').addEventListener('click', () => {
    state.sel = emptySel();
    state.created = 'off';
    renderAll();
    save();
  });
  document.getElementById('copy').addEventListener('click', async (e) => {
    if (!state.query) return;
    await navigator.clipboard.writeText(state.query);
    e.target.textContent = 'Copied';
    setTimeout(() => (e.target.textContent = 'Copy'), 1200);
  });

  ui.saveToggle.addEventListener('click', () => openSaveForm(ui.saveForm.hidden));
  document.getElementById('saveOk').addEventListener('click', createPreset);
  document.getElementById('saveCancel').addEventListener('click', () => openSaveForm(false));
  ui.saveName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPreset();
    else if (e.key === 'Escape') openSaveForm(false);
  });

  ui.gear.addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  loadOptions();
});
