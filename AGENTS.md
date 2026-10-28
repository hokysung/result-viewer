# Agent notes for result-viewer

- Python 3.8+ standard library only (the default `python3` may be 3.8): no `match`,
  no `Path.is_relative_to`, no `str.removeprefix`, no runtime `list[int]` annotations.
- The session roots are read-only. Never write, move or delete anything under a `--root`;
  phys-analysis `python -m session_viewer build` and the sync script own them.
- Notes live in the data dir (`~/result-viewer-data` by default), never in this repo. Test against a
  scratch `--data-dir`, never the real notes folder.
- The session layout and figure names are phys-analysis `session_viewer` (`export.py`, `rasters.py`
  `unit_stem`); the electro_gui contracts are `electro_gui/static/core.js` `encodeState` (deep links),
  `electro_gui/configs.py` (config files) and `electro_gui/cli.py` (the launch flags) in
  ~/Code/electrogui. Change `catalog.py` / `electro_gui.py` with those in view.
- The server listens on loopback only; tailnet access goes through `tailscale serve` and the
  owner check in `server.py`. Do not add a LAN/0.0.0.0 mode.
- Run `python3 -m unittest discover -s tests -t .` before committing.
