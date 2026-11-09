# Route Capture

A small, offline-first web app for recording what actually happens on a pickup route:
the order the driver takes the stops, the time at each one, and how many cans were out.
Built for a phone in a truck cab: big tap targets, one hand, no sign-in, no server.

- **Tap a stop** → it gets the next number and a timestamp. Tap the number to undo, reorder, skip or add a note.
- **Cans 0–15** per stop. Picking a count on an untapped stop also stamps the time (0 = nothing out).
- **Add stop** for a customer on the paper sheet who isn't in the app yet.
- **Complete route** → PDF for the office and CSV/JSON for the data, shared through the phone's
  share sheet (Drive, email, text) or saved to Downloads.
- **Works offline.** Everything is stored on the phone and survives refresh and restart.
  Signal is only needed once, to install, and when you share the export.

Pin it to the home screen from the browser menu ("Add to Home screen" / "Install").

## The roster

The app needs a `roster.json`: the customers per weekday, in the best known driving order.
No customer data lives in this repository; the roster is built separately and loaded into the
app once (Menu → Load roster → pick the file from Drive or Files).

```
python3 tools/build_roster.py appearances.csv roster.json --skeleton skeletons.json
```

`appearances.csv` has one row per customer per printed route sheet
(`Date,Day,List,Street,Number,Name,Flags on sheet`). `skeletons.json` optionally gives the
known driver order per weekday; stops not in it are slotted next to their street-mates.
See `tools/build_roster.py --help` and `sample/` for a small fake example.

## Export format

| File | Contents |
|---|---|
| `YYYY-MM-DD Day Route Log.pdf` | Ordered table for the office: #, time, address, name, cans, flags, note; then skipped and not-done stops |
| `… Route Log.csv` | Same, one row per stop, status column `done` / `skipped` / `not_done` |
| `… Route Log.json` | Complete app state for the day, for loading into other tools |

## Development

Plain HTML/CSS/JS, no build step. `logic.js` holds all the state rules and has no DOM code;
`app.js` is the UI and storage; `sw.js` is the offline cache. Run the tests with:

```
node --test
python3 tools/check_no_customer_data.py
```

The second command refuses any roster, appearances CSV or route export outside `sample/`
(and, when a private denylist file is present, any customer name or street). It runs in CI
and as a pre-commit hook; install the hook once with
`cp tools/pre-commit .git/hooks/pre-commit`.

To release: bump `VERSION` in `sw.js` (and `APP_VERSION` in `app.js`), then push to `main`.
GitHub Pages serves the site from the repository root.

## License

MIT
