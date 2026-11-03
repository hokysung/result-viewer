"""HTTP server: the page, the catalog API, notebook writes and the figure files.

It listens on loopback only.  Two kinds of request are served:

* **local** — a browser on this Mac: ``Host`` is a loopback name and no
  Tailscale identity header is present;
* **tailnet** — a device reaching this Mac through ``tailscale serve``
  (``https://<node>.ts.net:8766`` -> ``http://127.0.0.1:8766``): Tailscale adds
  ``Tailscale-User-Login``, which must be this node's owner.

Anything else (a foreign ``Host`` from DNS rebinding, another tailnet user, a
cross-site POST) gets 403.
"""
from __future__ import annotations

import csv
import gzip
import hmac
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__, electro_gui, session_log
from .notebook import host_tag, notebook_key
from .settings import load_settings

STATIC = Path(__file__).with_name("static")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                 ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json",
                 ".webmanifest": "application/manifest+json"}
# Paths browsers and iOS ask for at the root, whatever the page links to.
ROOT_FILES = {"/apple-touch-icon.png": "apple-touch-icon.png", "/apple-touch-icon-precomposed.png": "apple-touch-icon.png",
              "/favicon.ico": "favicon-32.png"}
_STATIC_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
MAX_BODY = 256 * 1024
TAILSCALE_CANDIDATES = ("tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
                        "/Applications/Tailscale.app/Contents/MacOS/Tailscale")


class Tailnet:
    """This node's MagicDNS name and owner login, from ``tailscale status --json``.

    Read lazily and retried every 30 s until found, so a server started at boot
    before Tailscale is up still learns them.  ``owner``/``names`` given on the
    command line win.
    """

    def __init__(self, owner=None, names=()):
        self._fixed_owner = owner
        self._extra = {n.lower().rstrip(".") for n in names if n}
        self._owner = owner
        self._dns = None
        self._checked = None  # time.monotonic() may start near 0 at process start, so no 0.0 sentinel
        self._lock = threading.Lock()

    def _read(self):
        exe = next(filter(None, (shutil.which(c) for c in TAILSCALE_CANDIDATES)), None)
        if not exe:
            print("tailnet: no tailscale CLI found; tailnet requests are refused", file=sys.stderr, flush=True)
            return None
        try:
            done = subprocess.run([exe, "status", "--json"], capture_output=True, text=True, timeout=5,
                                  stdin=subprocess.DEVNULL)
            data = json.loads(done.stdout)
            me = data["Self"]
            return me.get("DNSName", "").rstrip(".").lower() or None, data["User"][str(me["UserID"])]["LoginName"]
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            detail = locals().get("done")
            extra = f" (exit {detail.returncode}: {detail.stderr.strip()[:200] or detail.stdout.strip()[:200]})" if detail else ""
            print(f"tailnet: `{exe} status --json` failed: {exc!r}{extra}", file=sys.stderr, flush=True)
            return None

    def refresh(self, force=False):
        with self._lock:
            if self._dns and self._owner and not force:
                return
            if not force and self._checked is not None and time.monotonic() - self._checked < 30:
                return
            self._checked = time.monotonic()
            found = self._read()
            if found:
                self._dns = found[0]
                self._owner = self._fixed_owner or found[1]

    @property
    def owner(self):
        self.refresh()
        return self._owner

    @property
    def names(self):
        self.refresh()
        return self._extra | ({self._dns} if self._dns else set())


