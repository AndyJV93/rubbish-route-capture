/* Route Order Capture: UI + storage. Logic lives in logic.js (window.RC). */
(function () {
  'use strict';

  const APP_VERSION = '1.1.2';
  const KEYS = { roster: 'rc.roster', current: 'rc.current', settings: 'rc.settings', day: d => `rc.day.${d}` };
  const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  // ------------------------------------------------------------ storage
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch (e) { showBanner('Could not save: ' + e.message); return false; }
    },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    dayKeys() {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('rc.day.')) out.push(k.slice(7));
        }
      } catch { /* ignore */ }
      return out.sort().reverse();
    }
  };

  let roster = store.get(KEYS.roster, null);
  let settings = Object.assign({ hideDone: false, keepAwake: false }, store.get(KEYS.settings, {}));
  let state = null;          // today's day state
  let wakeLock = null;

  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  function save() {
    if (state) store.set(KEYS.day(state.date), state);
  }
  function saveSettings() { store.set(KEYS.settings, settings); }

  // ------------------------------------------------------------ day loading
  function loadDay(isoDate, { rosterDay } = {}) {
    const saved = store.get(KEYS.day(isoDate), null);
    if (saved && saved.format === 'route-capture-day') {
      state = saved;
    } else {
      let r = roster;
      if (rosterDay && roster && roster.days && roster.days[rosterDay]) {
        // Use another weekday's roster for this date (holiday shift etc).
        r = { ...roster, days: { [RC.dayKeyOf(isoDate)]: roster.days[rosterDay] } };
      }
      state = RC.createDay(isoDate, r);
      if (rosterDay) state.rosterDay = rosterDay;
      save();
    }
    store.set(KEYS.current, isoDate);
    render();
  }

  // ------------------------------------------------------------ rendering
  function render() {
    const list = $('#list');
    list.textContent = '';
    if (!state) return;

    $('#dayLabel').textContent = RC.dayNameOf(state.date) + (state.completedAt ? ' ✓' : '');
    $('#dateLabel').textContent = state.date + (state.rosterDay ? ` · ${state.rosterDay} roster` : '');

    const sum = RC.summary(state);
    $('#doneCount').textContent = sum.done;
    $('#totalCount').textContent = sum.total;
    const bits = [];
    if (sum.cans) bits.push(`🗑 ${sum.cans}`);
    if (sum.recycling) bits.push(`♻ ${sum.recycling}`);
    if (sum.elapsedMs != null && sum.done > 1) bits.push(RC.durationText(sum.elapsedMs));
    if (sum.skipped) bits.push(`${sum.skipped} skipped`);
    $('#subline').textContent = bits.join(' · ');

    $('#completeBtn').textContent = state.completedAt ? 'Export again' : 'Complete route';

    if (!roster) {
      list.append(el('div', { class: 'empty-state' },
        'No roster loaded yet.',
        el('br'),
        el('button', { class: 'btn primary', type: 'button', onclick: openRosterSheet }, 'Load roster')));
      return;
    }

    const visible = RC.visibleStops(state).filter(s => !(settings.hideDone && s.seq != null));
    if (!visible.length && !RC.visibleStops(state).length) {
      list.append(el('div', { class: 'empty-state' },
        `No stops in the roster for ${RC.dayNameOf(state.date)}.`,
        el('br'),
        el('button', { class: 'btn secondary', type: 'button', onclick: openDaySheet }, 'Pick another day or roster')));
    }

    for (const g of RC.groupByStreet(visible)) {
      const all = RC.visibleStops(state).filter(s => s.street === g.street && !s.skipped);
      const done = all.filter(s => s.seq != null).length;
      list.append(el('div', { class: 'street' }, el('span', null, g.street),
        el('span', { class: 'cnt' }, `${done}/${all.length}`)));
      for (const s of g.stops) list.append(renderStop(s));
    }

    const hidden = RC.hiddenStops(state);
    if (hidden.length) {
      list.append(el('button', { class: 'section-toggle', type: 'button', onclick: openHiddenSheet },
        `${hidden.length} not on the latest sheet… tap to add one back`));
    }
    if (settings.hideDone && sum.done) {
      list.append(el('button', { class: 'section-toggle', type: 'button',
        onclick: () => { settings.hideDone = false; saveSettings(); render(); } },
        `${sum.done} done hidden · show`));
    }
  }

  function renderStop(s) {
    const cls = ['stop', s.seq != null ? 'done' : '', s.skipped ? 'skipped' : ''].join(' ');
    const badge = el('button', { class: 'badge', type: 'button', 'aria-label': 'Stop actions',
      onclick: () => openStopSheet(s.id) }, s.skipped ? 'SKIP' : (s.seq != null ? String(s.seq) : ''));

    const meta = el('div', { class: 'meta' });
    if (s.time) meta.append(el('span', { class: 'tag time' }, RC.hhmm(s.time)));
    if (s.roadside === true) meta.append(el('span', { class: 'tag road' }, 'roadside'));
    if (s.hasRecycle === true) meta.append(el('span', { class: 'tag recyc' }, '♻ recycle'));
    if (s.contract) meta.append(el('span', { class: 'tag contract' }, s.contract));
    if (s.unsure) meta.append(el('span', { class: 'tag unsure' }, 'check #'));
    if (s.added) meta.append(el('span', { class: 'tag new' }, 'added today'));
    if (s.note) meta.append(el('span', { class: 'tag' }, s.note));

    const main = el('button', { class: 'main', type: 'button',
      onclick: () => {
        if (s.skipped) return openStopSheet(s.id);
        if (s.seq == null) { RC.tap(state, s.id, Date.now()); save(); render(); }
        else openStopSheet(s.id);
      } },
      el('div', { class: 'who' }, el('span', { class: 'num' }, s.number), ' ', s.name || ''),
      meta);

    const counter = (field, icon, label) => {
      const sel = el('select', { class: `cans ${field}` + (s[field] == null ? ' empty' : ''), 'aria-label': label,
        onchange: e => { RC.setCount(state, s.id, field, e.target.value, Date.now()); save(); render(); } });
      sel.append(el('option', { value: '' }, `${icon} –`));
      for (let i = 0; i <= 15; i++) sel.append(el('option', { value: String(i) }, `${icon} ${i}`));
      sel.value = s[field] == null ? '' : String(s[field]);
      return sel;
    };
    const counts = el('div', { class: 'counts' },
      counter('cans', '🗑', 'Trash cans'),
      counter('recycling', '♻', 'Recycling cans'));

    return el('div', { class: cls, 'data-id': s.id }, badge, main, counts);
  }

  // ------------------------------------------------------------ sheets (modals)
  function openSheet(title, bodyBuilder, sub) {
    const sheet = $('#sheet');
    $('#sheetTitle').textContent = title;
    const body = $('#sheetBody');
    body.textContent = '';
    if (sub) body.append(el('div', { class: 'sheet-sub' }, sub));
    bodyBuilder(body);
    sheet.hidden = false;
  }
  function closeSheet() { $('#sheet').hidden = true; }

  function openStopSheet(id) {
    const s = state.stops.find(x => x.id === id);
    openSheet(`${s.number} ${s.street}`, body => {
      const act = (label, fn, cls = 'secondary') =>
        el('button', { class: `btn ${cls} block`, type: 'button', onclick: () => { fn(); save(); render(); closeSheet(); } }, label);
      if (s.seq != null) {
        body.append(act(`Undo stop #${s.seq}`, () => RC.untap(state, id), 'danger'));
        body.append(act('Move earlier (swap with previous)', () => RC.move(state, id, -1)));
        body.append(act('Move later (swap with next)', () => RC.move(state, id, +1)));
      } else if (!s.skipped) {
        body.append(act('Mark done now', () => RC.tap(state, id, Date.now()), 'primary'));
      }
      body.append(act(s.skipped ? 'Un-skip (back on today’s list)' : 'Skip today (DELETE on sheet)', () => RC.toggleSkip(state, id)));
      body.append(act(s.roadside === true ? 'Mark as driveway (not roadside)' : 'Mark as roadside pickup', () => RC.toggleRoadside(state, id)));
      body.append(act(s.hasRecycle === true ? 'Mark as no recycling service' : 'Mark as has recycling ♻', () => RC.toggleHasRecycle(state, id)));
      const note = el('input', { type: 'text', value: s.note || '', placeholder: 'e.g. back in, gate code, dog' });
      body.append(el('label', null, 'Note'), note);
      body.append(el('button', { class: 'btn secondary block', type: 'button',
        onclick: () => { RC.setNote(state, id, note.value); save(); render(); closeSheet(); } }, 'Save note'));
    }, s.name + (s.time ? ` · ${RC.hhmm(s.time)}` : ''));
  }

  function openAddSheet() {
    openSheet('Add a stop', body => {
      const streets = [...new Set(state.stops.map(s => s.street))].sort();
      const dl = el('datalist', { id: 'streets' });
      streets.forEach(st => dl.append(el('option', { value: st })));
      const street = el('input', { type: 'text', list: 'streets', placeholder: 'Street', autocapitalize: 'words' });
      const number = el('input', { type: 'text', placeholder: 'Number', inputmode: 'numeric' });
      const name = el('input', { type: 'text', placeholder: 'Name', autocapitalize: 'words' });
      body.append(dl, el('label', null, 'Street'), street,
        el('div', { class: 'row2' }, el('div', null, el('label', null, 'Number'), number), el('div', null, el('label', null, 'Name'), name)));
      body.append(el('button', { class: 'btn primary block', type: 'button', onclick: () => {
        if (!street.value.trim()) { street.focus(); return; }
        const s = RC.addStop(state, { street: street.value, number: number.value, name: name.value }, Date.now());
        RC.tap(state, s.id, Date.now());
        save(); render(); closeSheet();
        const row = document.querySelector(`[data-id="${s.id}"]`);
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
      } }, 'Add and mark done now'));
      body.append(el('div', { class: 'fine' }, 'Added stops are flagged in the export so the office can add them to the customer list.'));
      setTimeout(() => street.focus(), 50);
    }, 'A customer who is on the paper sheet but not in the app.');
  }

  function openHiddenSheet() {
    openSheet('Not on the latest sheet', body => {
      for (const s of RC.hiddenStops(state)) {
        body.append(el('button', { class: 'btn secondary block', type: 'button',
          onclick: () => { RC.unhide(state, s.id); save(); render(); closeSheet(); } },
          `${s.number} ${s.street} · ${s.name}`, el('small', null, s.lastSeen ? `  (last ${s.lastSeen})` : '')));
      }
    }, 'Customers seen on earlier sheets for this weekday. Tap one to put it on today’s list.');
  }

  function openDaySheet() {
    openSheet('Which day?', body => {
      const date = el('input', { type: 'date', value: state ? state.date : RC.todayIso() });
      body.append(el('label', null, 'Date'), date);
      const hasRoster = roster && roster.days;
      body.append(el('label', null, 'Use the roster for'));
      const grid = el('div', { class: 'daygrid' });
      let pick = state && state.rosterDay ? state.rosterDay : null;
      const dayBtns = {};
      for (const k of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
        const n = hasRoster && roster.days[k] ? roster.days[k].stops.length : 0;
        dayBtns[k] = el('button', { class: 'btn secondary', type: 'button', disabled: n ? null : '',
          onclick: () => { pick = pick === k ? null : k; Object.entries(dayBtns).forEach(([kk, b]) => b.classList.toggle('on', kk === pick)); } },
          k, el('br'), el('small', null, n ? `${n}` : '–'));
        grid.append(dayBtns[k]);
      }
      body.append(grid, el('div', { class: 'fine' }, 'Leave none selected to use the roster matching the date’s weekday. Pick one to run, say, Monday’s route on a Tuesday after a holiday.'));
      body.append(el('button', { class: 'btn primary block', type: 'button', onclick: () => {
        if (!date.value) return;
        const existing = store.get(KEYS.day(date.value), null);
        if (existing && pick && existing.rosterDay !== pick && existing.stops.some(s => s.seq != null)) {
          if (!confirmInline(body, `${date.value} already has stops recorded. Open it as saved?`)) return;
        }
        loadDay(date.value, { rosterDay: pick || undefined });
        closeSheet();
      } }, 'Open day'));
      const saved = store.dayKeys();
      if (saved.length) {
        body.append(el('label', null, 'Saved days'));
        for (const d of saved.slice(0, 14)) {
          const st = store.get(KEYS.day(d), null);
          const sm = st ? RC.summary(st) : null;
          body.append(el('button', { class: 'btn secondary block history-item', type: 'button',
            onclick: () => { loadDay(d); closeSheet(); } },
            el('span', null, `${d} ${st ? st.day : ''}${st && st.completedAt ? ' ✓' : ''}`),
            el('small', null, sm ? `${sm.done}/${sm.total} stops · ${sm.cans} cans` : '')));
        }
      }
    });
  }

  // A tiny inline confirm (dialogs are unreliable in installed web apps).
  function confirmInline(body, text) {
    let box = body.querySelector('.confirm');
    if (box) { box.remove(); return true; }
    box = el('div', { class: 'banner confirm' }, text, el('br'), el('small', null, 'Tap the button again to confirm.'));
    body.prepend(box);
    return false;
  }

  function openRosterSheet() {
    openSheet('Roster', body => {
      if (roster) {
        const days = Object.entries(roster.days || {}).map(([k, d]) => `${k} ${d.stops.length}`).join(' · ');
        body.append(el('div', { class: 'fine' }, `Loaded: ${roster.label || 'roster'} (built ${roster.generated || '?'})`, el('br'), days));
      }
      const file = el('input', { type: 'file', accept: '.json,application/json' });
      body.append(el('label', null, 'Pick roster.json (from Drive, Files, or Downloads)'), file);
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        try { applyRoster(JSON.parse(await f.text())); } catch (e) { showBanner('Could not read file: ' + e.message); }
      });
      const ta = el('textarea', { placeholder: '…or paste the roster JSON here' });
      body.append(el('label', null, 'Paste'), ta);
      body.append(el('button', { class: 'btn secondary block', type: 'button', onclick: () => {
        try { applyRoster(JSON.parse(ta.value)); } catch (e) { showBanner('Not valid JSON: ' + e.message); }
      } }, 'Use pasted roster'));
      body.append(el('div', { class: 'fine' }, 'Loading a roster does not change days you have already started. New days use the new roster.'));
    }, 'The customer list per weekday. Built by tools/build_roster.py from the customer tracker.');
  }

  function applyRoster(obj) {
    const problems = RC.validateRoster(obj);
    if (problems.length) { showBanner('Roster problems: ' + problems.slice(0, 3).join('; ')); return; }
    roster = obj;
    store.set(KEYS.roster, roster);
    closeSheet();
    showBanner(`Roster loaded: ${Object.keys(roster.days).join(', ')}`, 'info');
    if (state && !state.stops.length) { store.del(KEYS.day(state.date)); loadDay(state.date, { rosterDay: state.rosterDay }); }
    else render();
  }

  function openMenu() {
    openSheet('Menu', body => {
      const act = (label, fn) => el('button', { class: 'btn secondary block', type: 'button', onclick: fn }, label);
      body.append(act('Change day / saved days', openDaySheet));
      body.append(act('Load roster', openRosterSheet));
      body.append(act(settings.hideDone ? 'Show done stops' : 'Hide done stops', () => { settings.hideDone = !settings.hideDone; saveSettings(); render(); closeSheet(); }));
      const awake = el('input', { type: 'checkbox' });
      awake.checked = !!settings.keepAwake;
      awake.addEventListener('change', () => { settings.keepAwake = awake.checked; saveSettings(); updateWakeLock(); });
      body.append(el('label', { class: 'toggle' }, el('span', null, 'Keep screen on while this is open'), awake));
      if (state && state.completedAt) body.append(act('Reopen today (keep adding stops)', () => { RC.reopen(state); save(); render(); closeSheet(); }));
      body.append(act('Reset today (start the list over)', () => {
        if (!confirmInline(body, 'This clears every tap for ' + state.date + '.')) return;
        store.del(KEYS.day(state.date)); loadDay(state.date, { rosterDay: state.rosterDay }); closeSheet();
      }));
      body.append(el('div', { class: 'fine' }, `Route Capture v${APP_VERSION} · ${navigator.onLine ? 'online' : 'offline'} · data stays on this phone until you export`));
    });
  }

  // ------------------------------------------------------------ complete + export
  function openCompleteSheet() {
    if (!state) return;
    if (!state.completedAt) { RC.complete(state, Date.now()); save(); render(); }
    const sum = RC.summary(state);
    openSheet('Route complete', body => {
      body.append(el('div', { class: 'summary' },
        el('div', null, el('b', null, `${sum.done}`), el('span', null, `of ${sum.total} stops`)),
        el('div', null, el('b', null, `${sum.cans}`), el('span', null, '🗑 trash cans')),
        el('div', null, el('b', null, `${sum.recycling}`), el('span', null, '♻ recycling')),
        el('div', null, el('b', null, RC.durationText(sum.elapsedMs) || '–'), el('span', null, 'first to last'))));
      if (sum.remaining) body.append(el('div', { class: 'banner' }, `${sum.remaining} stops were not marked done. They are listed as "not done" in the export.`));
      const status = el('div', { class: 'fine' });
      const btn = (label, fn, cls = 'secondary') => el('button', { class: `btn ${cls} block`, type: 'button',
        onclick: async () => { status.textContent = 'Working…'; try { await fn(); status.textContent = 'Done.'; } catch (e) { status.textContent = 'Failed: ' + e.message; } } }, label);
      body.append(btn('Share PDF + CSV (to Drive, text, email…)', () => shareFiles(['pdf', 'csv']), 'primary'));
      body.append(btn('Save PDF', () => saveFile('pdf')));
      body.append(btn('Save CSV', () => saveFile('csv')));
      body.append(btn('Save JSON (full data)', () => saveFile('json')));
      body.append(btn('Copy CSV to clipboard', async () => { await navigator.clipboard.writeText(RC.toCsv(state)); }));
      body.append(status);
      body.append(el('button', { class: 'btn ghost block', type: 'button', onclick: () => { RC.reopen(state); save(); render(); closeSheet(); } }, 'Not finished, go back'));
    }, `${RC.dayNameOf(state.date)} ${state.date}`);
  }

  async function buildFile(kind) {
    const stem = RC.fileStem(state);
    if (kind === 'csv') return new File([RC.toCsv(state)], `${stem}.csv`, { type: 'text/csv' });
    if (kind === 'json') return new File([RC.toJson(state)], `${stem}.json`, { type: 'application/json' });
    const blob = await buildPdf();
    return new File([blob], `${stem}.pdf`, { type: 'application/pdf' });
  }

  async function shareFiles(kinds) {
    const files = [];
    for (const k of kinds) files.push(await buildFile(k));
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: RC.fileStem(state), text: `Route log ${state.date}` });
      return;
    }
    for (const f of files) downloadFile(f);
  }
  async function saveFile(kind) { downloadFile(await buildFile(kind)); }
  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: file.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.jspdf) return res();
      const s = el('script', { src, onload: res, onerror: () => rej(new Error('PDF library not available offline yet')) });
      document.head.append(s);
    });
  }

  async function buildPdf() {
    await loadScript(JSPDF_URL);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const M = 40;
    const sum = RC.summary(state);
    const rows = RC.pdfRows(state);
    const cols = [
      { h: '#', w: 26 }, { h: 'Time', w: 38 }, { h: 'Address', w: 140 }, { h: 'Name', w: 100 },
      { h: 'Trash', w: 32 }, { h: 'Recyc', w: 36 }, { h: 'Flags', w: 96 }, { h: 'Note', w: W - 2 * M - 468 }
    ];
    let y = M;
    const header = () => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
      doc.text(`Route Log — ${RC.dayNameOf(state.date)}, ${state.date}`, M, y); y += 20;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      const t = [`${sum.done} of ${sum.total} stops`, `${sum.cans} trash cans`, `${sum.recycling} recycling`,
        sum.first ? `first ${RC.hhmm(sum.first)}` : '', sum.last ? `last ${RC.hhmm(sum.last)}` : '',
        sum.elapsedMs != null ? RC.durationText(sum.elapsedMs) : '', sum.skipped ? `${sum.skipped} skipped` : ''].filter(Boolean).join('   ·   ');
      doc.text(t, M, y); y += 18;
    };
    const tableHead = () => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      let x = M;
      for (const c of cols) { doc.text(c.h, x, y); x += c.w; }
      y += 6; doc.setDrawColor(150); doc.line(M, y, W - M, y); y += 11;
      doc.setFont('helvetica', 'normal');
    };
    const newPage = () => { doc.addPage(); y = M; tableHead(); };
    const row = r => {
      const cells = r.map((v, i) => doc.splitTextToSize(String(v || ''), cols[i].w - 6));
      const lines = Math.max(...cells.map(c => c.length));
      const hgt = lines * 11 + 4;
      if (y + hgt > H - M - 20) newPage();
      let x = M;
      cells.forEach((c, i) => { doc.text(c, x, y); x += cols[i].w; });
      y += hgt;
    };
    const section = (title, list) => {
      if (!list.length) return;
      if (y + 30 > H - M - 20) newPage();
      y += 8; doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(title, M, y); y += 14;
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      list.forEach(row);
    };
    header(); tableHead();
    rows.done.forEach(row);
    section('Skipped today', rows.skipped);
    section('Not marked done', rows.notDone);
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p); doc.setFontSize(8); doc.setTextColor(120);
      doc.text(`Route Capture · exported ${new Date().toLocaleString()} · page ${p}/${pages}`, M, H - 20);
      doc.setTextColor(0);
    }
    return doc.output('blob');
  }

  // ------------------------------------------------------------ misc
  let bannerTimer = null;
  function showBanner(text, kind, onTap) {
    const b = $('#banner');
    b.textContent = text; b.className = 'banner' + (kind ? ' ' + kind : ''); b.hidden = false;
    b.onclick = onTap || null;
    clearTimeout(bannerTimer);
    // an actionable banner stays until tapped; a notice fades
    if (!onTap) bannerTimer = setTimeout(() => { b.hidden = true; }, 6000);
  }

  async function updateWakeLock() {
    try {
      if (settings.keepAwake && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!settings.keepAwake && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch { /* not supported or denied */ }
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showBanner('A new version is ready. Tap here to reload.', 'info', () => location.reload());
          }
        });
      });
    }).catch(() => { /* offline-first still works from cache */ });
  }

  // ------------------------------------------------------------ boot
  function boot() {
    $('#dayBtn').addEventListener('click', openDaySheet);
    $('#menuBtn').addEventListener('click', openMenu);
    $('#addBtn').addEventListener('click', openAddSheet);
    $('#completeBtn').addEventListener('click', openCompleteSheet);
    $('#sheet').addEventListener('click', e => { if (e.target === e.currentTarget || e.target.hasAttribute('data-close')) closeSheet(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { updateWakeLock(); render(); } });
    window.addEventListener('online', () => render());
    window.addEventListener('offline', () => render());

    const today = RC.todayIso();
    const current = store.get(KEYS.current, null);
    // Open today, unless yesterday's (or another day's) route is still unfinished.
    if (current && current !== today) {
      const st = store.get(KEYS.day(current), null);
      if (st && !st.completedAt && st.stops.some(s => s.seq != null)) {
        loadDay(current);
        showBanner(`Showing ${current}: it was never completed. Change day from the top-left.`);
        registerSw(); updateWakeLock(); return;
      }
    }
    loadDay(today);
    registerSw();
    updateWakeLock();
    // Demo mode: open index.html#demo to try the app with the fictional sample roster.
    if (!roster && location.hash === '#demo') {
      try {
        const x = new XMLHttpRequest();          // synchronous on purpose: demo only, so the
        x.open('GET', 'sample/roster.sample.json', false);   // first paint already has the list
        x.send();
        if (x.status === 200) {
          applyRoster(JSON.parse(x.responseText));
          const first = roster && Object.values(roster.days)[0];
          if (first && first.lastSheet) loadDay(first.lastSheet);   // show a day that has stops
        }
      } catch { /* demo is optional */ }
    }
    // Warm the PDF library into the cache while there is signal.
    if (navigator.onLine) loadScript(JSPDF_URL).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
