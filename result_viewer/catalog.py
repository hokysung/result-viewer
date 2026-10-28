"""Find sessions, units and per-unit figures under a viewer-sessions root.

A root holds one directory per session, as phys-analysis ``python -m session_viewer build`` writes it:

    <root>/<sid>/session.h5
    <root>/<sid>/figures/unit_rasters/unit_NNNN_<q>_<tag>_<area>_rates_raster.png
    <root>/<sid>/figures/<kind>/unit_NNNN_<q>_<tag>_<area>.png
    <root>/<sid>/figures/<kind>_unit_NNNN_<q>_<tag>_<area>.png
    <root>/<sid>/figures/unit_summaries/unit_NNNN_<q>.jpg
    <root>/<sid>/tables/units.csv

``<sid>`` is ``<Subject>_<YYYYMMDD>`` and ``<tag>`` is the same string.  A unit is
one unit id of ``session.h5``; its rate raster defines it.  ``tables/units.csv``
(written with ``session.h5``) gives each unit's current label, rate, stable
trials, peak channel and depth.  A raster whose file name carries another label
than the table's is shown as relabelled.
"""
from __future__ import annotations

import csv
import json
import os
import re
import threading
from pathlib import Path

DEFAULT_ROOTS = tuple(p for p in os.environ.get("SESSION_VIEWER_ROOTS", "").split(os.pathsep) if p) or (
    os.path.expanduser("~/viewer_sessions"),)

RASTER_DIR = ("figures", "unit_rasters")
FIGURES_DIR = ("figures",)
SUMMARIES_DIR = ("figures", "unit_summaries")
TABLES_DIR = ("tables",)
STABILITY_TABLE = "units.csv"
SESSION_FILE = "session.h5"
RASTER_SUFFIX = "_rates_raster.png"
IMAGE_EXTS = (".png", ".jpg", ".jpeg")
# Figure folders that hold no per-unit figures, or none of the raster's kind.
SKIP_FIGURE_DIRS = {"unit_rasters", "unit_summaries"}

RASTER_KIND = "raster"
SORTER_KIND = "sorter_summary"
KIND_LABELS = {RASTER_KIND: "Raster", SORTER_KIND: "Sorter summary"}

_SESSION_ID_RE = re.compile(r"^(?P<subject>[A-Za-z0-9-]+)_(?P<date>[0-9]{8})$")
_SLUG = r"[a-z0-9-]+"


def _sanitize(text):
    return re.sub(r"[^A-Za-z0-9]+", "-", str(text).strip()).strip("-")


def session_tag(session_id):
    """``Nielsen_20261015`` -> ``Nielsen_20261015`` (session_viewer.rasters.unit_stem); anything else sanitized."""
    match = _SESSION_ID_RE.match(session_id or "")
    if match:
        return f"{_sanitize(match['subject'])}_{re.sub(r'[^0-9]', '', match['date'])}"
    return _sanitize(session_id) or "unknown-session"


def kind_label(kind):
    """``selectivity_classes_onset_movelocked_peri`` -> ``Selectivity · onset movelocked peri``."""
    if kind in KIND_LABELS:
        return KIND_LABELS[kind]
    for prefix, label in KIND_LABELS.items():
        if kind.startswith(prefix + "_"):
            return f"{label} · {kind[len(prefix) + 1:].replace('_', ' ')}"
    return kind.replace("__", " · ").replace("_", " ").capitalize()


class _Patterns:
    """File-name patterns for one session tag."""

    def __init__(self, sid):
        tag = re.escape(session_tag(sid))
        stem = rf"unit_(?P<id>\d+)(?:_(?P<q>{_SLUG}))?_{tag}(?:_(?P<area>{_SLUG}))?"
        self.raster = re.compile(rf"^{stem}{re.escape(RASTER_SUFFIX)}$")
        self.figure = re.compile(rf"^{stem}\.(?:png|jpe?g)$")
        self.prefixed = re.compile(rf"^(?P<kind>[A-Za-z0-9_-]+?)_{stem}\.(?:png|jpe?g)$")
        self.summary = re.compile(rf"^unit_(?P<id>\d+)(?:_(?P<q>{_SLUG}))?\.(?:png|jpe?g)$")


def _scan(directory):
    """``[(name, DirEntry)]`` for the files in ``directory``; empty when it is missing."""
    try:
        with os.scandir(directory) as it:
            return [(e.name, e) for e in it if not e.name.startswith(".") and e.is_file()]
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return []


def _mtime(entry):
    try:
        return entry.stat().st_mtime
    except OSError:
        return 0.0


