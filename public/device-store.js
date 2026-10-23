// Everything personal lives here, on this device: your Netflix history, swipes and settings.
// The server never keeps it. It is sent along with a request only so the server can work out
// recommendations, and is forgotten as soon as the answer is sent back.
const KEY = 'swipeflick.v1';

const blank = () => ({
  v: 1,
  onboarded: false,
  settings: { includeWatched: false, types: 'both', minRating: 0, region: null },
  swipes: [], // [{id, action: 'like'|'super'|'nope', at}]
  history: null, // {source, importedAt, entries, groups: [{name, kind, views, firstWatched, lastWatched, titleId}]}
});

let mem = null;
let persisted = true;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const base = blank();
      return { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
    }
  } catch {
    persisted = false;
  }
  return blank();
}

export const data = () => (mem ||= read());

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data()));
    persisted = true;
  } catch {
    persisted = false; // private window or blocked storage: the app still works until it is closed
  }
}

export const isPersistent = () => persisted;

/** Replace everything (used when moving data from another device, or on reset). */
export function replaceAll(next) {
  const base = blank();
  mem = { ...base, ...next, settings: { ...base.settings, ...next?.settings } };
  save();
}

export const exportJson = () => JSON.stringify(data());

export function resetSwipes() {
  data().swipes = [];
  save();
}

export function resetEverything() {
  const region = data().settings.region;
  replaceAll({ settings: { region } });
}

/** Records a swipe (a title has one swipe at a time) and returns it. */
export function addSwipe(id, action) {
  const d = data();
  d.swipes = d.swipes.filter((s) => s.id !== id);
  const swipe = { id, action, at: new Date().toISOString() };
  d.swipes.push(swipe);
  save();
  return swipe;
}

export function removeSwipe(id) {
  const d = data();
  d.swipes = d.swipes.filter((s) => s.id !== id);
  save();
}

export function popSwipe() {
  const d = data();
  const last = d.swipes.pop();
  save();
  return last || null;
}

export function counts() {
  const s = data().swipes;
  const n = (a) => s.filter((x) => x.action === a).length;
  return { likes: n('like'), supers: n('super'), nopes: n('nope') };
}

/** What the server needs to answer one request. It is not kept on the server. */
export function requestBody(extra = {}) {
  const d = data();
  const { includeWatched, types, minRating, region } = d.settings;
  return {
    region,
    settings: { includeWatched, types, minRating },
    swipes: d.swipes.map(({ id, action, at }) => ({ id, action, at })),
    history: d.history && {
      source: d.history.source, importedAt: d.history.importedAt, entries: d.history.entries,
      groups: d.history.groups.map(({ name, kind, views, firstWatched, lastWatched, titleId }) => ({ name, kind, views, firstWatched, lastWatched, titleId })),
    },
    ...extra,
  };
}
