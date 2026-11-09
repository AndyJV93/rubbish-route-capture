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
        { id: 'a', street: 'Main St', number: '1', name: 'Alpha', onLastSheet: true, roadside: true },
        { id: 'b', street: 'Main St', number: '7', name: 'Bravo', onLastSheet: true, contract: '$18.75' },
        { id: 'c', street: 'Oak Ln', number: '3', name: 'Charlie', onLastSheet: true },
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
  assert.match(lines[0], /^date,day,seq,time,street,number,name,cans/);
  assert.match(lines[1], /^2026-11-13,Fri,1,\d\d:\d\d:\d\d,Main St,7,Bravo,3,,\$18\.75,done,"gate code ""1234"", back in",$/);
  assert.match(lines[2], /,Main St,1,Alpha,,yes,,skipped,,$/);
  assert.match(lines[3], /,Oak Ln,3,Charlie,,,,not_done,,$/);
});

test('PDF rows and file name', () => {
  const st = RC.createDay('2026-11-13', roster);
  RC.setCans(st, 'a', 4, min(0));
  const rows = RC.pdfRows(st);
  assert.equal(rows.done.length, 1);
  assert.deepEqual(rows.done[0].slice(2, 5), ['1 Main St', 'Alpha', '4']);
  assert.equal(rows.done[0][5], 'roadside');
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