def _signature(session_dir):
    """Directory mtimes that change whenever a figure is added or removed."""
    dirs = [session_dir.joinpath(*RASTER_DIR), session_dir.joinpath(*FIGURES_DIR), session_dir.joinpath(*SUMMARIES_DIR),
            session_dir.joinpath(*TABLES_DIR, STABILITY_TABLE)]
    try:
        with os.scandir(session_dir.joinpath(*FIGURES_DIR)) as it:
            dirs += [Path(e.path) for e in it if e.is_dir() and not e.name.startswith(".")]
    except OSError:
        pass
    out = []
    for d in dirs:
        try:
            out.append((str(d), d.stat().st_mtime_ns))
        except OSError:
            out.append((str(d), None))
    return tuple(out)


def _current_quality(session_dir, unit_id):
    path = session_dir.joinpath(*TABLES_DIR, f"unit_{unit_id:04d}_rates_summary.json")
    try:
        with path.open("r", encoding="utf-8") as handle:
            quality = json.load(handle).get("unit", {}).get("quality")
    except (OSError, ValueError, AttributeError):
        return None
    if quality is None:
        return None
    return str(quality).strip().lower() or None


def _stability(session_dir):
    """``{unit_id: {quality, rate_hz, n_stable, n_trials, full_stable}}``, or None without a table.

    ``tables/units.csv`` has one row per unit of ``session.h5`` and is written
    with it, so its labels are current even when a raster file name is older.
    A unit missing from it is not in the current export.  ``full_stable``:
    stable on every completed trial (``n_stable_trials == n_completed_trials``).
    """
    path = session_dir.joinpath(*TABLES_DIR, STABILITY_TABLE)
    try:
        handle = path.open("r", encoding="utf-8", newline="")
    except OSError:
        return None
    out = {}
    with handle:
        for row in csv.DictReader(handle):
            try:
                uid = int(float(row["unit_id"]))
            except (KeyError, TypeError, ValueError):
                continue
            rate, n_stable, n_trials = (_number(row.get(k)) for k in ("mean_rate_hz", "n_stable_trials", "n_completed_trials"))
            out[uid] = {"quality": (row.get("quality") or "").strip().lower() or None,
                        "rate_hz": round(rate, 3) if isinstance(rate, float) else rate,
                        "n_stable": n_stable, "n_trials": n_trials,
                        "full_stable": bool(n_trials) and n_stable == n_trials}
    return out


def _channels(session_dir, sid):
    """``{unit_id: {"peak_channel", "depth_um"}}`` from ``tables/units.csv``.

    Only when the table is at least as new as ``session.h5``: an older one can
    describe an earlier export of the units, and a wrong channel is worse than none.
    """
    table = session_dir.joinpath(*TABLES_DIR, STABILITY_TABLE)
    try:
        if table.stat().st_mtime < session_dir.joinpath(SESSION_FILE).stat().st_mtime:
            return {}
        with table.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or "unit_id" not in reader.fieldnames or "peak_channel" not in reader.fieldnames:
                return {}
            out = {}
            for row in reader:
                try:
                    uid = int(float(row["unit_id"]))
                except (TypeError, ValueError):
                    continue
                out[uid] = {"peak_channel": _number(row.get("peak_channel")), "depth_um": _number(row.get("depth_um"))}
            return out
    except OSError:
        return {}


def _number(text):
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return int(value) if value.is_integer() else value


def _pick(candidates, quality):
    """The figure labelled ``quality``, else the newest one; ``candidates`` are ``(q, DirEntry)``."""
    if len(candidates) == 1:
        return candidates[0]
    pool = [c for c in candidates if quality and c[0] == quality] or candidates
    return pool[0] if len(pool) == 1 else max(pool, key=lambda c: _mtime(c[1]))


