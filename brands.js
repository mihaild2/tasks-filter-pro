// Shared brand-list helpers (popup, options page and background service worker).
// Storage shape (chrome.storage.local "bw_brands"): { "*": [names], "<categoryId>": [names], "pending:<name>": [names] }
// "*" is shared by every category; "pending:" keys come from files that name a category that isn't known yet
// and are moved to the real category id as soon as the category list is available.
const BRANDS_KEY = 'bw_brands';
const SEEDED_KEY = 'bw_brands_seeded';
const ALL = '*';
const PENDING = 'pending:';
const FILE_FORMAT = 'tasks-filter-pro-brands';

const sortCI = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Adds names to brands[key] (case-insensitive de-dupe, sorted). Returns the number of new names.
function addNames(brands, key, names) {
  const list = brands[key] || [];
  const have = new Set(list.map((n) => n.toLowerCase()));
  let added = 0;
  for (const raw of names) {
    const n = cleanName(raw);
    if (!n || have.has(n.toLowerCase())) continue;
    have.add(n.toLowerCase());
    list.push(n);
    added++;
  }
  if (added) { list.sort(sortCI); brands[key] = list; }
  return added;
}

const findCategory = (categories, raw) =>
  categories.find((c) => c.value === raw) ||
  categories.find((c) => c.label.toLowerCase() === String(raw).toLowerCase());

function keyFor(raw, categories) {
  if (raw === ALL) return ALL;
  const c = findCategory(categories, raw);
  return c ? c.value : PENDING + raw;
}

// Move "pending:" lists to their category once it is known. Returns true if anything changed.
function resolvePending(brands, categories) {
  let changed = false;
  for (const k of Object.keys(brands)) {
    if (!k.startsWith(PENDING)) continue;
    const c = findCategory(categories, k.slice(PENDING.length));
    if (!c) continue;
    addNames(brands, c.value, brands[k]);
    delete brands[k];
    changed = true;
  }
  return changed;
}

// Accepts: { lists: [{ id?, name?, brands: [] }] }  |  { "<id or category name>": [] }  |  [ ...names ] (shared list).
// Returns [{ key, names }] or null if the text isn't valid JSON of one of those shapes.
function parseBrandFile(text, categories) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const out = [];
  const push = (key, names) => { if (Array.isArray(names)) out.push({ key, names }); };
  if (Array.isArray(data)) push(ALL, data);
  else if (data && Array.isArray(data.lists)) {
    for (const l of data.lists) {
      if (!l || !Array.isArray(l.brands)) continue;
      const id = l.id != null ? String(l.id) : '';
      let key;
      if (id === ALL || (id && (!categories.length || categories.some((c) => c.value === id)))) key = id;
      else if (l.name) key = keyFor(String(l.name), categories);
      else key = id || ALL;
      push(key, l.brands);
    }
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) if (k !== 'format' && k !== 'version') push(keyFor(k, categories), v);
  } else return null;
  return out;
}

function mergeParsed(brands, parsed) {
  let added = 0;
  for (const { key, names } of parsed) added += addNames(brands, key, names);
  return added;
}

function toFile(brands, categories) {
  const label = (k) => (k === ALL ? 'All categories' : k.startsWith(PENDING) ? k.slice(PENDING.length) : categories.find((c) => c.value === k)?.label || k);
  const keys = Object.keys(brands).filter((k) => brands[k].length)
    .sort((a, b) => (a === ALL ? -1 : b === ALL ? 1 : sortCI(label(a), label(b))));
  return {
    format: FILE_FORMAT,
    version: 1,
    lists: keys.map((k) => {
      if (k === ALL) return { id: ALL, name: label(k), brands: brands[k] };
      if (k.startsWith(PENDING)) return { name: label(k), brands: brands[k] };
      const named = categories.some((c) => c.value === k);
      return named ? { id: k, name: label(k), brands: brands[k] } : { id: k, brands: brands[k] };
    })
  };
}

// ---- bundled defaults (brands.json shipped inside the extension) ----
async function fetchBundledText() {
  try {
    const r = await fetch(chrome.runtime.getURL('brands.json'));
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

// Merge brands.json into storage once (flag bw_brands_seeded). Called on install and, as a fallback, by the popup.
async function seedBundled() {
  const st = await chrome.storage.local.get([BRANDS_KEY, SEEDED_KEY, 'bw_options']);
  if (st[SEEDED_KEY]) return 0;
  const text = await fetchBundledText();
  if (!text) return 0;
  const brands = { [ALL]: [], ...(st[BRANDS_KEY] || {}) };
  const added = mergeParsed(brands, parseBrandFile(text, st.bw_options?.category || []) || []);
  await chrome.storage.local.set({ [BRANDS_KEY]: brands, [SEEDED_KEY]: true });
  return added;
}