class App:
    def __init__(self, catalog, notebooks, data_dir, configs_root, tailnet, electro_gui_url=None,
                 electro_gui_remote_url=None, electro_gui_repo=None, electro_gui_python=None, apps_dashboard_url=None):
        self.catalog = catalog
        self.notebooks = notebooks
        self.data_dir = Path(data_dir)
        self.configs_root = Path(configs_root)
        self.tailnet = tailnet
        self.eg_override = {"local": electro_gui_url, "tailnet": electro_gui_remote_url}
        self._launcher = electro_gui.Launcher(None, self.configs_root, electro_gui_repo, electro_gui_python)
        self.apps_dashboard_url = apps_dashboard_url
        self.started = time.time()
        self._probe = {}
        self._found = (None, None, None)  # (when, configured URL, URLs found) of the last dashboard lookup

    def settings(self):
        return load_settings(self.data_dir)

    def electro_gui_url(self, where, settings=None):
        return self.electro_gui_target(where, settings)[0]

    def electro_gui_target(self, where, settings=None):
        """(URL the page opens, URL whose answer is the button's on/off dot).

        The command line's URL, else this Mac's electro_gui as the dashboard
        sees it — on this Mac the one running, on other devices its ``tailscale
        serve`` address, on/off from the loopback URL behind it — else
        settings.json's ``url`` / ``remote_url``.
        """
        settings = settings or self.settings()
        override = self.eg_override.get(where)
        if override is not None:
            return override, override
        found = self.found_electro_gui(settings["electro_gui"]["url"])
        if where == "local":
            url = found["local"] or settings["electro_gui"]["url"]
            return url, url
        if found["tailnet"]:
            return found["tailnet"], found["behind"]
        url = settings["electro_gui"]["remote_url"]
        return url, url

    def found_electro_gui(self, configured):
        """``electro_gui.pick``'s URLs from the apps dashboard (asked at most every 10 s), all None without it."""
        if not self.apps_dashboard_url:
            return electro_gui.pick(None)
        now = time.monotonic()
        when, asked, found = self._found
        if when is None or now - when > 10 or asked != configured:
            found = electro_gui.from_dashboard(self.apps_dashboard_url, configured)
            self._found = (now, configured, found)
        return found

    def electro_gui_running(self, url):
        now = time.monotonic()
        hit = self._probe.get(url)
        if hit and now - hit[0] < 2:
            return hit[1]
        running = electro_gui.probe(url)
        self._probe[url] = (now, running)
        return running

    def launcher(self, settings=None):
        """The launcher for this Mac's electro_gui URL (settings.json is re-read, so it can change)."""
        self._launcher.url = self.electro_gui_url("local", settings)
        return self._launcher

    def start_electro_gui(self):
        launcher = self.launcher()
        result = launcher.start()
        self._probe.pop(launcher.url, None)
        return result

    def timeline(self, sid):
        """The Session view: ``tables/session_timeline.json`` plus the rig dashboard's log on its clock."""
        found = self.catalog.sessions().get(sid)
        if found is None:
            raise LookupError(f"no session {sid}")
        session_dir = found[1] / sid
        settings = self.settings()
        try:
            with (session_dir / "tables" / "session_timeline.json").open("r", encoding="utf-8") as handle:
                timeline = json.load(handle)
        except FileNotFoundError:
            timeline = None
        stops = timeline["trials"]["stop"] if timeline else []
        log = session_log.session_log(session_dir, sid, stops, settings["dashboard_dirs"])
        return {"sid": sid, "timeline": timeline, "log": log,
                "plan": session_log.experiment_log(sid, settings["experiment_logs"])}

    def probe(self, sid):
        """The Probe view's session-level data: ``tables/mua_profile.csv`` (sort-free MUA per channel,
        phys-analysis ``session_viewer.profile``), shared by every sorting of the session; units and
        their ``prof_*`` classes come with the session itself."""
        found = self.catalog.sessions().get(sid)
        if found is None:
            raise LookupError(f"no session {sid}")
        path = found[1] / sid / "tables" / "mua_profile.csv"
        rows = []
        try:
            with path.open("r", encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    try:
                        rows.append({k: float(row[k]) for k in ("y_um", "mua_hz", "big_hz", "noise_uv")})
                    except (KeyError, TypeError, ValueError):
                        continue
        except FileNotFoundError:
            rows = None
        return {"sid": sid, "mua": rows}

    def snapshot(self, sid, unit_id, sorting=None):
        """What the catalog says about a unit of one sorting right now; None when the session is not mounted."""
        session = self.catalog.session(sid, sorting)
        if session is None:
            return None
        unit = next((u for u in session["units"] if u["id"] == unit_id), None)
        if unit is None:
            raise LookupError(f"unit {unit_id} is not in {sid}" + (f" ({sorting})" if sorting else ""))
        return {"quality": unit["quality"], "area": unit["area"], "peak_channel": unit["peak_channel"],
                "depth_um": unit["depth_um"], "figure": unit["figures"]["raster"]["name"]}


class HTTPError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"result-viewer/{__version__}"
        protocol_version = "HTTP/1.1"

        # ------------------------------------------------------------ plumbing
        def log_request(self, code="-", size="-"):
            try:
                quiet = int(code) < 400 and self.command != "POST"
            except (TypeError, ValueError):
                quiet = False
            if not quiet:
                super().log_request(code, size)

        def _send(self, status, body, ctype, headers=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            if (len(body) > 1024 and ctype.startswith(("application/json", "text/"))
                    and "gzip" in self.headers.get("Accept-Encoding", "")):
                body = gzip.compress(body, compresslevel=5)
                headers = dict(headers or {}, **{"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, status=200):
            self._send(status, json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
                       "application/json; charset=utf-8", {"Cache-Control": "no-store"})

        def _where(self):
            """``"local"`` or ``"tailnet"``; raises HTTPError(403) for anything else."""
            host = (urlsplit("//" + self.headers.get("Host", "")).hostname or "").lower()
            login = self.headers.get("Tailscale-User-Login")
            if host in LOOPBACK and login is None:
                return "local"
            if host not in LOOPBACK and host not in app.tailnet.names:
                raise HTTPError(403, "Unknown Host header.")
            owner = app.tailnet.owner
            if not owner or login is None or not hmac.compare_digest(login.encode(), owner.encode()):
                raise HTTPError(403, "Only this tailnet node's owner may use the viewer.")
            return "tailnet"

        def _check_post(self, where):
            origin = self.headers.get("Origin")
            if origin:
                allowed = LOOPBACK if where == "local" else (LOOPBACK | app.tailnet.names)
                if (urlsplit(origin).hostname or "").lower() not in allowed:
                    raise HTTPError(403, "Cross-site request refused.")
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                raise HTTPError(415, "Send JSON.")

        def _body(self):
            if self._raw is None:
                raise HTTPError(413, "Request too large.")
            try:
                data = json.loads(self._raw.decode("utf-8") or "{}")
            except (UnicodeDecodeError, ValueError):
                raise HTTPError(400, "Body is not JSON.")
            if not isinstance(data, dict):
                raise HTTPError(400, "Body must be a JSON object.")
            return data

        def _dispatch(self, method):
            try:
                where = self._where()
                url = urlsplit(self.path)
                query = {k: v[-1] for k, v in parse_qs(url.query).items()}
                if method == "POST":
                    self._check_post(where)
                    if url.path == "/api/note":
                        return self._json(self.post_note(self._body()))
                    if url.path == "/api/electro_gui/start":
                        if where != "local":
                            raise HTTPError(403, "electro_gui can be started only from the Mac running the viewer.")
                        return self._json(app.start_electro_gui())
                    raise HTTPError(404, "Not found.")
                path = url.path
                if path in ("/", "/index.html"):
                    return self.static("index.html")
                if path in ROOT_FILES:
                    return self.static(ROOT_FILES[path])
                if path.startswith("/static/"):
                    return self.static(path[len("/static/"):])
                if path.startswith("/fig/"):
                    return self.figure(path[len("/fig/"):])
                route = {"/api/health": self.health, "/api/config": self.config, "/api/sessions": self.sessions,
                         "/api/session": self.session, "/api/notebook": self.notebook,
                         "/api/electro_gui": self.electro_gui_status,
                         "/api/timeline": lambda q, w: app.timeline(self._sid(q)[0]),
                         "/api/probe": lambda q, w: app.probe(self._sid(q)[0])}.get(path)
                if route is None:
                    raise HTTPError(404, "Not found.")
                return self._json(route(query, where))
            except HTTPError as exc:
                self._json({"error": str(exc)}, exc.status)
            except (ValueError, LookupError) as exc:
                self._json({"error": str(exc)}, 400 if isinstance(exc, ValueError) else 404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:  # keep serving; the log has the traceback
                self.log_error("%s %s failed: %r", method, self.path, exc)
                import traceback
                traceback.print_exc(file=sys.stderr)
                try:
                    self._json({"error": f"server error: {exc}"}, 500)
                except OSError:
                    pass

        def do_GET(self):
            self._dispatch("GET")

        def do_HEAD(self):
            self._dispatch("GET")

        def do_POST(self):
            # Read the body before any check: a refused request must not leave it on a keep-alive connection.
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if 0 <= length <= MAX_BODY:
                self._raw = self.rfile.read(length)
            else:
                self._raw = None
                self.close_connection = True
            self._dispatch("POST")

        # -------------------------------------------------------------- files
        def static(self, name):
            if not _STATIC_NAME.match(name):
                raise HTTPError(404, "Not found.")
            path = STATIC / name
            if not path.is_file():
                raise HTTPError(404, "Not found.")
            self._send(200, path.read_bytes(), CONTENT_TYPES.get(path.suffix, "application/octet-stream"),
                       {"Cache-Control": "no-cache"})

        def figure(self, rest):
            index, _, rel = unquote(rest).partition("/")
            path = app.catalog.resolve_figure(index, rel)
            if path is None:
                raise HTTPError(404, "No such figure.")
            st = path.stat()
            etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
            headers = {"ETag": etag, "Cache-Control": "private, max-age=300"}
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send(200, path.read_bytes(), CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream"), headers)

        # ---------------------------------------------------------------- API
        def health(self, query, where):
            return {"ok": True, "version": __version__, "pid": os.getpid(), "started": app.started}

        def config(self, query, where):
            settings = app.settings()
            url = app.electro_gui_url(where, settings)
            launcher = app.launcher(settings)
            args = (launcher.command() if launcher.python and launcher.port()
                    else ["python", "-m", "electro_gui", *launcher.config_args()])
            by_hand = f"cd {shlex.quote(str(launcher.repo))} && " + " ".join(shlex.quote(a) for a in args)
            return {"version": __version__, "host": host_tag(), "where": where, "tags": settings["tags"],
                    "electro_gui": {"url": url, "launch": by_hand,
                                    "can_start": where == "local" and bool(url) and launcher.problem() is None},
                    "roots": [str(r) for r in app.catalog.roots],
                    "paths": {"data": str(app.data_dir), "notes": str(app.notebooks.notes_dir),
                              "configs": str(app.configs_root)}}

        def _sortings(self, sid, noted):
            """The catalog's sortings of ``sid``, each with its notebook's noted / flagged counts."""
            none = {"noted": 0, "flagged": 0}
            return [dict(s, **noted.get(notebook_key(sid, s["name"]), none)) for s in app.catalog.sortings(sid)]

        def sessions(self, query, where):
            noted = app.notebooks.summary()
            out = []
            for sid in app.catalog.sessions():
                session = app.catalog.session(sid)
                if session is not None:
                    # n_units / noted / flagged: the default sorting, as before; "sortings": every sorting's
                    out.append({"id": sid, "root": session["root"], "n_units": len(session["units"]),
                                **noted.get(sid, {"noted": 0, "flagged": 0}), "sortings": self._sortings(sid, noted)})
            return {"sessions": out}

        def _sid(self, query):
            """``(sid, sorting)`` from ``?sid=&sorting=``; no or an empty ``sorting`` is the default sorting."""
            sid = query.get("sid", "")
            sorting = query.get("sorting") or None
            notebook_key(sid, sorting)  # validates both
            return sid, sorting

        def session(self, query, where):
            sid, sorting = self._sid(query)
            session = app.catalog.session(sid, sorting)
            if session is None:
                raise HTTPError(404, f"{sid} is not under any results root.")
            return {"session": session, "sortings": self._sortings(sid, app.notebooks.summary()),
                    **self.notebook(query, where)}

        def notebook(self, query, where):
            sid, sorting = self._sid(query)
            path = app.notebooks.path(sid, sorting)
            mtime = app.notebooks.mtime(sid, sorting)
            return {"notebook": app.notebooks.load(sid, sorting), "sorting": sorting,
                    "mtime": str(mtime) if mtime else None,
                    "conflicts": app.notebooks.conflicts(sid, sorting),
                    "files": {"json": str(path), "markdown": str(path.with_suffix(".md")),
                              "configs": str(electro_gui.config_folder(app.configs_root, sid, sorting))}}

        def electro_gui_status(self, query, where):
            url, behind = app.electro_gui_target(where)
            out = {"url": url, "running": bool(url) and app.electro_gui_running(behind)}
            if where == "local":
                out["launch"] = app.launcher().state()
            return out

        def post_note(self, body):
            sid = body.get("sid", "")
            sorting = body.get("sorting") or None
            app.notebooks.path(sid, sorting)  # validates both
            try:
                unit_id = int(body.get("unit"))
            except (TypeError, ValueError):
                raise HTTPError(400, "unit must be an integer")
            changes = {k: body[k] for k in ("note", "tags", "flag") if k in body}
            snapshot = app.snapshot(sid, unit_id, sorting)
            notebook, entry = app.notebooks.update(sid, unit_id, changes, snapshot, app.settings()["tags"], sorting)
            warning = None
            try:
                electro_gui.sync_unit(app.configs_root, sid, unit_id, entry, sorting)
            except OSError as exc:
                warning = f"electro_gui config not written: {exc}"
            mtime = app.notebooks.mtime(sid, sorting)
            return {"entry": entry, "notebook": notebook, "sorting": sorting, "mtime": str(mtime) if mtime else None, "warning": warning}

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(app, host="127.0.0.1", port=8766):
    if host not in LOOPBACK:
        raise ValueError("result-viewer listens on loopback only; reach it from other devices with tailscale serve.")
    return Server((host, port), make_handler(app))
