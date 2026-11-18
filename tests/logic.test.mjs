import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const RC = createRequire(import.meta.url)('../logic.js');

const roster = {
  format: 'route-capture-roster', version: 1, generated: '2026-11-08',
  days: {
    Fri: {
      lastSheet: '2026-11-13', skeleton: { confirmed: true },
      stops: [
        { id: 'a', street: 'Main St', number: '1', name: 'Alpha', onLastSheet: true, roadside: true, savedNote: ' Gate code 0000. Barrels back in the garage. ' },
        { id: 'b', street: 'Main St', number: '7', name: 'Bravo', onLastSheet: true, contract: '$18.75' },
        { id: 'c', street: 'Oak Ln', number: '3', name: 'Charlie', onLastSheet: true, recycle: true },
        { id: 'd', street: 'Oak Ln', number: '9', name: 'Delta', onLastSheet: false }
      ]
    }
  }
};
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const min = n => T0 + n * 60000;

test('createDay picks the weekday roster and tucks away off-sheet stops', () => {
  const st = RC.createDay('2026-11-13', roster);
  assert.equal(st.day, 'Fri');
  assert.equal(st.stops.length, 4);
  assert.deepEqual(RC.visibleStops(st).map(s => s.id), ['a', 'b', 'c']);
  assert.deepEqual(RC.hiddenStops(st).map(s => s.id), ['d']);
  assert.equal(RC.createDay('2026-11-14', roster).stops.length, 0, 'Saturday has no roster');
});

test('a saved note comes from the roster and is not part of the day export', () => {
  const st = RC.createDay('2026-11-13', roster);
  assert.equal(st.stops.find(s => s.id === 'a').savedNote, 'Gate code 0000. Barrels back in the garage.');
  assert.equal(st.stops.find(s => s.id === 'b').savedNote, '');
  RC.tap(st, 'a', min(1));
  RC.setNote(st, 'a', 'two bags beside the barrel');
  const csv = RC.toCsv(st);
  assert.ok(csv.includes('two bags beside the barrel'), 'the day note is exported');
  assert.ok(!csv.includes('Gate code 0000'), 'the saved note is not');
});

test('tap numbers stops in order and stamps time; re-tap is a no-op', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.tap(st, 'b', min(0));
  RC.tap(st, 'a', min(3));
  RC.tap(st, 'b', min(5));
  assert.equal(st.stops.find(s => s.id === 'b').seq, 1);
  assert.equal(st.stops.find(s => s.id === 'b').time, min(0));
  assert.equal(st.stops.find(s => s.id === 'a').seq, 2);
  assert.equal(st.startedAt, min(0));
});

test('untap closes the gap in the sequence', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.tap(st, 'a', min(0)); RC.tap(st, 'b', min(1)); RC.tap(st, 'c', min(2));
  RC.untap(st, 'a');
  const seqs = Object.fromEntries(st.stops.map(s => [s.id, s.seq]));
  assert.deepEqual(seqs, { a: null, b: 1, c: 2, d: null });
  RC.tap(st, 'a', min(4));
  assert.equal(st.stops.find(s => s.id === 'a').seq, 3);
});

test('setting a can count taps the stop; zero still records the time', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.setCans(st, 'c', 0, min(0));
  const c = st.stops.find(s => s.id === 'c');
  assert.equal(c.seq, 1);
  assert.equal(c.cans, 0);
  assert.equal(c.time, min(0));
  RC.setCans(st, 'c', 99, min(1));
  assert.equal(c.cans, 15, 'clamped to 15');
  assert.equal(c.time, min(0), 'time is not re-stamped');
  RC.setCans(st, 'c', '', min(2));
  assert.equal(c.cans, null);
});

test('move swaps with the neighbour and stops at the ends', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.tap(st, 'a', min(0)); RC.tap(st, 'b', min(1)); RC.tap(st, 'c', min(2));
  RC.move(st, 'c', -1);
  assert.deepEqual(RC.orderedStops(st).seq.map(s => s.id), ['a', 'c', 'b']);
  RC.move(st, 'a', -1);
  assert.deepEqual(RC.orderedStops(st).seq.map(s => s.id), ['a', 'c', 'b']);
  RC.move(st, 'b', +1);
  assert.deepEqual(RC.orderedStops(st).seq.map(s => s.id), ['a', 'c', 'b']);
});

test('skip removes from sequence and from the counts', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.tap(st, 'a', min(0)); RC.tap(st, 'b', min(1));
  RC.toggleSkip(st, 'a');
  const sum = RC.summary(st, min(5));
  assert.equal(sum.total, 2);
  assert.equal(sum.done, 1);
  assert.equal(sum.skipped, 1);
  assert.equal(st.stops.find(s => s.id === 'b').seq, 1, 'renumbered after skip');
  RC.toggleSkip(st, 'a');
  assert.equal(RC.summary(st).total, 3);
});

