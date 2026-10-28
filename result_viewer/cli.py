"""Command line: ``python -m result_viewer [serve|rebuild|launchagent] ...``."""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from . import __version__, electro_gui, launchagent
from .catalog import DEFAULT_ROOTS, Catalog
from .notebook import Notebooks, render_markdown, write_atomic
from .settings import find_data_dir, load_settings

DEFAULT_PORT = 8766


def _add_serve_args(parser):
    parser.add_argument("--root", action="append", metavar="DIR",
                        help="viewer-sessions root holding <Subject>_<YYYYMMDD>/ (repeatable; first match wins; "
                             f"default: {', '.join(DEFAULT_ROOTS)})")
    parser.add_argument("--data-dir", metavar="DIR",
                        help="notes/settings folder (default: $RESULT_VIEWER_DATA or "
                             "~/result-viewer-data)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"loopback port (default {DEFAULT_PORT})")
    parser.add_argument("--host", default="127.0.0.1", help="loopback address to bind (default 127.0.0.1)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser tab")
    parser.add_argument("--electro-gui-url", metavar="URL",
                        help="electro_gui for this Mac (overrides the apps dashboard and settings.json electro_gui.url)")
    parser.add_argument("--apps-dashboard-url", metavar="URL", default=electro_gui.DASHBOARD_URL,
                        help="apps dashboard asked which electro_gui runs on this Mac, on any port "
                             f"(default {electro_gui.DASHBOARD_URL}; '' to use settings.json electro_gui.url only)")
    parser.add_argument("--electro-gui-remote-url", metavar="URL",
                        help="electro_gui for tailnet devices (overrides the apps dashboard and settings.json electro_gui.remote_url)")
    parser.add_argument("--electro-gui-repo", metavar="DIR",
                        help="electrogui checkout to start electro_gui from (default ~/code/electrogui)")
    parser.add_argument("--electro-gui-python", metavar="PATH",
                        help="Python to start electro_gui with (default: the first phys-viewer env found)")
    parser.add_argument("--owner", metavar="LOGIN",
                        help="tailnet login allowed through tailscale serve (default: this node's owner)")
    parser.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                        help="extra Host name accepted for tailnet requests (default: this node's MagicDNS name)")


def _data_dir(args):
    data_dir = find_data_dir(args.data_dir)
    if data_dir is None:
        sys.exit("No notes folder; pass --data-dir or set RESULT_VIEWER_DATA.")
    if not data_dir.parent.is_dir():
        sys.exit(f"{data_dir.parent} does not exist; pass --data-dir to use another folder.")
    data_dir.mkdir(exist_ok=True)
    return data_dir


def cmd_serve(args):
    from .server import App, Tailnet, make_server

    data_dir = _data_dir(args)
    load_settings(data_dir)
    app = App(Catalog(args.root or DEFAULT_ROOTS), Notebooks(data_dir), data_dir, data_dir / "electro_gui",
              Tailnet(args.owner, args.allow_host), args.electro_gui_url, args.electro_gui_remote_url,
              args.electro_gui_repo, args.electro_gui_python, args.apps_dashboard_url)
    try:
        server = make_server(app, args.host, args.port)
    except ValueError as exc:
        sys.exit(str(exc))
    except OSError as exc:
        sys.exit(f"Cannot listen on {args.host}:{args.port}: {exc.strerror or exc} (already running? try --port)")
    url = f"http://{args.host}:{server.server_address[1]}/"
    mounted = [str(r) for r in app.catalog.roots if r.is_dir()]
    print(f"result-viewer {__version__} on {url}", flush=True)
    print(f"  results: {', '.join(mounted) or 'none mounted of ' + ', '.join(map(str, app.catalog.roots))}", flush=True)
    print(f"  notes:   {app.notebooks.notes_dir}", flush=True)
    if not args.no_browser:
        threading.Timer(0.3, webbrowser.open, (url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def cmd_rebuild(args):
    """Regenerate every <sid>.md and electro_gui config from the JSON notebooks."""
    data_dir = _data_dir(args)
    tags = load_settings(data_dir)["tags"]
    notebooks = Notebooks(data_dir)
    for sid in sorted(notebooks.summary()):
        notebook = notebooks.load(sid)
        write_atomic(notebooks.path(sid).with_suffix(".md"), render_markdown(notebook, tags))
        written = electro_gui.sync_session(data_dir / "electro_gui", sid, notebook)
        print(f"{sid}: {len(notebook['units'])} units, {len(written)} electro_gui configs")
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0].startswith("-") and argv[0] not in ("-h", "--help", "--version"):
        argv.insert(0, "serve")
    parser = argparse.ArgumentParser(prog="result-viewer", description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="run the viewer (the default)")
    _add_serve_args(serve)
    rebuild = sub.add_parser("rebuild", help="regenerate the Markdown notebooks and electro_gui configs")
    rebuild.add_argument("--data-dir", metavar="DIR")
    agent = sub.add_parser("launchagent", help="keep the viewer running with a macOS LaunchAgent",
                           description="install writes ~/Library/LaunchAgents/%s.plist that runs "
                                       "`serve --no-browser` with the options after `--`." % launchagent.LABEL)
    agent.add_argument("action", choices=("install", "uninstall", "status"))
    agent.add_argument("serve_args", nargs=argparse.REMAINDER, help="options for serve, after --")
    args = parser.parse_args(argv)
    if args.cmd == "serve":
        return cmd_serve(args)
    if args.cmd == "rebuild":
        return cmd_rebuild(args)
    extra = [a for a in args.serve_args if a != "--"]
    return launchagent.run(args.action, extra)
