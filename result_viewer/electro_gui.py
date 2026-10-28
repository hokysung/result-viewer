"""Hand units to electro_gui (~/Code/electrogui, github.com/hokysung/electrogui).

Four ways, none of which needs a change to electro_gui:

* **Deep link.**  electro_gui keeps its whole view in the address bar as
  ``#s=<base64url(UTF-8 JSON state)>`` (``static/core.js`` ``encodeState``) and
  fills every missing key with its defaults, so ``{"session", "unit"}`` opens a
  unit.  Its unit picker lists SUA and MUA only by default (``unitQ``); a link
  to any other unit widens that list so the unit stays selectable.
* **Finding it.**  ``from_dashboard`` asks this Mac's apps dashboard which
  electro_gui is up, whatever its port, so the link goes to the one running,
  and where ``tailscale serve`` publishes it, for the link on other devices.
* **Config files.**  Every noted unit is mirrored to
  ``<data>/electro_gui/<sid>/electro_gui_configs/unit_NNNN.json`` in electro_gui's
  config-file format (``electro_gui/configs.py``).  Launch electro_gui with
  ``--config-dir <data>/electro_gui`` and the notes appear under Views ->
  Config files, one section per session.  Files this module did not write
  (no ``"generator": "result-viewer"``) are never changed or removed.
* **Starting it.**  When "open in electro_gui" finds nothing answering on this
  Mac, ``Launcher`` starts it from the electrogui checkout, the way it is
  started by hand, with the config folder above added.
"""
from __future__ import annotations

import base64
import json
import re
import socket
import subprocess
import threading
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .notebook import unit_heading, utc_now, write_atomic

GENERATOR = "result-viewer"
NESTED = "electro_gui_configs"
DEFAULT_QUALITIES = ("sua", "mua")
DEFAULT_REPO = "~/Code/electrogui"
ENV_NAME = "phys-viewer"
PYTHON_CANDIDATES = tuple(f"~/{base}/envs/{ENV_NAME}/bin/python"
                          for base in ("miniconda3", "miniforge3", "miniconda", "mambaforge", "anaconda3"))
START_LOG = "~/Library/Logs/electro_gui.log"
LOOPBACK = ("127.0.0.1", "localhost", "::1")
DASHBOARD_URL = "http://127.0.0.1:8790"
_RUNS_ELECTRO_GUI = re.compile(r"(?:^|\s)-m\s+electro_gui(?:\s|$)|(?:^|/)electro-gui(?:\s|$)")


def view_state(sid, unit_id, quality=None):
    state = {"session": sid, "unit": int(unit_id)}
    if quality and quality not in DEFAULT_QUALITIES:
        state["unitQ"] = list(DEFAULT_QUALITIES) + [quality]
    return state


def encode_state(state):
    """electro_gui's ``encodeState``: base64url of the UTF-8 JSON, no padding."""
    raw = json.dumps(state, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def deep_link(base_url, sid, unit_id, quality=None):
    """``base_url`` may carry electro_gui's ``?token=`` (a --lan server); the state goes in the fragment."""
    parts = urlsplit(base_url)
    fragment = "s=" + encode_state(view_state(sid, unit_id, quality))
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, fragment))


def config_path(configs_root, sid, unit_id):
    return Path(configs_root) / sid / NESTED / f"unit_{int(unit_id):04d}.json"


def build_config(sid, entry):
    note = (entry.get("note") or "").strip()
    first = note.splitlines()[0] if note else ""
    tags = entry.get("tags") or []
    hint = " · ".join(x for x in (", ".join(tags), first[:160]) if x)
    return {"electro_gui_config": 1,
            "title": unit_heading(entry) + (" ★" if entry.get("flag") else ""),
            "hint": hint,
            "group": f"Notes · {sid}",
            "slide": int(entry["unit_id"]),
            "note": note,
            "state": view_state(sid, entry["unit_id"], entry.get("quality")),
            "generator": GENERATOR,
            "tags": tags,
            "flag": bool(entry.get("flag"))}


def _ours(path):
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            return json.load(handle).get("generator") == GENERATOR
    except (OSError, ValueError, AttributeError):
        return False


