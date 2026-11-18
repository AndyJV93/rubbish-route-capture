/**
 * Doorway for the route app.
 *
 * Put this in the tracker spreadsheet (Extensions > Apps Script) and deploy it as a web app:
 *     Execute as: Me        Who has access: Anyone
 * The web app address Google shows after deploying is the link for the phone. That address is
 * the secret: whoever has it can read the list, so it is only ever pasted into the route app.
 * To shut an old link, make a new deployment and archive the old one.
 *
 * It only reads. It answers with the "Phone list" page as it stands and the saved notes from the
 * "Phone notes" page, and with nothing else from the spreadsheet.
 *
 * Asked with ?callback=name it answers as a script that calls name(list). That is how a web page
 * reads it when the browser will not let the page read the plain answer.
 */
function doGet(e) {
  var out;
  try {
    var book = SpreadsheetApp.getActiveSpreadsheet();
    var page = book.getSheetByName('Phone list');
    if (!page) throw new Error('there is no "Phone list" page in this spreadsheet');
    var cells = page.getDataRange().getDisplayValues();
    if (cells.length < 3) throw new Error('the "Phone list" page is empty');
    out = {
      format: 'route-capture-list', version: 1, served: new Date().toISOString(),
      meta: cells[0], titles: cells[1], rows: cells.slice(2), notes: savedNotes_(book)
    };
  } catch (err) {
    out = { format: 'route-capture-list', version: 1, error: String((err && err.message) || err) };
  }
  var callback = e && e.parameter && e.parameter.callback;
  if (callback && /^[A-Za-z_$][A-Za-z0-9_$]{0,60}$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + JSON.stringify(out) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Street, number and note from the "Phone notes" page. The columns are found by their titles. */
function savedNotes_(book) {
  var page = book.getSheetByName('Phone notes');
  if (!page) return [];
  var cells = page.getDataRange().getDisplayValues();
  if (!cells.length) return [];
  var titles = cells[0].map(function (t) { return String(t).trim().toLowerCase(); });
  var street = titles.indexOf('street'), number = titles.indexOf('number'), note = -1;
  for (var i = 0; i < titles.length; i++) {
    if (titles[i].indexOf('saved note') === 0) { note = i; break; }
  }
  if (street < 0 || number < 0 || note < 0) return [];
  var out = [];
  for (var r = 1; r < cells.length; r++) {
    if (cells[r][street] && cells[r][note]) out.push({ street: cells[r][street], number: cells[r][number], note: cells[r][note] });
  }
  return out;
}
