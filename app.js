/* «Остаток» — screen logic. Math lives in calc.js, storage in storage.js. */
(() => {
  "use strict";

  const C = window.OstatokCalc;
  const S = window.OstatokStorage;

  const CATS = [
    { id: "food", name: "Еда" }, { id: "transport", name: "Транспорт" }, { id: "home", name: "Дом" },
    { id: "phone", name: "Связь" }, { id: "health", name: "Здоровье" }, { id: "clothes", name: "Одежда" },
    { id: "fun", name: "Отдых" }, { id: "other", name: "Другое" },
  ];
  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const MAX_AMOUNT = 1e12;
  const DAY_CHECK_MS = 30000;
  const TOAST_MS = 2200;
  const DELETE_CONFIRM_MS = 3000;
  const PREF_VIEW = "ostatok-view";
  const PREF_INSTALL_HIDDEN = "ostatok-install-hidden";

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = Boolean(tg && tg.initData);
  const tgAtLeast = (v) => Boolean(inTelegram && typeof tg.isVersionAtLeast === "function" && tg.isVersionAtLeast(v));

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString("ru-RU");
  const digits = (v) => String(v || "").replace(/\D/g, "");
  const prefGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const prefSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  const state = {
    today: C.dateKey(),
    month: C.monthOf(C.dateKey()),
    profile: {},
    profileLoaded: false,
    expenses: [],
    view: "days",
    cat: "food",
    pendingDelete: null,
    pendingImport: null,
  };
  let store = null;
  let unsubMonth = null;

  /* ---------- Subscriptions ---------- */
  function subscribeProfile() {
    store.watchProfile((p) => {
      state.profile = p || {};
      state.profileLoaded = true;
      render();
    });
  }
  function subscribeMonth() {
    if (unsubMonth) unsubMonth();
    const month = state.month;
    unsubMonth = store.watchMonth(month, (list) => {
      if (month !== state.month) return;
      state.expenses = list;
      render();
    });
  }

  /* ---------- Rendering ---------- */
  function render() {
    const d = C.parts(state.today);
    $("todayLabel").replaceChildren("Сегодня ", h("b", null, `${d[2]} ${MONTHS_GEN[d[1] - 1]}`), `, ${WEEKDAYS[new Date(d[0], d[1] - 1, d[2]).getDay()]}`);
    $("loading").hidden = state.profileLoaded;
    if (!state.profileLoaded) return;

    const budget = C.budgetFor(state.profile, state.month);
    const needsSetup = budget == null;
    $("setup").hidden = !needsSetup;
    for (const id of ["hero", "addCard", "timelineCard", "listCard", "catCard"]) $(id).hidden = needsSetup;
    $("backupCard").hidden = needsSetup || store.kind !== "local";
    if (needsSetup) return;

    const s = C.monthStats(state.expenses, state.month, budget, state.today);
    renderHero(budget, s);
    renderTimeline(budget, s);
    renderList();
    renderCats(s);
  }

  const tile = (k, v, cls) => h("div", { class: "tile" }, h("div", { class: "k" }, k), h("div", { class: `v num ${cls || ""}` }, v));

  function renderHero(budget, s) {
    const [y, m] = C.parts(state.month);
    $("monthLabel").textContent = `${MONTHS[m - 1]} ${y}`;
    $("remain").textContent = fmt(s.remaining);
    $("remainLabel").textContent = s.remaining < 0 ? "Перерасход" : s.isPast ? "Осталось в конце месяца" : "Остаток";
    $("hero").classList.toggle("over", s.remaining < 0);
    $("heroBar").style.transform = `scaleX(${Math.min(1, budget > 0 ? s.spent / budget : 0)})`;
    $("spentTotal").textContent = fmt(s.spent);
    $("budgetTotal").textContent = fmt(budget);

    let tiles;
    if (s.isCurrent) {
      const showTomorrow = s.spentToday > 0 && s.daysLeft > 1;
      tiles = [
        tile("Потрачено сегодня", fmt(s.spentToday), s.spentToday > s.todayLimit ? "bad" : ""),
        showTomorrow
          ? tile("Можно в день с завтра", fmt(Math.max(0, s.perDayAfter)), s.remaining < 0 ? "bad" : "good")
          : tile("Можно сегодня", fmt(Math.max(0, s.todayLimit - s.spentToday)), s.remaining < 0 ? "bad" : "good"),
        tile("Дней до конца месяца", String(s.daysLeft)),
      ];
    } else if (s.isPast) {
      tiles = [
        tile("В среднем за день", fmt(s.spent / s.D)),
        tile("Записей", String(state.expenses.length)),
        tile("Итог", s.remaining >= 0 ? "в плюсе" : "перерасход", s.remaining >= 0 ? "good" : "bad"),
      ];
    } else {
      tiles = [tile("Месяц ещё не начался", "—"), tile("Можно в день", fmt(s.norm), "good"), tile("Дней в месяце", String(s.D))];
    }
    $("pace").replaceChildren(...tiles);
  }

  function renderTimeline(budget, s) {
    const [y, m] = C.parts(state.month);
    const mon = MONTHS_SHORT[m - 1];
    if (s.lastDay === 0) {
      $("legend").textContent = "";
      $("timeline").replaceChildren(h("p", { class: "empty" }, "Этот месяц ещё не начался."));
      return;
    }
    let rows;
    if (state.view === "days") {
      $("legend").textContent = `Справа — сколько осталось в конце дня. Полоса — расход дня; норма ${fmt(s.norm)} сум в день.`;
      rows = C.dayRows(s, budget).map((r) => ledgerRow(
        [`${r.day} ${mon}`, h("small", null, WD_SHORT[new Date(y, m - 1, r.day).getDay()])], r));
    } else {
      $("legend").textContent = `Справа — сколько осталось в конце периода. Норма ${fmt(s.norm * 5)} сум за 5 дней.`;
      rows = C.periodRows(s, budget).map((r) => ledgerRow([`${r.start}–${r.end} ${mon}`], r));
    }
    $("timeline").replaceChildren(...rows);
  }

  function ledgerRow(whenParts, r) {
    const over = r.ratio > 1;
    return h("div", { class: `lrow${r.isNow ? " is-today" : ""}` },
      h("div", { class: "when" }, ...whenParts),
      h("div", { class: `rest num${r.rest < 0 ? " neg" : ""}` }, fmt(r.rest)),
      h("div", { class: "meter", "aria-hidden": "true" }, h("i", { class: over ? "over" : "", style: `width:${Math.min(100, r.ratio * 100)}%` })),
      h("div", { class: `spent num${over ? " over" : ""}` }, r.spent > 0 ? `−${fmt(r.spent)}` : "без трат"));
  }

  const catName = (id) => (CATS.find((c) => c.id === id) || CATS[CATS.length - 1]).name;

  function renderList() {
    const list = [...state.expenses].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    if (!list.length) {
      $("list").replaceChildren(h("p", { class: "empty" }, "Пока нет записей. Добавьте первый расход в форме выше."));
      return;
    }
    const groups = new Map();
    for (const e of list) groups.set(e.date, [...(groups.get(e.date) || []), e]);
    $("list").replaceChildren(...[...groups].map(([date, items]) => {
      const [y, m, d] = C.parts(date);
      const total = items.reduce((a, e) => a + e.amount, 0);
      return h("div", { class: "day-group" },
        h("div", { class: "day-title" },
          h("span", null, `${d} ${MONTHS_GEN[m - 1]}, ${WD_SHORT[new Date(y, m - 1, d).getDay()]}`),
          h("span", { class: "num" }, `−${fmt(total)}`)),
        ...items.map(entryRow));
    }));
  }

  function entryRow(e) {
    const confirming = state.pendingDelete === e.id;
    return h("div", { class: "entry" },
      h("div", { class: "what" }, h("div", { class: "t" }, e.note || catName(e.cat)), h("div", { class: "c" }, catName(e.cat))),
      h("div", { class: "amt num" }, `−${fmt(e.amount)}`),
      h("button", {
        class: `del${confirming ? " confirm" : ""}`, type: "button",
        "aria-label": confirming ? "Подтвердить удаление" : "Удалить запись",
        onclick: () => onDelete(e.id),
      }, confirming ? "Удалить" : "×"));
  }

  function renderCats(s) {
    const sums = new Map();
    for (const e of state.expenses) sums.set(e.cat, (sums.get(e.cat) || 0) + e.amount);
    const rows = [...sums].sort((a, b) => b[1] - a[1]);
    if (!rows.length) { $("catList").replaceChildren(h("p", { class: "empty" }, "Появится после первых расходов.")); return; }
    const max = rows[0][1] || 1;
    $("catList").replaceChildren(...rows.map(([cat, sum]) => h("div", { class: "cat-row" },
      h("span", { class: "name" }, catName(cat)),
      h("span", { class: "track", "aria-hidden": "true" }, h("i", { style: `width:${(sum / max) * 100}%` })),
      h("span", { class: "sum num" }, `${fmt(sum)} · ${Math.round((sum / (s.spent || 1)) * 100)}%`))));
  }

  function renderChips() {
    $("catChips").replaceChildren(...CATS.map((c) => h("button", {
      class: "chip", type: "button", "aria-pressed": String(state.cat === c.id),
      onclick: () => { state.cat = c.id; renderChips(); },
    }, c.name)));
  }

  /* ---------- Feedback ---------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, TOAST_MS);
  }
  function showNote(msg) { $("note").textContent = msg; $("note").hidden = !msg; }
  function haptic(type) {
    if (tgAtLeast("6.1") && tg.HapticFeedback) { try { tg.HapticFeedback.notificationOccurred(type); } catch (e) { /* not supported */ } }
  }
  // In Telegram a failed sync is not data loss: the entry is on the phone and goes up on the next change or start.
  function saveError(err) {
    if (store.kind === "telegram") return toast("Сохранено на телефоне. В Telegram отправлю при следующей связи.");
    toast(err && err.message === "invalid entry" ? "Проверьте сумму и дату." : "Не удалось сохранить.");
  }
  const setError = (id, msg) => { $(id).textContent = msg || ""; $(id).hidden = !msg; };

  /* ---------- Actions ---------- */
  function readAmount(input) {
    const v = Number(digits(input.value));
    return v > 0 && v <= MAX_AMOUNT ? v : null;
  }

  async function saveBudget(value) {
    const budgets = { ...(state.profile.budgets || {}), [state.month]: value };
    const saving = store.saveProfile({ ...state.profile, budgets, defaultBudget: value });
    toast("Сумма на месяц сохранена");
    try { await saving; } catch (err) { saveError(err); }
  }

  $("setupForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = readAmount($("setupAmount"));
    if (!v) return setError("setupError", "Введите сумму больше нуля.");
    setError("setupError", "");
    $("setupAmount").value = "";
    saveBudget(v);
  });

  $("editBudget").addEventListener("click", () => {
    $("budgetForm").hidden = false;
    $("budgetAmount").value = fmt(C.budgetFor(state.profile, state.month) || 0);
    $("budgetAmount").focus();
  });
  $("cancelBudget").addEventListener("click", () => { $("budgetForm").hidden = true; });
  $("budgetForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = readAmount($("budgetAmount"));
    if (!v) return toast("Введите сумму больше нуля.");
    $("budgetForm").hidden = true;
    saveBudget(v);
  });

  $("addForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const amount = readAmount($("amount"));
    const date = $("dateInput").value || state.today;
    if (!amount) return setError("addError", "Введите сумму расхода.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError("addError", "Выберите дату.");
    setError("addError", "");
    const entry = { amount, date, cat: state.cat, note: $("noteInput").value.trim().slice(0, 80), createdAt: Date.now() };
    const saving = store.add(entry);
    $("amount").value = "";
    $("noteInput").value = "";
    haptic("success");
    toast(C.monthOf(date) === state.month ? `Записано: −${fmt(amount)} сум` : `Записано в ${MONTHS[C.parts(date)[1] - 1]}`);
    try { await saving; } catch (err) { saveError(err); }
  });

  let deleteTimer = null;
  async function onDelete(id) {
    clearTimeout(deleteTimer);
    if (state.pendingDelete !== id) {
      state.pendingDelete = id;
      renderList();
      deleteTimer = setTimeout(() => { state.pendingDelete = null; renderList(); }, DELETE_CONFIRM_MS);
      return;
    }
    state.pendingDelete = null;
    const removing = store.remove(id);
    toast("Запись удалена");
    try { await removing; } catch (err) { saveError(err); }
  }

  function defaultDateFor(month) {
    const cur = C.monthOf(state.today);
    if (month === cur) return state.today;
    return month < cur ? `${month}-${C.pad(C.daysInMonth(month))}` : `${month}-01`;
  }
  function goMonth(delta) {
    state.month = C.shiftMonth(state.month, delta);
    state.pendingDelete = null;
    $("budgetForm").hidden = true;
    $("dateInput").value = defaultDateFor(state.month);
    subscribeMonth();
    render();
  }
  $("prevMonth").addEventListener("click", () => goMonth(-1));
  $("nextMonth").addEventListener("click", () => goMonth(1));

  function setView(v) {
    state.view = v;
    $("viewDays").setAttribute("aria-pressed", String(v === "days"));
    $("viewFive").setAttribute("aria-pressed", String(v === "five"));
    prefSet(PREF_VIEW, v);
    render();
  }
  $("viewDays").addEventListener("click", () => setView("days"));
  $("viewFive").addEventListener("click", () => setView("five"));

  document.querySelectorAll("input.money").forEach((inp) => inp.addEventListener("input", () => {
    const d = digits(inp.value).slice(0, 13);
    inp.value = d ? Number(d).toLocaleString("ru-RU") : "";
  }));

  /* ---------- Backup (phone-only storage) ---------- */
  $("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(store.exportData(), null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `ostatok-${state.today}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async () => {
    const file = $("importFile").files[0];
    $("importFile").value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || raw.app !== "ostatok") throw new Error("not ostatok");
      state.pendingImport = raw;
      $("importText").textContent = `В файле записей: ${store.countIn(raw)}. Текущие данные на этом телефоне будут заменены.`;
      $("importConfirm").hidden = false;
    } catch (e) {
      toast("Это не файл резервной копии «Остатка».");
    }
  });
  $("importNo").addEventListener("click", () => { state.pendingImport = null; $("importConfirm").hidden = true; });
  $("importYes").addEventListener("click", async () => {
    try { await store.importData(state.pendingImport); toast("Данные восстановлены"); }
    catch (e) { toast(e.message || "Не удалось восстановить."); }
    state.pendingImport = null;
    $("importConfirm").hidden = true;
  });

  /* ---------- New day at 00:00 ---------- */
  function checkDay() {
    const t = C.dateKey();
    if (t === state.today) return;
    const prev = state.today;
    const viewingCurrent = state.month === C.monthOf(prev);
    state.today = t;
    if ($("dateInput").value === prev) $("dateInput").value = t;
    if (viewingCurrent && state.month !== C.monthOf(t)) {
      state.month = C.monthOf(t);
      $("dateInput").value = t;
      subscribeMonth();
    }
    render();
  }
  function scheduleMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    setTimeout(() => { checkDay(); scheduleMidnight(); }, next - now);
  }

  /* ---------- Telegram & install ---------- */
  function rgbToHex(rgb) {
    const m = String(rgb).match(/\d+/g);
    return m && m.length >= 3 ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : null;
  }
  function setupTelegram() {
    tg.ready();
    tg.expand();
    const apply = () => {
      document.documentElement.dataset.theme = tg.colorScheme === "dark" ? "dark" : "light";
      if (!tgAtLeast("6.1")) return;
      const bg = rgbToHex(getComputedStyle(document.body).backgroundColor);
      if (!bg) return;
      try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } catch (e) { /* older client */ }
    };
    apply();
    tg.onEvent("themeChanged", apply);
  }

  function setupInstallHint() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (inTelegram || standalone || prefGet(PREF_INSTALL_HIDDEN) === "1") return;
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const close = () => { $("installBanner").hidden = true; prefSet(PREF_INSTALL_HIDDEN, "1"); };
    $("installClose").addEventListener("click", close);
    if (isIOS) {
      $("installText").replaceChildren("Установите на iPhone: нажмите ", h("b", null, "«Поделиться»"), " и выберите ", h("b", null, "«На экран „Домой“»"), ".");
      $("installBanner").hidden = false;
    }
    window.addEventListener("beforeinstallprompt", (ev) => {
      ev.preventDefault();
      $("installText").replaceChildren("Установите «Остаток» как приложение на телефон.");
      $("installBtn").hidden = false;
      $("installBanner").hidden = false;
      $("installBtn").onclick = async () => { ev.prompt(); try { await ev.userChoice; } catch (e) { /* dismissed */ } close(); };
    });
  }

  function registerServiceWorker() {
    if (inTelegram || !("serviceWorker" in navigator) || location.protocol !== "https:") return;
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline mode unavailable */ });
  }

  /* ---------- Start ---------- */
  function init() {
    const v = prefGet(PREF_VIEW);
    if (v === "days" || v === "five") setView(v);
    $("dateInput").value = state.today;
    renderChips();

    let cloud = null;
    if (inTelegram) {
      setupTelegram();
      if (tgAtLeast("6.9") && tg.CloudStorage) cloud = S.telegramCloud(tg.CloudStorage);
      else showNote("Обновите Telegram: в этой версии записи хранятся только на телефоне.");
    }
    store = S.createStore(cloud);
    store.onError(() => showNote("Нет связи с Telegram. Записи сохранены на телефоне и отправятся позже."));
    store.onSync(() => { if ($("note").textContent.startsWith("Нет связи")) showNote(""); });
    subscribeProfile();
    subscribeMonth();
    store.start();

    setInterval(checkDay, DAY_CHECK_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDay(); });
    window.addEventListener("focus", checkDay);
    scheduleMidnight();
    setupInstallHint();
    registerServiceWorker();
  }
  init();
})();