def scan_session(root_index, root, sid):
    """Every unit of one session with its figures, in unit-id order."""
    session_dir = Path(root) / sid
    pat = _Patterns(sid)

    rasters = {}
    for name, entry in _scan(session_dir.joinpath(*RASTER_DIR)):
        m = pat.raster.match(name)
        if m:
            rasters.setdefault(int(m["id"]), []).append((m["q"], m["area"], entry))

    stability = _stability(session_dir)
    units = {}
    for uid, found in rasters.items():
        row = stability.get(uid) if stability else None
        if row and row["quality"]:
            current = row["quality"]
        elif len(found) > 1:  # relabelled, no stability table: the rates summary names the label
            current = _current_quality(session_dir, uid)
        else:
            current = None
        file_q, entry = _pick([(fq, e) for fq, _a, e in found], current)
        q = current or file_q
        area = next(a for _q, a, e in found if e is entry)
        units[uid] = {"id": uid, "quality": q, "area": area, "peak_channel": None, "depth_um": None,
                      "rate_hz": row["rate_hz"] if row else None, "n_stable": row["n_stable"] if row else None,
                      "n_trials": row["n_trials"] if row else None, "full_stable": bool(row and row["full_stable"]),
                      # False: the session's current units table has no such unit (a figure from an older build)
                      "in_units": None if stability is None else row is not None,
                      "relabelled_from": sorted({qq for qq, _a, _e in found if qq and qq != q}),
                      "figures": {RASTER_KIND: _figure(root_index, root, entry, file_q, q)}}

    def attach(kind, uid, cands):
        unit = units.get(uid)
        if unit is not None:
            fq, entry = _pick(cands, unit["quality"])
            unit["figures"][kind] = _figure(root_index, root, entry, fq, unit["quality"])

    grouped = {}
    figures_dir = session_dir.joinpath(*FIGURES_DIR)
    try:
        with os.scandir(figures_dir) as it:
            subdirs = sorted(e.name for e in it if e.is_dir() and not e.name.startswith(".") and e.name not in SKIP_FIGURE_DIRS)
    except OSError:
        subdirs = []
    for kind in subdirs:
        for name, entry in _scan(figures_dir / kind):
            m = pat.figure.match(name)
            if m:
                grouped.setdefault((kind, int(m["id"])), []).append((m["q"], entry))
    for name, entry in _scan(figures_dir):
        m = pat.prefixed.match(name)
        if m and name.lower().endswith(IMAGE_EXTS):
            grouped.setdefault((m["kind"], int(m["id"])), []).append((m["q"], entry))
    for name, entry in _scan(session_dir.joinpath(*SUMMARIES_DIR)):
        m = pat.summary.match(name)
        if m:
            grouped.setdefault((SORTER_KIND, int(m["id"])), []).append((m["q"], entry))
    for (kind, uid), cands in grouped.items():
        attach(kind, uid, cands)

    for uid, info in _channels(session_dir, sid).items():
        if uid in units:
            units[uid].update(info)

    kinds = {}
    for unit in units.values():
        for kind in unit["figures"]:
            kinds[kind] = kinds.get(kind, 0) + 1
    order = [RASTER_KIND] + ([SORTER_KIND] if SORTER_KIND in kinds else [])
    order += sorted(k for k in kinds if k not in order)
    return {"id": sid, "root": str(root), "root_index": root_index,
            "views": [{"kind": k, "label": kind_label(k), "n": kinds[k]} for k in order if k in kinds],
            "units": [units[u] for u in sorted(units)]}


def _figure(root_index, root, entry, figure_quality, unit_quality):
    rel = Path(entry.path).relative_to(root).as_posix()
    out = {"url": f"/fig/{root_index}/{rel}", "name": entry.name}
    if figure_quality and unit_quality and figure_quality != unit_quality:
        out["label_in_figure"] = figure_quality
    return out


class Catalog:
    """Sessions across result roots; the first root holding a session wins."""

    def __init__(self, roots):
        self.roots = [Path(r).expanduser() for r in roots]
        self._lock = threading.Lock()
        self._cache = {}

    def sessions(self):
        seen = {}
        for index, root in enumerate(self.roots):
            try:
                with os.scandir(root) as it:
                    names = [e.name for e in it if e.is_dir() and not e.name.startswith(".")]
            except OSError:
                continue
            for sid in sorted(names):
                if sid not in seen and root.joinpath(sid, *RASTER_DIR).is_dir():
                    seen[sid] = (index, root)
        return seen

    def session(self, sid):
        found = self.sessions().get(sid)
        if found is None:
            return None
        index, root = found
        sig = _signature(root / sid)
        with self._lock:
            hit = self._cache.get(sid)
            if hit and hit[0] == sig and hit[1]["root_index"] == index:
                return hit[1]
        scanned = scan_session(index, root, sid)
        with self._lock:
            self._cache[sid] = (sig, scanned)
        return scanned

    def resolve_figure(self, root_index, rel):
        """The file under root ``root_index`` named by ``rel``, or None if it escapes the root or is not an image."""
        try:
            root = self.roots[int(root_index)].resolve()
        except (IndexError, ValueError, OSError):
            return None
        if not rel.lower().endswith(IMAGE_EXTS):
            return None
        path = (root / rel).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return None
        return path if path.is_file() else None
