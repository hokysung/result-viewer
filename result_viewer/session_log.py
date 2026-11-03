"""The rig dashboard's session log, put on the recording's clock for the Session view.

The MWorks session dashboard (NHP-behavior-SERA) writes ``session_log.jsonl`` into its folder for every
session: notes, marks, protocol starts and stops, probe depths, setting changes, calibrations, each with
the wall clock (``epoch``) and, while the task runs, the dashboard's trial count (``after_trial``).

``tables/session_timeline.json`` (phys-analysis ``session_viewer.timeline``) gives every trial's stop on the
imec clock.  The log is placed on that clock by one offset, ``imec = epoch + offset``, found by voting:
entries logged at a trial end (``set``, ``warn``) each propose ``stop[n - 1 + k] - epoch`` for small
shifts ``k`` (the dashboard counts trials the parser can drop), and the offset most of them agree on
(0.5 s bins) wins.  It is checked against the "Recording ON" mark (the recording starts within seconds of
it); if the vote is weak or disagrees, the mark alone sets the offset.  Precision: about a second, enough
for a timeline, not for spike alignment.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

DEFAULT_DASHBOARD_DIRS = (
    "~/Library/CloudStorage/GoogleDrive-hokyung@mit.edu/Other computers/My Mac Pro/Dashboard",
    "~/Documents/MWorks/Dashboard",
)
LOG_NAME = "session_log.jsonl"
SHIFTS = range(-25, 6)
BIN_S = 0.5
MIN_VOTES = 8
MARK_TOLERANCE_S = 120.0
#: Log kinds the Session view keeps; the rest (UI replays, uploads, setup bookkeeping) are dropped.
KEEP = {"note", "mark", "control", "phys", "set", "warn", "calibration", "manual_stim", "probe",
        "ask", "answer", "todo", "todo_done", "todo_addressed"}

_SID = re.compile(r"^(?P<subject>[A-Za-z0-9-]+)_(?P<date>\d{8})$")


def find_logs(session_dir: Path, sid: str, dashboard_dirs) -> list[Path]:
    """The export's own copy (``tables/session_log.jsonl``), else the dashboard folders of that date."""
    own = Path(session_dir) / "tables" / LOG_NAME
    if own.is_file():
        return [own]
    match = _SID.match(sid)
    if not match:
        return []
    subject, date = match["subject"], match["date"]
    found = []
    for root in dashboard_dirs:
        root = Path(root).expanduser()
        if not root.is_dir():
            continue
        try:
            folders = [p for p in root.iterdir() if p.is_dir()]
        except OSError:
            continue
        for folder in folders:
            name = folder.name
            if subject in name and (name.startswith(date + "-") or date in name.replace("_", "-").split("-")):
                log = folder / LOG_NAME
                if log.is_file():
                    found.append(log)
        if found:
            break
    return sorted(found)


def read_entries(paths) -> list[dict]:
    out = []
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(entry, dict) and entry.get("kind") in KEEP:
                        entry["_source"] = Path(path).parent.name
                        out.append(entry)
        except OSError:
            continue
    out.sort(key=lambda e: (e.get("epoch") or 0, e.get("id") or 0))
    return out


def _finite(x):
    return isinstance(x, (int, float)) and x == x and abs(x) != float("inf")


def align(entries, stops) -> dict:
    """``{"offset", "method", "votes", "n"}``: imec = epoch + offset (offset None when nothing aligns)."""
    votes = {}
    anchored = [(e["after_trial"], e["epoch"]) for e in entries
                if e.get("kind") in ("set", "warn") and isinstance(e.get("after_trial"), int) and _finite(e.get("epoch"))]
    for n, epoch in anchored:
        seen = set()
        for k in SHIFTS:
            j = n - 1 + k
            if 0 <= j < len(stops) and _finite(stops[j]):
                b = round((stops[j] - epoch) / BIN_S)
                if b not in seen:  # one vote per entry and bin
                    seen.add(b)
                    votes[b] = votes.get(b, 0) + 1
    marks = [e["epoch"] for e in entries if e.get("kind") == "mark" and str(e.get("text", "")).strip().lower() == "recording on"
             and _finite(e.get("epoch"))]
    mark_offset = -marks[0] if marks else None
    result = {"offset": None, "method": "none", "votes": 0, "n": len(anchored)}
    if votes:
        best = max(votes, key=lambda b: (votes[b], -b))
        offset = best * BIN_S
        agrees = mark_offset is None or abs(offset - mark_offset) <= MARK_TOLERANCE_S
        if votes[best] >= MIN_VOTES and agrees:
            result.update(offset=offset, method="trial ends", votes=votes[best])
            return result
    if mark_offset is not None:
        result.update(offset=mark_offset, method="Recording ON mark")
    return result


def _clean(entry, offset):
    out = {k: v for k, v in entry.items() if not k.startswith("_") and k not in ("in_mwk2", "id", "carried", "tid")
           and isinstance(v, (str, int, float, bool, type(None)))}
    epoch = entry.get("epoch")
    out["t"] = round(epoch + offset, 2) if offset is not None and _finite(epoch) else None
    out["source"] = entry.get("_source")
    return out


def protocol_runs(entries) -> list[dict]:
    """Protocol runs from the ``control`` entries: start (with protocol) to the next start or stop."""
    runs, current = [], None
    for e in entries:
        if e.get("kind") != "control":
            continue
        action = e.get("action")
        if action == "start":
            if current is not None:
                current["t1"] = e["t"]
                runs.append(current)
            current = {"protocol": e.get("protocol") or "?", "run": e.get("run"), "t0": e["t"], "t1": None,
                       "wall0": e.get("wall"), "trial0": e.get("after_trial")}
        elif action == "stop" and current is not None:
            current["t1"] = e["t"]
            current["wall1"] = e.get("wall")
            current["trial1"] = e.get("after_trial")
            runs.append(current)
            current = None
    if current is not None:
        runs.append(current)
    return runs


def experiment_log(sid, folder, max_chars=60000):
    """phys-context's archived session plan / log for this session (``<date>-<Subject>.md``, ``<date>.md``)."""
    match = _SID.match(sid or "")
    if not match or not folder:
        return None
    root = Path(folder).expanduser()
    for name in (f"{match['date']}-{match['subject']}.md", f"{match['date']}.md", f"{match['date']}.txt"):
        path = root / name
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        return {"path": str(path), "text": text[:max_chars], "truncated": len(text) > max_chars}
    return None


def session_log(session_dir, sid, stops, dashboard_dirs=DEFAULT_DASHBOARD_DIRS) -> dict:
    """Everything the Session view shows from the dashboard: aligned entries, protocol runs, depths."""
    paths = find_logs(Path(session_dir), sid, dashboard_dirs)
    entries = read_entries(paths)
    alignment = align(entries, stops)
    cleaned = [_clean(e, alignment["offset"]) for e in entries]
    depths = [{"t": e["t"], "probe": e.get("probe"), "depth": e.get("depth")} for e in cleaned
              if e.get("kind") == "phys" and _finite(e.get("depth")) and e.get("probe")]
    return {"sources": [str(p) for p in paths], "alignment": alignment, "entries": cleaned,
            "runs": protocol_runs(cleaned), "depths": depths}
