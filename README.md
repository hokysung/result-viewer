# result-viewer

Flip through the per-unit rasters of an exported recording session with the keyboard, mouse or
touch, and keep a **notebook per session**: a note, number-key tags and a flag per unit. Every unit
opens in **electro_gui** (`~/Code/electrogui`) with one key, and the noted ones show up in its
config menu.

Python 3.8+ standard library only; no build step.

```bash
./rv --root ~/viewer_sessions          # = python3 -m result_viewer serve; opens http://127.0.0.1:8766/
python3 -m unittest discover -s tests -t .
```

## What it reads and writes

| | Path | |
|---|---|---|
| Sessions (read-only) | `--root DIR` (repeatable; first root holding a session wins), default `$SESSION_VIEWER_ROOTS` or `~/viewer_sessions` | one folder per session, as phys-analysis `python -m session_viewer build` writes it |
| Notebooks | `<data>/notes/<sid>.json` | source of truth, one file per session |
| | `<data>/notes/<sid>.md` | readable copy, regenerated on every save |
| electro_gui configs | `<data>/electro_gui/<sid>/electro_gui_configs/unit_NNNN.json` | one per noted unit, mirrored on every save |
| Settings | `<data>/settings.json` | tag list and electro_gui URLs |

`<data>` is `--data-dir`, else `$RESULT_VIEWER_DATA`, else `~/result-viewer-data`. Put it in a synced
folder to share notes between machines; a sync conflict copy is reported on the page.

A session folder is

```
<root>/<Subject>_<YYYYMMDD>/
  session.h5                                   the exported session (electro_gui reads it)
  figures/unit_rasters/unit_NNNN_<quality>_<Subject>_<YYYYMMDD>_<area>_rates_raster.png
  figures/<kind>/unit_NNNN_...png              any other per-unit figure, shown as an extra tab
  tables/units.csv                             unit_id, quality, area, peak_channel, depth_um,
                                               mean_rate_hz, n_stable_trials, n_completed_trials
```

A unit is a unit id of `session.h5`, defined by its raster. Its current label, rate, stable trials,
peak channel and depth come from `tables/units.csv` (channel and depth only when the table is not
older than `session.h5`). A raster whose file name carries another label than the table's is marked
"relabelled". A unit is **full-session stable** when it is stable on every completed trial.

**Notebook entries** record what the unit looked like when noted (quality, area, peak channel,
depth, raster file name), because unit ids do not survive a re-sort. Each save re-reads the file and
changes one unit. `python3 -m result_viewer rebuild` regenerates every `.md` and electro_gui config
from the JSON (after renaming tags, say).

## Using it

| Keys | |
|---|---|
| `→` `←` · `j` `k` · `Space` | next / previous unit in the filtered list |
| `Home` `End` · `g` | first / last unit · go to unit # |
| `s` · `S` | sort by unit # → firing rate → stable trials · reverse the sort |
| `]` `[` · `r` | next / previous figure · back to the raster |
| `}` `{` | next / previous session |
| `1`–`9` · `f` | toggle tag · flag |
| `n` / `Enter` · `Esc` · `⌘↩` | write a note · done · save and go to the next unit |
| `z` / click | zoom to full resolution and back (drag to pan; zoom stays while you flip) |
| `e` | open this unit in electro_gui |
| `m` · `?` | hide the side panels · help |

The left column lists the units with their tags (dots), note (✎) and flag (★); the chips above it
filter by quality, full-session stability, area, flag, noted and tag, and the arrows step through
the matches only. **Sort** orders them by unit #, firing rate or stable trials. Tags live in
`settings.json` (`"tags": [...]`, at most nine, keys 1–9); reload the page after editing.

## electro_gui

`e` (or the electro_gui button) opens the unit at `http://127.0.0.1:8765/#s=<state>` in a tab named
`electro_gui`. When nothing answers there, the viewer starts it the way you would by hand:

```bash
cd ~/Code/electrogui && <phys-viewer python> -m electro_gui --no-browser --port 8765 --config-dir <data>/electro_gui
```

The Python is the first `phys-viewer` conda env under `~/miniconda3`, `~/miniforge3`, `~/miniconda`,
`~/mambaforge` or `~/anaconda3`; override with `--electro-gui-python` / `--electro-gui-repo`, and the
URL with `--electro-gui-url`. Pass `--apps-dashboard-url ''` when no apps dashboard runs. electro_gui
must see the same sessions: start it with `--data-root` pointing at the same root.

## Keeping it running

```bash
python3 -m result_viewer launchagent install -- --root ~/viewer_sessions   # macOS, com.hokyung.result-viewer
python3 -m result_viewer launchagent status
python3 -m result_viewer launchagent uninstall
```

The server listens on loopback only. To use it from a phone, publish it to your tailnet with
`tailscale serve --bg --https=8766 http://127.0.0.1:8766`; only the node's owner is let in.

## Layout

```
result_viewer/
  catalog.py      sessions, units and figures under the roots
  notebook.py     <sid>.json read-modify-write, <sid>.md rendering
  electro_gui.py  deep links, config-file mirror, liveness probe, starting electro_gui
  settings.py     data folder, settings.json
  server.py       HTTP API + figure files, local/tailnet access rules
  launchagent.py  com.hokyung.result-viewer
  cli.py          serve | rebuild | launchagent
  static/         index.html, app.css, app.js, eg-start.html/.js, icons, manifest (no build step)
tests/            unittest, fake session tree in tests/helpers.py
```
