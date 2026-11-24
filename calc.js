/*
 * Pure budget math for «Остаток». No DOM, no storage — easy to test.
 * Dates are local-calendar strings: "YYYY-MM-DD", months are "YYYY-MM".
 */
(function (global) {
  "use strict";

  const PERIOD_STARTS = [1, 6, 11, 16, 21, 26];

  const pad = (n) => String(n).padStart(2, "0");
  const parts = (s) => s.split("-").map(Number);
  const monthOf = (s) => s.slice(0, 7);

  /** @param {Date} [d] @returns {string} local date as YYYY-MM-DD */
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** @param {string} month YYYY-MM @returns {number} */
  const daysInMonth = (month) => { const [y, m] = parts(month); return new Date(y, m, 0).getDate(); };

  /** @param {string} month @param {number} delta @returns {string} */
  const shiftMonth = (month, delta) => {
    const [y, m] = parts(month);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };

  /**
   * Monthly amount for a month. A month without its own amount inherits the
   * most recent earlier month's amount, so changing November never rewrites October.
   * @param {{budgets?: Object<string, number>, defaultBudget?: number}} profile
   * @param {string} month
   * @returns {number|null}
   */
  function budgetFor(profile, month) {
    const b = (profile && profile.budgets) || {};
    if (typeof b[month] === "number") return b[month];
    const keys = Object.keys(b).filter((k) => typeof b[k] === "number").sort();
    const earlier = keys.filter((k) => k < month);
    if (earlier.length) return b[earlier[earlier.length - 1]];
    if (keys.length) return b[keys[0]];
    return profile && typeof profile.defaultBudget === "number" ? profile.defaultBudget : null;
  }

  /**
   * Everything the screen shows about one month.
   * @param {{amount:number, date:string}[]} expenses entries of that month
   * @param {string} month
   * @param {number} budget
   * @param {string} today YYYY-MM-DD
   */
  function monthStats(expenses, month, budget, today) {
    const D = daysInMonth(month);
    const curMonth = monthOf(today);
    const isCurrent = month === curMonth;
    const isPast = month < curMonth;
    const lastDay = isCurrent ? parts(today)[2] : isPast ? D : 0;

    const byDay = new Array(D + 1).fill(0);
    let spent = 0;
    for (const e of expenses) {
      const day = parts(e.date)[2];
      const amt = Number(e.amount) || 0;
      if (day >= 1 && day <= D) { byDay[day] += amt; spent += amt; }
    }
    const cumTo = [0];
    for (let d = 1; d <= D; d++) cumTo[d] = cumTo[d - 1] + byDay[d];

    const todayDay = isCurrent ? lastDay : 0;
    const daysLeft = isCurrent ? D - todayDay + 1 : 0;
    const spentToday = isCurrent ? byDay[todayDay] : 0;
    // Allowed for today, counting only what was spent before today.
    const todayLimit = isCurrent ? (budget - cumTo[todayDay - 1]) / daysLeft : 0;
    // Allowed per day for the days after today, counting today's spending too.
    const perDayAfter = isCurrent ? (budget - spent) / Math.max(1, D - todayDay) : 0;

    return {
      D, isCurrent, isPast, lastDay, byDay, cumTo, spent,
      remaining: budget - spent, todayDay, daysLeft, spentToday, todayLimit, perDayAfter,
      norm: budget / D,
    };
  }

  /** Rows for "По дням", newest first. */
  function dayRows(stats, budget) {
    const rows = [];
    for (let d = stats.lastDay; d >= 1; d--) {
      rows.push({
        day: d, spent: stats.byDay[d], rest: budget - stats.cumTo[d],
        ratio: stats.byDay[d] / stats.norm, isNow: stats.isCurrent && d === stats.todayDay,
      });
    }
    return rows;
  }

  /** Rows for "По 5 дней", newest first. The last period runs to the month's end. */
  function periodRows(stats, budget) {
    return PERIOD_STARTS
      .map((start, i) => ({ start, end: i === PERIOD_STARTS.length - 1 ? stats.D : PERIOD_STARTS[i + 1] - 1 }))
      .filter((p) => p.start <= stats.lastDay)
      .map((p) => {
        const upTo = Math.min(p.end, stats.lastDay);
        const spent = stats.cumTo[upTo] - stats.cumTo[p.start - 1];
        return {
          start: p.start, end: p.end, spent, rest: budget - stats.cumTo[upTo],
          ratio: spent / (stats.norm * (p.end - p.start + 1)),
          isNow: stats.isCurrent && stats.todayDay >= p.start && stats.todayDay <= p.end,
        };
      })
      .reverse();
  }

  global.OstatokCalc = { pad, parts, monthOf, dateKey, daysInMonth, shiftMonth, budgetFor, monthStats, dayRows, periodRows };
})(typeof window !== "undefined" ? window : globalThis);