test('add-on stop gets a unique id and is flagged', () => {
  const st = RC.createDay('2026-11-13', roster);
  const s1 = RC.addStop(st, { street: 'Elm Rd', number: '4', name: 'Echo' }, min(0));
  const s2 = RC.addStop(st, { street: 'Elm Rd', number: '4', name: 'Echo again' }, min(1));
  assert.notEqual(s1.id, s2.id);
  assert.equal(s1.added, true);
  assert.equal(st.stops.length, 6);
});

test('summary and elapsed time', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.setCans(st, 'a', 2, min(0));
  RC.setCans(st, 'b', 0, min(10));
  RC.tap(st, 'c', min(30));
  const sum = RC.summary(st, min(45));
  assert.equal(sum.done, 3);
  assert.equal(sum.remaining, 0);
  assert.equal(sum.cans, 2);
  assert.equal(sum.nothingOut, 1);
  assert.equal(sum.withCount, 2);
  assert.equal(sum.elapsedMs, 45 * 60000);
  RC.complete(st, min(40));
  assert.equal(RC.summary(st, min(99)).elapsedMs, 40 * 60000, 'completion time wins');
  assert.equal(RC.durationText(RC.summary(st).elapsedMs), '0h 40m');
});

test('CSV export: sequenced first, then skipped, then not done; quotes escaped', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.setCans(st, 'b', 3, min(0));
  RC.setNote(st, 'b', 'gate code "1234", back in');
  RC.toggleSkip(st, 'a');
  const lines = RC.toCsv(st).trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^date,day,seq,time,street,number,name,trash_cans/);
  assert.match(lines[0], /trash_cans,recycling_cans,roadside,has_recycle,contract,status,note,added_today,saved_note$/);
  assert.match(lines[1], /^2026-11-13,Fri,1,\d\d:\d\d:\d\d,Main St,7,Bravo,3,,,,\$18\.75,done,"gate code ""1234"", back in",,$/);
  assert.match(lines[2], /,Main St,1,Alpha,,,yes,,,skipped,,,$/);
  assert.match(lines[3], /,Oak Ln,3,Charlie,,,,yes,,not_done,,,$/);
});

test('recycling count is separate from trash and also taps the stop', () => {
  const st = RC.createDay('2026-11-13', roster);
  assert.equal(st.stops.find(s => s.id === 'c').hasRecycle, true);
  assert.equal(st.stops.find(s => s.id === 'a').hasRecycle, null);
  RC.setRecycling(st, 'c', 2, min(0));
  const c = st.stops.find(s => s.id === 'c');
  assert.equal(c.seq, 1);
  assert.equal(c.recycling, 2);
  assert.equal(c.cans, null);
  RC.setCans(st, 'c', 3, min(1));
  const sum = RC.summary(st, min(2));
  assert.equal(sum.cans, 3);
  assert.equal(sum.recycling, 2);
  assert.equal(sum.nothingOut, 0);
  RC.toggleHasRecycle(st, 'a');
  assert.equal(st.stops.find(s => s.id === 'a').hasRecycle, true);
  const line = RC.toCsv(st).trim().split('\r\n')[1];
  assert.match(line, /,Oak Ln,3,Charlie,3,2,,yes,,done,,,$/);
  assert.equal(RC.pdfRows(st).done[0][5], '2');
});

test('PDF rows and file name', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.setCans(st, 'a', 4, min(0));
  const rows = RC.pdfRows(st);
  assert.equal(rows.done.length, 1);
  assert.deepEqual(rows.done[0].slice(2, 5), ['1 Main St', 'Alpha', '4']);
  assert.equal(rows.done[0][6], 'roadside');
  assert.equal(rows.notDone.length, 2);
  assert.equal(RC.fileStem(st), '2026-11-13 Fri Route Log');
});

test('roster validation', () => {
  assert.deepEqual(RC.validateRoster(roster), []);
  assert.ok(RC.validateRoster({}).length > 0);
  const bad = JSON.parse(JSON.stringify(roster));
  bad.days.Fri.stops.push({ id: 'a', street: 'Dup' });
  assert.ok(RC.validateRoster(bad).some(p => /duplicate id a/.test(p)));
});

test('state survives a JSON round trip (what localStorage does)', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.setCans(st, 'a', 1, min(0));
  const back = JSON.parse(RC.toJson(st));
  assert.deepEqual(back, st);
  RC.tap(back, 'b', min(1));
  assert.equal(back.stops.find(s => s.id === 'b').seq, 2);
});