def sync_unit(configs_root, sid, unit_id, entry):
    """Write (or, when ``entry`` is None, remove) this unit's config file."""
    path = config_path(configs_root, sid, unit_id)
    if entry is None:
        if path.exists() and _ours(path):
            path.unlink()
        return None
    if path.exists() and not _ours(path):
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(path, json.dumps(build_config(sid, entry), indent=1, ensure_ascii=False) + "\n")
    return path


def sync_session(configs_root, sid, notebook):
    """Mirror a whole notebook: write every entry, remove our files for units no longer noted."""
    keep = set()
    for entry in notebook.get("units", {}).values():
        written = sync_unit(configs_root, sid, entry["unit_id"], entry)
        if written:
            keep.add(written.name)
    folder = Path(configs_root) / sid / NESTED
    if folder.is_dir():
        for path in folder.glob("unit_*.json"):
            if path.name not in keep and _ours(path):
                path.unlink()
    return sorted(keep)


def probe(base_url, timeout=2.0):
    """Is electro_gui up at ``base_url``?

    Any HTTP answer counts (a ``--token`` server answers 403) except a proxy's
    502-504 (``tailscale serve`` with nothing behind it); so does a connection
    that opens but answers slowly, which is electro_gui busy loading a session.
    """
    parts = urlsplit(base_url)
    try:
        with urllib.request.urlopen(urlunsplit((parts.scheme, parts.netloc, "/api/health", "", "")), timeout=timeout):
            return True
    except urllib.error.HTTPError as exc:
        return exc.code not in (502, 503, 504)
    except socket.timeout:
        return True
    except (OSError, ValueError):
        return False


def from_dashboard(dashboard_url, prefer=None, timeout=3.0):
    """Where the apps dashboard sees electro_gui on this Mac: ``pick``'s URLs.

    Reads the dashboard's ``/api/apps`` (github.com/chenruidong/apps-dashboard),
    a scan of this Mac's listening processes, LaunchAgents and ``tailscale
    serve`` routes, so an electro_gui started by hand on any port is found; see
    ``pick`` for which one.  All None when the dashboard does not answer.
    """
    parts = urlsplit(dashboard_url)
    try:
        with urllib.request.urlopen(urlunsplit((parts.scheme, parts.netloc, "/api/apps", "", "")), timeout=timeout) as resp:
            apps = json.load(resp).get("apps")
    except (OSError, ValueError, AttributeError):
        apps = None
    return pick(apps, prefer)


def pick(apps, prefer=None):
    """From the dashboard's ``apps``: ``{"local", "tailnet", "behind"}`` URLs of this Mac's electro_gui.

    ``local`` is one that is up on a loopback URL: the one on ``prefer``'s port
    wins, then the most recently started.  ``tailnet`` is the ``tailscale
    serve`` address of one, up or not (one that is up first, then the same
    order), and ``behind`` the loopback URL it proxies, whose answer says
    whether it is up.  Each is None when there is no such app.

    An app counts when it is this Mac's (the dashboard also lists its peers'
    apps, whose loopback URLs mean nothing here) and its process or its
    LaunchAgent runs ``-m electro_gui`` (or ``electro-gui``), or it is
    registered as ``electro_gui``.
    """
    try:
        want = urlsplit(prefer or "").port
    except ValueError:
        want = None
    up, served = [], []
    for app in apps if isinstance(apps, list) else ():
        if not isinstance(app, dict) or app.get("peer"):
            continue
        process = app.get("process") or {}
        commands = (process.get("command"), (app.get("launchd") or {}).get("program"))
        if app.get("id") != "electro_gui" and not any(_RUNS_ELECTRO_GUI.search(c or "") for c in commands):
            continue
        url = ((app.get("local") or {}).get("url") or "").rstrip("/")
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError:
            continue
        if parts.scheme != "http" or parts.hostname not in LOOPBACK or not port:
            continue
        rank = (app.get("status") == "up", port == want, process.get("started") or "")
        if rank[0]:
            up.append((rank, url))
        address = _served_at(app.get("routes"), port)
        if address:
            served.append((rank, address, url))
    tailnet = max(served) if served else (None, None, None)
    return {"local": max(up)[1] if up else None, "tailnet": tailnet[1], "behind": tailnet[2]}


