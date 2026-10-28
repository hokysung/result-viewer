"""A per-user LaunchAgent that keeps ``serve --no-browser`` running (RunAtLoad + KeepAlive).

The plist runs this checkout with the Python that installed it, so reinstall
after moving the repository or changing Python.  Logs go to
``~/Library/Logs/result-viewer.log``.
"""
from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path

LABEL = "com.hokyung.result-viewer"
PLIST = Path("~/Library/LaunchAgents").expanduser() / f"{LABEL}.plist"
LOG = Path("~/Library/Logs/result-viewer.log").expanduser()
REPO = Path(__file__).resolve().parent.parent


def _domain():
    return f"gui/{os.getuid()}"


def _launchctl(*args, check=False):
    return subprocess.run(["launchctl", *args], capture_output=True, text=True, check=check)


def plist(serve_args):
    return {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "result_viewer", "serve", "--no-browser", *serve_args],
        "WorkingDirectory": str(REPO),
        "EnvironmentVariables": {"PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                                 "PYTHONUNBUFFERED": "1"},
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": str(LOG),
        "StandardErrorPath": str(LOG),
    }


def install(serve_args):
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with PLIST.open("wb") as handle:
        plistlib.dump(plist(serve_args), handle)
    _launchctl("bootout", f"{_domain()}/{LABEL}")
    result = _launchctl("bootstrap", _domain(), str(PLIST))
    if result.returncode != 0:
        print(result.stderr.strip() or result.stdout.strip(), file=sys.stderr)
        return result.returncode
    print(f"installed {PLIST}\n  runs: {' '.join(plist(serve_args)['ProgramArguments'])}\n  log:  {LOG}")
    return 0


def uninstall():
    _launchctl("bootout", f"{_domain()}/{LABEL}")
    if PLIST.exists():
        PLIST.unlink()
        print(f"removed {PLIST}")
    else:
        print(f"{PLIST} was not installed")
    return 0


def status():
    result = _launchctl("print", f"{_domain()}/{LABEL}")
    if result.returncode != 0:
        print(f"{LABEL} is not loaded")
        return 1
    keep = ("state =", "pid =", "last exit code", "program =", "runs =")
    for line in result.stdout.splitlines():
        if any(k in line for k in keep):
            print(line.strip())
    return 0


def run(action, serve_args):
    if action == "install":
        return install(serve_args)
    if action == "uninstall":
        return uninstall()
    return status()
