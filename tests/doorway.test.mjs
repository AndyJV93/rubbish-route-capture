// The tracker's doorway script, run here against a pretend spreadsheet. Every customer is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const RC = createRequire(import.meta.url)('../logic.js');
const source = readFileSync(new URL('../tools/tracker_doorway.gs', import.meta.url), 'utf8');

function serve(pages, e, raw) {
  const SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: name => (name in pages
    ? { getDataRange: () => ({ getDisplayValues: () => pages[name] }) } : null) }) };
  const ContentService = { MimeType: { JSON: 'json', JAVASCRIPT: 'javascript' },
    createTextOutput: text => ({ text, setMimeType(type) { this.type = type; return this; } }) };
  const out = new Function('SpreadsheetApp', 'ContentService', 'e', source + '\nreturn doGet(e);')(SpreadsheetApp, ContentService, e);
  if (raw) return out;
  assert.equal(out.type, 'json');
  return JSON.parse(out.text);
}
const LIST = [
  ['Phone list', 'Week of 2026-01-12', 'Built', '2026-01-11', 'Rows', '2'],
  ['Day', 'Pos', 'Street', 'Number', 'Name', 'Listed', 'Stop id', 'List date', 'Order confirmed'],
  ['Mon', '1', 'Maple Rd', '4', 'Example', 'yes', 'mon-maple-rd-4', '2026-01-12', 'yes'],
  ['Mon', '2', 'Maple Rd', '11', 'Sample', 'no', 'mon-maple-rd-11', '2026-01-12', 'yes']
];
const NOTES = [
  ['Street', 'Number', 'Name', 'Saved note (shows in the stop screen on the phone)', 'Source'],
  ['Maple Rd', '4', 'Example', 'Gate code 0000', 'truck'],
  ['Oak Ln', '3', 'Other', '', 'nothing written yet']
];

test('the doorway serves the list page and the saved notes, and the app can build its list from them', () => {
  const got = serve({ 'Phone list': LIST, 'Phone notes': NOTES, 'Customers': [['never served']] });
  assert.equal(got.format, 'route-capture-list');
  assert.deepEqual(got.notes, [{ street: 'Maple Rd', number: '4', note: 'Gate code 0000' }]);
  assert.ok(!JSON.stringify(got).includes('never served'));
  const roster = RC.rosterFromList(got);
  assert.deepEqual(roster.days.Mon.stops.map(s => [s.number, s.onLastSheet, s.savedNote]), [['4', true, 'Gate code 0000'], ['11', false, undefined]]);
  assert.equal(roster.days.Mon.lastSheet, '2026-01-12');
});

test('the doorway says what is wrong instead of failing', () => {
  assert.match(serve({}).error, /no "Phone list" page/);
  assert.match(serve({ 'Phone list': LIST.slice(0, 2) }).error, /empty/);
  assert.throws(() => RC.rosterFromList(serve({})), /no "Phone list" page/);
  assert.deepEqual(serve({ 'Phone list': LIST }).notes, []);
});

test('asked with a callback name, the doorway answers as a script that hands over the same list', () => {
  const out = serve({ 'Phone list': LIST, 'Phone notes': NOTES }, { parameter: { callback: '__rcList1a2b' } }, true);
  assert.equal(out.type, 'javascript');
  let got = null;
  new Function('__rcList1a2b', out.text)(payload => { got = payload; });
  assert.deepEqual(got.rows, LIST.slice(2));
  assert.deepEqual(RC.rosterFromList(got).days.Mon.stops.map(s => s.number), ['4', '11']);
});

test('a callback name that is not a plain name is ignored', () => {
  for (const bad of ['alert(1)//', 'a.b', 'x;y', '']) {
    const out = serve({ 'Phone list': LIST }, { parameter: { callback: bad } }, true);
    assert.equal(out.type, 'json');
    assert.doesNotThrow(() => JSON.parse(out.text));
  }
});
