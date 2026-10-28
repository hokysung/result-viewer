"""Per-session unit notebooks kept in the data dir (a synced folder if shared between machines).

``<data>/notes/<sid>.json`` is the source of truth::

    {"schema": "result-viewer.notebook/1", "session_id": "sub-Ravel_ses-2026_09_15",
     "updated_at_utc": "...", "units": {"4": {"unit_id": 4, "note": "...", "tags": ["interesting"],
     "flag": true, "quality": "noise", "area": "acc", "peak_channel": 22, "depth_um": 220,
     "figure": "unit_0004_noise_Ravel_20260915_acc_rates_raster.png",
     "created_at_utc": "...", "updated_at_utc": "...", "updated_on": "imac"}}}

A unit is keyed by its NWB unit id.  Unit ids do not survive a re-sort, so each
entry also records what the unit looked like when it was noted (quality, area,
peak channel, the raster's file name): enough to find it again, or to notice it
changed.  ``<sid>.md`` is regenerated from the JSON on every save, for reading
anywhere; edits made to it are overwritten.

Every save re-reads the file and changes only the one unit, so notes taken on
two machines merge as long as the folder has synced between them.  A sync tool's
"conflicted copy" files are reported, never merged or removed.
"""
from __future__ import annotations

import json
import os
import re
import socket
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "result-viewer.notebook/1"
MAX_NOTE = 20000
MAX_TAG = 40
SNAPSHOT_KEYS = ("quality", "area", "peak_channel", "depth_um", "figure")
_SID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]*$")


def host_tag():
    """This machine's thread-handoff host tag, else its short host name."""
    try:
        tag = Path("~/.config/thread-handoff/host").expanduser().read_text(encoding="utf-8").strip()
    except OSError:
        tag = ""
    return tag or os.environ.get("HOST_TAG") or socket.gethostname().split(".")[0]


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def valid_sid(sid):
    return isinstance(sid, str) and bool(_SID_RE.match(sid)) and len(sid) <= 200


def empty_notebook(sid):
    return {"schema": SCHEMA, "session_id": sid, "updated_at_utc": None, "units": {}}


def write_atomic(path, text):
    """Write ``text`` next to ``path`` and rename it into place, so readers never see half a file."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def clean_tags(tags, order=()):
    """Unique, stripped tag names, in the settings' order first."""
    if not isinstance(tags, (list, tuple)):
        raise ValueError("tags must be a list")
    seen = []
    for tag in tags:
        if not isinstance(tag, str):
            raise ValueError("every tag must be a string")
        tag = tag.strip()
        if not tag or len(tag) > MAX_TAG:
            raise ValueError(f"a tag must be 1-{MAX_TAG} characters")
        if tag not in seen:
            seen.append(tag)
    rank = {t: i for i, t in enumerate(order)}
    return sorted(seen, key=lambda t: (rank.get(t, len(rank)), seen.index(t)))


def is_empty(entry):
    return not (entry.get("note") or "").strip() and not entry.get("tags") and not entry.get("flag")