test('a note kept on the phone wins over the roster and shows at the next visit', () => {
  const kept = { [RC.noteKey('Main St', '7')]: { text: ' Side door code 1111 ', at: 1 } };
  const st = RC.createDay('2026-11-13', roster, kept);
  assert.equal(st.stops.find(s => s.id === 'b').savedNote, 'Side door code 1111');
  assert.equal(st.stops.find(s => s.id === 'a').savedNote, 'Gate code 0000. Barrels back in the garage.');
  assert.equal(RC.noteKey(' main st ', 7), RC.noteKey('Main St', '7'));
});

test('the saved note and the note for today are separate; a changed saved note is carried by the export', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.setNote(st, 'b', 'extra bags today');
  RC.setSavedNote(st, 'b', ' Barrels behind the shed ');
  RC.setSavedNote(st, 'c', '');                 // nothing there, so nothing changes
  RC.setSavedNote(st, 'a', '');                 // taken off on the phone
  const b = st.stops.find(s => s.id === 'b');
  assert.equal(b.note, 'extra bags today');
  assert.equal(b.savedNote, 'Barrels behind the shed');
  assert.equal(b.savedNoteChanged, true);
  assert.equal(st.stops.find(s => s.id === 'c').savedNoteChanged, undefined);
  const lines = RC.toCsv(st).trim().split('\r\n');
  assert.equal(lines[0].split(',').pop(), 'saved_note');
  const last = (street, number) => lines.find(l => l.includes(`,${street},${number},`)).split(',').pop();
  assert.equal(last('Main St', '7'), 'Barrels behind the shed');
  assert.equal(last('Main St', '1'), '(removed)');
  assert.equal(last('Oak Ln', '3'), '');
  // an unchanged saved note never leaves the phone in the CSV
  assert.ok(!RC.toCsv(RC.createDay('2026-11-13', roster)).includes('Gate code'));
});

test('a day already open picks up saved notes that arrive later, but not over a change made today', () => {
  const bare = { ...roster, days: { Fri: { ...roster.days.Fri, stops: roster.days.Fri.stops.map(s => ({ ...s, savedNote: undefined })) } } };
  const st = RC.createDay('2026-11-13', bare);
  assert.equal(st.stops.find(s => s.id === 'a').savedNote, '');
  RC.setSavedNote(st, 'c', 'Dog in the yard');
  RC.refreshSavedNotes(st, roster, {
    [RC.noteKey('Main St', '7')]: { text: 'Kept on the phone', at: 1 },
    [RC.noteKey('Oak Ln', '3')]: { text: 'an older one', at: 0 }
  });
  assert.equal(st.stops.find(s => s.id === 'a').savedNote, 'Gate code 0000. Barrels back in the garage.');
  assert.equal(st.stops.find(s => s.id === 'b').savedNote, 'Kept on the phone');
  assert.equal(st.stops.find(s => s.id === 'c').savedNote, 'Dog in the yard');
  // a day saved by an older version has no saved notes at all: it gets them too
  const old = RC.createDay('2026-11-13', bare);
  old.stops.forEach(s => { delete s.savedNote; });
  assert.equal(RC.refreshSavedNotes(old, roster, {}).stops.find(s => s.id === 'a').savedNote, 'Gate code 0000. Barrels back in the garage.');
});

test('a note kept on the phone is dropped once the roster carries the same words', () => {
  const kept = {
    [RC.noteKey('Main St', '1')]: { text: 'Gate code 0000. Barrels back in the garage.', at: 1 },
    [RC.noteKey('Main St', '7')]: { text: 'Side door code 1111', at: 2 },
    [RC.noteKey('Elm St', '5')]: { text: 'not in this roster', at: 3 }
  };
  const left = RC.pruneSavedNotes(kept, roster);
  assert.deepEqual(Object.keys(left).sort(), [RC.noteKey('Elm St', '5'), RC.noteKey('Main St', '7')].sort());
  assert.deepEqual(RC.pruneSavedNotes(undefined, roster), {});
});

// ---- the list read from the tracker
const TITLES = ['Day', 'Pos', 'Street', 'Number', 'Name', 'Listed', 'Roadside', 'Recycle', 'Contract', 'Check number',
  'Order source', 'Stop id', 'Access ID', 'Schedule', 'Next pickup', 'Hold', 'Hold until', 'Office note', 'List date', 'Order confirmed'];
