/* Route Order Capture: pure state logic. No DOM, no storage.
   Loaded by the browser as a plain script (window.RC) and by Node tests (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RC = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function dayKeyOf(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return DAY_KEYS[new Date(y, m - 1, d).getDay()];
  }
  function dayNameOf(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return DAY_NAMES[new Date(y, m - 1, d).getDay()];
  }
  function todayIso(now) {
    const d = now ? new Date(now) : new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function hhmm(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function hhmmss(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function durationText(ms) {
    if (ms == null || ms < 0) return '';
    const mins = Math.round(ms / 60000);
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }

  /** A fresh day's state from the roster for that weekday. */
  function createDay(isoDate, roster) {
    const key = dayKeyOf(isoDate);
    const day = roster && roster.days && roster.days[key];
    const stops = (day ? day.stops : []).map((s, i) => ({
      id: s.id,
      street: s.street,
      number: s.number,
      name: s.name,
      contract: s.contract || null,
      roadside: s.roadside == null ? null : !!s.roadside,
      unsure: !!s.unsure,
      onLastSheet: s.onLastSheet !== false,
      orderSource: s.orderSource || 'sheet',
      rosterIndex: i,
      // per-day capture
      seq: null,
      time: null,
      cans: null,
      note: '',
      skipped: false,
      hidden: s.onLastSheet === false,   // off the latest sheet: tucked away until needed
      added: false
    }));
    return {
      format: 'route-capture-day',
      version: 1,
      date: isoDate,
      day: key,
      rosterGenerated: roster ? roster.generated : null,
      skeletonConfirmed: !!(day && day.skeleton && day.skeleton.confirmed),
      stops,
      startedAt: null,
      completedAt: null
    };
  }

  function findStop(state, id) {
    const s = state.stops.find(x => x.id === id);
    if (!s) throw new Error('No such stop: ' + id);
    return s;
  }
  function maxSeq(state) {
    return state.stops.reduce((m, s) => (s.seq != null && s.seq > m ? s.seq : m), 0);
  }

  /** Tap: give the stop the next sequence number and a timestamp. No-op if already sequenced. */
  function tap(state, id, now) {
    const s = findStop(state, id);
    if (s.seq != null) return state;
    s.seq = maxSeq(state) + 1;
    s.time = now;
    s.skipped = false;
    s.hidden = false;
    if (!state.startedAt) state.startedAt = now;
    return state;
  }

  /** Untap: remove the stop from the sequence and close the gap. */
  function untap(state, id) {
    const s = findStop(state, id);
    if (s.seq == null) return state;
    const gone = s.seq;
    s.seq = null;
    s.time = null;
    for (const o of state.stops) if (o.seq != null && o.seq > gone) o.seq -= 1;
    return state;
  }

  /** Set the can count. Setting a count on an untapped stop taps it (0 still records the time). */
  function setCans(state, id, n, now) {
    const s = findStop(state, id);
    if (n === null || n === '' || n === undefined) { s.cans = null; return state; }
    const v = Math.max(0, Math.min(15, Number(n) | 0));
    s.cans = v;
    if (s.seq == null) tap(state, id, now);
    return state;
  }

  /** Swap sequence positions with the neighbour (delta -1 = earlier, +1 = later). */
  function move(state, id, delta) {
    const s = findStop(state, id);
    if (s.seq == null) return state;
    const target = s.seq + delta;
    const o = state.stops.find(x => x.seq === target);
    if (!o) return state;
    o.seq = s.seq;
    s.seq = target;
    return state;
  }

  function setNote(state, id, text) {
    findStop(state, id).note = (text || '').trim();
    return state;
  }

  /** Skip = DELETE on the sheet (not served today). Skipped stops are kept, unsequenced. */
  function toggleSkip(state, id) {
    const s = findStop(state, id);
    if (s.seq != null) untap(state, id);
    s.skipped = !s.skipped;
    return state;
  }

  function toggleRoadside(state, id) {
    const s = findStop(state, id);
    s.roadside = s.roadside === true ? false : true;
    return state;
  }

  /** Bring a tucked-away (not on last sheet) stop back into today's list. */
  function unhide(state, id) {
    findStop(state, id).hidden = false;
    return state;
  }

  /** An add-on stop typed in on the day. */
  function addStop(state, { street, number, name }, now) {
    const base = `added-${(street || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${number || 'x'}`;
    let id = base, n = 2;
    while (state.stops.some(s => s.id === id)) id = `${base}-${n++}`;
    const s = {
      id, street: (street || '').trim(), number: (number || '').trim(), name: (name || '').trim(),
      contract: null, roadside: null, unsure: false, onLastSheet: true, orderSource: 'added',
      rosterIndex: state.stops.length,
      seq: null, time: null, cans: null, note: '', skipped: false, hidden: false, added: true,
      addedAt: now
    };
    state.stops.push(s);
    return s;
  }

  function complete(state, now) {
    state.completedAt = now;
    return state;
  }
  function reopen(state) {
    state.completedAt = null;
    return state;
  }

  /** Stops in the order they should be shown: roster order, grouped by street as on the sheet. */
  function visibleStops(state) {
    return state.stops.filter(s => !s.hidden);
  }
  function hiddenStops(state) {
    return state.stops.filter(s => s.hidden);
  }
  /** Group consecutive stops by street, preserving order. */
  function groupByStreet(stops) {
    const groups = [];
    for (const s of stops) {
      const g = groups[groups.length - 1];
      if (g && g.street === s.street) g.stops.push(s);
      else groups.push({ street: s.street, stops: [s] });
    }
    return groups;
  }

  /** Sequenced stops first (by seq), then skipped, then the rest in roster order. */
  function orderedStops(state) {
    const seq = state.stops.filter(s => s.seq != null).sort((a, b) => a.seq - b.seq);
    const skipped = state.stops.filter(s => s.seq == null && s.skipped && !s.hidden);
    const rest = state.stops.filter(s => s.seq == null && !s.skipped && !s.hidden);
    return { seq, skipped, rest };
  }

  function summary(state, now) {
    const active = state.stops.filter(s => !s.hidden && !s.skipped);
    const done = active.filter(s => s.seq != null);
    const cans = done.reduce((t, s) => t + (s.cans || 0), 0);
    const times = done.map(s => s.time).filter(Boolean);
    const first = times.length ? Math.min(...times) : null;
    const last = times.length ? Math.max(...times) : null;
    const end = state.completedAt || (now != null ? now : last);
    return {
      total: active.length,
      done: done.length,
      remaining: active.length - done.length,
      skipped: state.stops.filter(s => s.skipped && !s.hidden).length,
      cans,
      withCount: done.filter(s => s.cans != null).length,
      nothingOut: done.filter(s => s.cans === 0).length,
      first, last,
      elapsedMs: first != null && end != null ? end - first : null
    };
  }

  // ---------------------------------------------------------------- exports

  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** One row per stop, sequenced ones first. The office can open this in Excel. */
  function toCsv(state) {
    const { seq, skipped, rest } = orderedStops(state);
    const head = ['date', 'day', 'seq', 'time', 'street', 'number', 'name', 'cans', 'roadside',
      'contract', 'status', 'note', 'added_today'];
    const row = (s, status) => [
      state.date, state.day, s.seq == null ? '' : s.seq, s.time ? hhmmss(s.time) : '',
      s.street, s.number, s.name, s.cans == null ? '' : s.cans,
      s.roadside == null ? '' : (s.roadside ? 'yes' : 'no'),
      s.contract || '', status, s.note || '', s.added ? 'yes' : ''
    ].map(csvEscape).join(',');
    const lines = [head.join(',')];
    for (const s of seq) lines.push(row(s, 'done'));
    for (const s of skipped) lines.push(row(s, 'skipped'));
    for (const s of rest) lines.push(row(s, 'not_done'));
    return lines.join('\r\n') + '\r\n';
  }

  /** Full state, for the archive and for loading back into the tracker. */
  function toJson(state) {
    return JSON.stringify(state, null, 1);
  }

  /** Rows for the PDF: [seq, time, address, name, cans, flags, note]. */
  function pdfRows(state) {
    const { seq, skipped, rest } = orderedStops(state);
    const flags = s => [
      s.roadside === true ? 'roadside' : '',
      s.contract ? 'contract ' + s.contract : '',
      s.added ? 'ADDED' : ''
    ].filter(Boolean).join(', ');
    const r = (s, mark) => [
      mark != null ? mark : String(s.seq), s.time ? hhmm(s.time) : '',
      `${s.number} ${s.street}`.trim(), s.name,
      s.cans == null ? '' : String(s.cans), flags(s), s.note || ''
    ];
    return {
      done: seq.map(s => r(s)),
      skipped: skipped.map(s => r(s, 'SKIP')),
      notDone: rest.map(s => r(s, '-'))
    };
  }

  function fileStem(state) {
    return `${state.date} ${state.day} Route Log`;
  }

  /** Basic validation of an imported roster file. Returns a list of problems (empty = ok). */
  function validateRoster(obj) {
    const problems = [];
    if (!obj || typeof obj !== 'object') return ['Not a JSON object'];
    if (obj.format !== 'route-capture-roster') problems.push('Missing format: route-capture-roster');
    if (!obj.days || typeof obj.days !== 'object') { problems.push('Missing "days"'); return problems; }
    for (const [k, d] of Object.entries(obj.days)) {
      if (!DAY_KEYS.includes(k)) problems.push(`Unknown day key "${k}"`);
      if (!d || !Array.isArray(d.stops)) { problems.push(`${k}: missing stops`); continue; }
      const ids = new Set();
      d.stops.forEach((s, i) => {
        if (!s.id) problems.push(`${k}[${i}]: missing id`);
        else if (ids.has(s.id)) problems.push(`${k}: duplicate id ${s.id}`);
        ids.add(s.id);
        if (!s.street) problems.push(`${k}[${i}]: missing street`);
      });
    }
    return problems;
  }

  return {
    DAY_KEYS, DAY_NAMES, dayKeyOf, dayNameOf, todayIso, hhmm, hhmmss, durationText,
    createDay, tap, untap, setCans, move, setNote, toggleSkip, toggleRoadside, unhide, addStop,
    complete, reopen, visibleStops, hiddenStops, groupByStreet, orderedStops, summary,
    toCsv, toJson, pdfRows, fileStem, validateRoster
  };
}));