class Notebooks:
    """Read and change the notebooks in ``<data_dir>/notes``."""

    def __init__(self, data_dir, render_markdown=True):
        self.data_dir = Path(data_dir)
        self.notes_dir = self.data_dir / "notes"
        self.render_markdown = render_markdown
        self._lock = threading.Lock()

    def path(self, sid):
        if not valid_sid(sid):
            raise ValueError(f"not a session id: {sid!r}")
        return self.notes_dir / f"{sid}.json"

    def mtime(self, sid):
        try:
            return self.path(sid).stat().st_mtime_ns
        except OSError:
            return None

    def load(self, sid):
        path = self.path(sid)
        try:
            with path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            return empty_notebook(sid)
        if not isinstance(data, dict) or not isinstance(data.get("units"), dict):
            raise ValueError(f"{path} is not a result-viewer notebook")
        return data

    def conflicts(self, sid):
        """Dropbox conflicted copies of this session's notebook (``<sid> (… conflicted copy …).json``)."""
        prefix = f"{sid} ("
        try:
            names = os.listdir(self.notes_dir)
        except OSError:
            return []
        return sorted(n for n in names if n.startswith(prefix) and "conflicted copy" in n and n.endswith(".json"))

    def summary(self):
        """``{sid: {"noted": n, "flagged": n}}`` for every notebook on disk."""
        out = {}
        try:
            names = sorted(os.listdir(self.notes_dir))
        except OSError:
            return out
        for name in names:
            sid = name[:-5] if name.endswith(".json") else None
            if not sid or not valid_sid(sid):
                continue
            try:
                units = self.load(sid)["units"]
            except (OSError, ValueError):
                continue
            out[sid] = {"noted": len(units), "flagged": sum(1 for e in units.values() if e.get("flag"))}
        return out

    def update(self, sid, unit_id, changes, snapshot=None, tag_order=()):
        """Apply ``changes`` (any of note / tags / flag) to one unit; returns ``(notebook, entry or None)``.

        ``snapshot`` (quality, area, peak_channel, depth_um, figure) comes from the
        catalog, never from the client; it is kept from the last save when the
        results are not mounted.  An entry with no note, tags or flag is removed.
        """
        unit_id = int(unit_id)
        patch = {}
        if "note" in changes:
            note = changes["note"]
            if not isinstance(note, str):
                raise ValueError("note must be a string")
            if len(note) > MAX_NOTE:
                raise ValueError(f"note is longer than {MAX_NOTE} characters")
            patch["note"] = note.replace("\r\n", "\n").replace("\r", "\n")
        if "tags" in changes:
            patch["tags"] = clean_tags(changes["tags"], tag_order)
        if "flag" in changes:
            if not isinstance(changes["flag"], bool):
                raise ValueError("flag must be true or false")
            patch["flag"] = changes["flag"]
        if not patch:
            raise ValueError("nothing to change (expected note, tags or flag)")

        with self._lock:
            self.notes_dir.mkdir(parents=True, exist_ok=True)
            notebook = self.load(sid)
            key = str(unit_id)
            now = utc_now()
            previous = notebook["units"].get(key) or {}
            entry = {"unit_id": unit_id, "note": "", "tags": [], "flag": False}
            entry.update({k: v for k, v in previous.items() if k not in ("unit_id",)})
            entry.update(patch)
            for k in SNAPSHOT_KEYS:
                if snapshot and snapshot.get(k) is not None:
                    entry[k] = snapshot[k]
            if is_empty(entry):
                if key not in notebook["units"]:
                    return notebook, None
                del notebook["units"][key]
                entry = None
            else:
                entry.setdefault("created_at_utc", now)
                entry["updated_at_utc"] = now
                entry["updated_on"] = host_tag()
                notebook["units"][key] = entry
            notebook["schema"] = SCHEMA
            notebook["session_id"] = sid
            notebook["updated_at_utc"] = now
            notebook["units"] = {k: notebook["units"][k] for k in sorted(notebook["units"], key=_unit_order)}
            write_atomic(self.path(sid), json.dumps(notebook, indent=1, ensure_ascii=False) + "\n")
            if self.render_markdown:
                write_atomic(self.path(sid).with_suffix(".md"), render_markdown(notebook, tag_order))
            return notebook, entry


def _unit_order(key):
    try:
        return (0, int(key), "")
    except ValueError:
        return (1, 0, key)


def _local(ts):
    """``2026-10-08T19:20:00+00:00`` -> ``2026-10-08 15:20 EDT`` on this machine."""
    if not ts:
        return ""
    try:
        return datetime.fromisoformat(ts).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    except ValueError:
        return ts


def unit_heading(entry):
    parts = [f"Unit {entry['unit_id']}"]
    if entry.get("quality"):
        parts.append(str(entry["quality"]).upper())
    if entry.get("area"):
        parts.append(str(entry["area"]).upper())
    if entry.get("peak_channel") is not None:
        parts.append(f"ch {entry['peak_channel']}")
    return " · ".join(parts)


def render_markdown(notebook, tag_order=()):
    """The readable notebook: an index by flag and tag, then one section per unit."""
    sid = notebook.get("session_id", "")
    units = [notebook["units"][k] for k in sorted(notebook["units"], key=_unit_order)]
    lines = [f"# Unit notebook · {sid}", "",
             f"<!-- Generated by result-viewer from {sid}.json on every save. "
             "Take notes in the viewer: edits to this file are overwritten. -->", ""]
    flagged = [e for e in units if e.get("flag")]
    lines.append(f"{len(units)} units noted · {len(flagged)} flagged · updated {_local(notebook.get('updated_at_utc'))}")
    lines.append("")
    if flagged:
        lines.append("- **Flagged:** " + ", ".join(str(e["unit_id"]) for e in flagged))
    present = []
    for e in units:
        for t in e.get("tags") or []:
            if t not in present:
                present.append(t)
    rank = {t: i for i, t in enumerate(tag_order)}
    for tag in sorted(present, key=lambda t: (rank.get(t, len(rank)), present.index(t))):
        lines.append(f"- **{tag}:** " + ", ".join(str(e["unit_id"]) for e in units if tag in (e.get("tags") or [])))
    if flagged or present:
        lines.append("")
    for e in units:
        lines.append(f"## {unit_heading(e)}{' ★' if e.get('flag') else ''}")
        lines.append("")
        if e.get("tags"):
            lines.append(" ".join(f"`{t}`" for t in e["tags"]))
            lines.append("")
        note = (e.get("note") or "").strip()
        if note:
            lines.append(note)
            lines.append("")
        meta = [m for m in (e.get("figure"), f"updated {_local(e.get('updated_at_utc'))}"
                            + (f" on {e['updated_on']}" if e.get("updated_on") else "")) if m]
        lines.append(f"<sub>{' · '.join(meta)}</sub>")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