def _served_at(routes, port):
    """The address of the dashboard ``routes`` entry (``tailscale serve``) that proxies to loopback ``port``, or None."""
    for route in routes if isinstance(routes, list) else ():
        if not isinstance(route, dict) or route.get("kind") != "proxy" or route.get("stale"):
            continue
        try:
            target = urlsplit(route.get("target") or "")
            if target.hostname in LOOPBACK and target.port == port and route.get("url"):
                return route["url"]
        except ValueError:
            continue
    return None


def presentation_dir():
    """electro_gui has no default config folder; only the notebook's configs are passed."""
    return None


class Launcher:
    """Start electro_gui on this Mac when "open in electro_gui" finds nothing answering.

    Runs ``<python> -m electro_gui --no-browser --port <port of url> --config-dir
    <presentation_dir> --config-dir <configs_root>`` in the electrogui checkout
    (its defaults otherwise, so caches and findings land where a hand-started
    electro_gui puts them), in a session of its own so it outlives a viewer
    restart, with its output appended to ``~/Library/Logs/electro_gui.log``.
    ``--config-dir`` replaces electro_gui's default folder rather than adding to
    it, so that default is passed too (``config_dirs`` replaces it here).  Only a
    loopback ``url`` is started; the Python is the first ``phys-viewer``
    environment found unless one is given.
    """

    def __init__(self, url, configs_root, repo=None, python=None, log_path=START_LOG, config_dirs=None):
        self.url = url or ""
        self.configs_root = Path(configs_root)
        self.repo = Path(repo or DEFAULT_REPO).expanduser()
        if python:
            self.python = Path(python).expanduser()
        else:
            self.python = next((Path(c).expanduser() for c in PYTHON_CANDIDATES if Path(c).expanduser().is_file()), None)
        self.log_path = Path(log_path).expanduser()
        if config_dirs is None:
            config_dirs = [d for d in (presentation_dir(),) if d is not None]
        self.config_dirs = [Path(d) for d in config_dirs] + [self.configs_root]
        self._proc = None
        self._lock = threading.Lock()

    def port(self):
        parts = urlsplit(self.url)
        if parts.hostname not in LOOPBACK:
            return None
        return parts.port or (443 if parts.scheme == "https" else 80)

    def problem(self):
        """Why electro_gui cannot be started from here, or None."""
        if not self.url:
            return "no electro_gui URL is configured"
        if self.port() is None:
            return f"{self.url} is not on this Mac"
        if not (self.repo / "electro_gui" / "__main__.py").is_file():
            return f"no electro_gui package in {self.repo}"
        if self.python is None or not self.python.is_file():
            return f"no {ENV_NAME} Python found (pass --electro-gui-python)"
        return None

    def config_args(self):
        return [arg for folder in self.config_dirs for arg in ("--config-dir", str(folder))]

    def command(self):
        return [str(self.python), "-m", "electro_gui", "--no-browser", "--port", str(self.port()), *self.config_args()]

    def state(self):
        proc = self._proc
        out = {"can_start": self.problem() is None, "problem": self.problem(), "log": str(self.log_path)}
        if proc is not None:
            code = proc.poll()
            out.update(pid=proc.pid, starting=code is None, exit_code=code)
        return out

    def start(self):
        """Start electro_gui unless it answers already or our last start is still coming up."""
        with self._lock:
            problem = self.problem()
            if problem:
                return {"started": False, "error": problem}
            if probe(self.url, timeout=1.0):
                return {"started": False, "running": True}
            if self._proc is not None and self._proc.poll() is None:
                return {"started": False, "starting": True, "pid": self._proc.pid, "log": str(self.log_path)}
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as log:
                log.write(f"\n--- {utc_now()} started by result-viewer in {self.repo}: {' '.join(self.command())}\n")
                log.flush()
                self._proc = subprocess.Popen(self.command(), cwd=str(self.repo), stdin=subprocess.DEVNULL,
                                              stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            return {"started": True, "pid": self._proc.pid, "log": str(self.log_path)}