const listPage = () => ({
  format: 'route-capture-list', version: 1,
  meta: ['Phone list', 'Week of 2026-11-09', 'Built', '2026-11-08', 'Rows', '4'],
  titles: TITLES,
  rows: [
    ['Fri', '2', 'Main St', '7', 'Bravo', 'yes', 'no', '', '$18.75', '', 'driver', 'fri-main-st-7', '102', 'B1', '2026-11-13', '', '', '', '2026-11-13', 'yes'],
    ['Fri', '1', 'Main St', '1', 'Alpha', 'yes', 'yes', 'yes', '', 'yes', 'slotted', 'fri-main-st-1', '101', 'B2', '2026-11-13', '', '', '', '2026-11-13', 'yes'],
    ['Fri', '3', 'Oak Ln', '9', 'Delta', 'no', '', 'no', '', '', 'driver', 'fri-oak-ln-9', '', '', '', '', '', '', '2026-11-13', 'yes'],
    ['Mon', '1', 'Elm St', '5', 'Echo', 'yes', 'no', 'yes', '', '', 'driver', 'mon-elm-st-5', '', '', '', '', '', '', '2026-11-09', 'no'],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
  ],
  notes: [{ street: 'main st', number: 1, note: ' Gate code 0000 ' }, { street: 'Nowhere Rd', number: '2', note: 'not on the list' }, { street: 'Oak Ln', number: '9', note: '' }]
});

test('the list page from the tracker becomes the roster, in route order, with saved notes joined on', () => {
  const r = RC.rosterFromList(listPage());
  assert.deepEqual(RC.validateRoster(r), []);
  assert.equal(r.label, 'Week of 2026-11-09');
  assert.equal(r.generated, '2026-11-08');
  assert.deepEqual(Object.keys(r.days), ['Mon', 'Fri']);
  assert.deepEqual(r.days.Fri.stops.map(s => s.number), ['1', '7', '9']);
  const [a, b, d] = r.days.Fri.stops;
  assert.deepEqual([a.roadside, a.recycle, a.unsure, a.onLastSheet, a.orderSource, a.savedNote], [true, true, true, true, 'slotted', 'Gate code 0000']);
  assert.deepEqual([b.roadside, b.recycle, b.contract, b.savedNote], [false, null, '$18.75', undefined]);
  assert.equal(d.onLastSheet, false);
  assert.equal(r.days.Fri.lastSheet, '2026-11-13');
  assert.equal(r.days.Mon.skeleton.confirmed, false);
  // and a day built from it works like any other
  const st = RC.createDay('2026-11-13', r);
  assert.equal(RC.visibleStops(st).length, 2);
  assert.equal(st.stops[0].savedNote, 'Gate code 0000');
});

test('the same page gives the same roster, so an unchanged list is recognised', () => {
  assert.equal(JSON.stringify(RC.rosterFromList(listPage())), JSON.stringify(RC.rosterFromList(listPage())));
  const moved = listPage();
  const order = TITLES.map((_, i) => i).reverse();
  moved.titles = order.map(i => TITLES[i]);
  moved.rows = moved.rows.map(r => order.map(i => r[i]));
  assert.equal(JSON.stringify(RC.rosterFromList(moved)), JSON.stringify(RC.rosterFromList(listPage())));
});

test('a page that is not a list is refused with the reason', () => {
  assert.throws(() => RC.rosterFromList({ error: 'No "Phone list" tab' }), /No "Phone list" tab/);
  assert.throws(() => RC.rosterFromList({ titles: ['Day', 'Street'], rows: [] }), /missing: Number, Name, Listed, Stop id/);
  assert.throws(() => RC.rosterFromList({ ...listPage(), rows: [] }), /no stops/);
  assert.throws(() => RC.rosterFromList(null), /nothing readable/);
});

test('a day is untouched until something is recorded on it', () => {
  const touch = fn => { const st = RC.createDay('2026-11-13', roster); fn(st); return RC.dayIsUntouched(st); };
  assert.equal(touch(() => {}), true);
  assert.equal(touch(st => RC.tap(st, 'a', T0)), false);
  assert.equal(touch(st => RC.toggleSkip(st, 'b')), false);
  assert.equal(touch(st => RC.setNote(st, 'c', 'back in')), false);
  assert.equal(touch(st => RC.setSavedNote(st, 'c', 'dog')), false);
  assert.equal(touch(st => RC.unhide(st, 'd')), false);
  assert.equal(touch(st => RC.addStop(st, { street: 'Elm St', number: '5', name: 'New' }, T0)), false);
});

test('the date a weekday list was made for', () => {
  assert.equal(RC.listDateFor(roster, 'Fri'), '2026-11-13');
  assert.equal(RC.listDateFor(roster, 'Mon'), null);
  assert.equal(RC.listDateFor(null, 'Fri'), null);
});
