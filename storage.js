/*
 * Storage for «Остаток».
 * - Always keeps a copy in localStorage (instant start, works offline).
 * - Inside Telegram it also syncs to Telegram CloudStorage, so the data
 *   follows the user to any phone where they open the bot.
 *
 * CloudStorage limits: values up to 4096 chars, up to 1024 keys per user.
 * Expenses are stored per month as compact JSON arrays split into chunks:
 *   profile        -> {"budgets":{"2026-11":5000000},"defaultBudget":5000000}
 *   e_2026-11_0    -> [["id",120000,24,"food","обед",1764000000000], ...]
 */
(function (global) {
  "use strict";

  const CACHE_KEY = "ostatok-v1";
  const CHUNK_LIMIT = 3800;
  const GET_BATCH = 20;
  const MONTH_KEY = /^e_(\d{4}-\d{2})_(\d+)$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MAX_NOTE = 80;

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const safeParse = (s, fallback) => {
    if (typeof s !== "string" || s === "") return fallback;
    try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (e) { return fallback; }
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const unique = (list) => [...new Set(list)];

  function cleanEntry(e) {
    if (!isObj(e) || typeof e.id !== "string" || !DATE_RE.test(e.date)) return null;
    const amount = Number(e.amount);
    if (!(amount > 0) || !Number.isFinite(amount)) return null;
    return {
      id: e.id,
      amount,
      date: e.date,
      month: e.date.slice(0, 7),
      cat: typeof e.cat === "string" ? e.cat : "other",
      note: typeof e.note === "string" ? e.note.slice(0, MAX_NOTE) : "",
      createdAt: Number(e.createdAt) || 0,
    };
  }

  function normalize(raw) {
    const p = isObj(raw) ? raw : {};
    return {
      profile: isObj(p.profile) ? p.profile : {},
      expenses: (Array.isArray(p.expenses) ? p.expenses : []).map(cleanEntry).filter(Boolean),
      dirty: Array.isArray(p.dirty) ? p.dirty.filter((k) => typeof k === "string") : [],
    };
  }

  function readCache() {
    try { return normalize(safeParse(global.localStorage.getItem(CACHE_KEY), {})); }
    catch (e) { return normalize({}); }
  }
  function writeCache(data) {
    try { global.localStorage.setItem(CACHE_KEY, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }

  /* ---------- Compact month encoding ---------- */
  const encodeEntry = (e) => [e.id, e.amount, Number(e.date.slice(8, 10)), e.cat, e.note || "", e.createdAt || 0];

  function decodeEntry(month, a) {
    if (!Array.isArray(a) || a.length < 3) return null;
    const day = Number(a[2]);
    if (!(day >= 1 && day <= 31)) return null;
    return cleanEntry({
      id: String(a[0]), amount: a[1], date: `${month}-${String(day).padStart(2, "0")}`,
      cat: a[3], note: a[4], createdAt: a[5],
    });
  }

  function chunkEntries(entries) {
    const chunks = [];
    let current = [];
    let size = 2;
    for (const e of entries) {
      const encoded = encodeEntry(e);
      const len = JSON.stringify(encoded).length + 1;
      if (current.length && size + len > CHUNK_LIMIT) { chunks.push(current); current = []; size = 2; }
      current = [...current, encoded];
      size += len;
    }
    if (current.length) chunks.push(current);
    return chunks.map((c) => JSON.stringify(c));
  }

  /* ---------- Telegram CloudStorage adapter ---------- */
  function telegramCloud(cs) {
    const call = (method, ...args) => new Promise((resolve, reject) => {
      try { cs[method](...args, (err, val) => (err ? reject(new Error(String(err))) : resolve(val))); }
      catch (e) { reject(e); }
    });
    let knownKeys = null;

    async function keys() {
      if (!knownKeys) knownKeys = (await call("getKeys")) || [];
      return knownKeys;
    }
    async function getMany(list) {
      let out = {};
      for (let i = 0; i < list.length; i += GET_BATCH) {
        out = { ...out, ...((await call("getItems", list.slice(i, i + GET_BATCH))) || {}) };
      }
      return out;
    }

    async function pull() {
      knownKeys = null;
      const wanted = (await keys()).filter((k) => k === "profile" || MONTH_KEY.test(k));
      if (!wanted.length) return { empty: true, profile: {}, expenses: [] };
      const vals = await getMany(wanted);
      const profile = safeParse(vals.profile, {});
      const expenses = [];
      for (const k of wanted) {
        const m = k.match(MONTH_KEY);
        if (!m) continue;
        const arr = safeParse(vals[k], []);
        if (!Array.isArray(arr)) continue;
        for (const a of arr) { const e = decodeEntry(m[1], a); if (e) expenses.push(e); }
      }
      return { empty: false, profile: isObj(profile) ? profile : {}, expenses };
    }

    async function pushMonth(data, month) {
      const chunks = chunkEntries(data.expenses.filter((e) => e.month === month));
      for (let i = 0; i < chunks.length; i++) await call("setItem", `e_${month}_${i}`, chunks[i]);
      const written = chunks.map((_, i) => `e_${month}_${i}`);
      const current = await keys();
      const stale = current.filter((k) => { const m = k.match(MONTH_KEY); return m && m[1] === month && Number(m[2]) >= chunks.length; });
      if (stale.length) await call("removeItems", stale);
      knownKeys = unique([...current.filter((k) => !stale.includes(k)), ...written]);
    }

    async function push(data, which) {
      for (const k of which) {
        if (k === "profile") {
          await call("setItem", "profile", JSON.stringify(data.profile));
          knownKeys = unique([...(await keys()), "profile"]);
        } else {
          await pushMonth(data, k);
        }
      }
    }

    return { pull, push };
  }

  /* ---------- Store used by the app ---------- */
  function createStore(cloud) {
    let data = readCache();
    let synced = !cloud;
    let queue = Promise.resolve();
    const listeners = new Set();
    const errorListeners = new Set();
    const syncListeners = new Set();

    const emit = () => listeners.forEach((f) => f());
    const meta = () => ({ fromCache: !synced });
    const commit = (next) => { data = next; writeCache(data); emit(); };
    const reportError = (err) => errorListeners.forEach((f) => f(err));
    const watch = (fn) => { listeners.add(fn); fn(); return () => listeners.delete(fn); };
    const monthsOf = (d) => unique(d.expenses.map((e) => e.month));

    // Push every pending key; a failure keeps them marked so the next change or start retries.
    function flush() {
      if (!cloud) return Promise.resolve();
      const run = queue.then(async () => {
        const pending = data.dirty;
        if (!pending.length) return;
        try {
          await cloud.push(data, pending);
          commit({ ...data, dirty: data.dirty.filter((k) => !pending.includes(k)) });
          syncListeners.forEach((f) => f());
        } catch (err) {
          commit({ ...data, dirty: unique([...data.dirty, ...pending]) });
          throw err;
        }
      });
      queue = run.catch(() => {});
      return run.catch((err) => { reportError(err); throw err; });
    }

    function change(next, keys) {
      if (!cloud) { commit({ ...next, dirty: [] }); return Promise.resolve(); }
      commit({ ...next, dirty: unique([...next.dirty, ...keys]) });
      return flush();
    }

    async function start() {
      if (!cloud) return;
      try {
        if (data.dirty.length) await flush();
        const remote = await cloud.pull();
        const hasLocal = data.expenses.length > 0 || Object.keys(data.profile).length > 0;
        if (remote.empty && hasLocal) {
          await change(data, ["profile", ...monthsOf(data)]);
        } else {
          commit({ profile: remote.profile, expenses: remote.expenses, dirty: [] });
        }
        synced = true;
        emit();
        syncListeners.forEach((f) => f());
      } catch (err) {
        reportError(err);
      }
    }

    return {
      kind: cloud ? "telegram" : "local",
      start,
      onError: (fn) => errorListeners.add(fn),
      onSync: (fn) => syncListeners.add(fn),
      watchProfile: (cb) => watch(() => cb(data.profile, meta())),
      watchMonth: (month, cb) => watch(() => cb(data.expenses.filter((e) => e.month === month), meta())),
      add(e) {
        const entry = cleanEntry({ ...e, id: newId() });
        if (!entry) return Promise.reject(new Error("invalid entry"));
        return change({ ...data, expenses: [...data.expenses, entry] }, [entry.month]);
      },
      remove(id) {
        const target = data.expenses.find((x) => x.id === id);
        if (!target) return Promise.resolve();
        return change({ ...data, expenses: data.expenses.filter((x) => x.id !== id) }, [target.month]);
      },
      saveProfile: (profile) => change({ ...data, profile: { ...profile } }, ["profile"]),
      exportData: () => ({ app: "ostatok", version: 1, exportedAt: new Date().toISOString(), profile: data.profile, expenses: data.expenses }),
      importData(raw) {
        const next = normalize(raw);
        if (!next.expenses.length && !Object.keys(next.profile).length) throw new Error("В файле нет данных «Остатка».");
        return change({ ...next, dirty: [] }, ["profile", ...monthsOf(next)]);
      },
      countIn: (raw) => normalize(raw).expenses.length,
    };
  }

  global.OstatokStorage = { createStore, telegramCloud, _internals: { chunkEntries, decodeEntry, encodeEntry, normalize, CHUNK_LIMIT } };
})(typeof window !== "undefined" ? window : globalThis);
