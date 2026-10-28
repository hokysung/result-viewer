import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from result_viewer.catalog import Catalog
from result_viewer.notebook import Notebooks
from result_viewer.server import App, Tailnet, make_server
from tests.helpers import SID, make_session

OWNER = "me@example.com"
NODE = "node.tail0000.ts.net"


class FixedTailnet(Tailnet):
    def _read(self):  # never call the real tailscale in tests
        return None


class TailnetTest(unittest.TestCase):
    def test_first_lookup_runs_at_once_and_failures_retry_later(self):
        calls = []

        class Stub(Tailnet):
            def _read(self):
                calls.append(1)
                return None if len(calls) == 1 else ("node.tail0000.ts.net", OWNER)

        t = Stub()
        self.assertEqual((t.names, t.owner), (set(), None))  # first call looked, found nothing
        self.assertEqual(len(calls), 1)  # and does not look again within 30 s
        t.refresh(force=True)
        self.assertEqual((t.names, t.owner), ({"node.tail0000.ts.net"}, OWNER))
        self.assertEqual(len(calls), 2)  # found: no further lookups


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        make_session(base / "results")
        data = base / "data"
        data.mkdir()
        cls.data = data
        app = App(Catalog([base / "results"]), Notebooks(data), data, data / "electro_gui",
                  FixedTailnet(OWNER, [NODE]), electro_gui_url="http://127.0.0.1:9",
                  electro_gui_repo=base / "no-electrogui")  # never start the real electro_gui here
        cls.server = make_server(app, "127.0.0.1", 0)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, host=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        hdrs = {"Host": host or f"127.0.0.1:{self.port}"}
        if body is not None:
            hdrs["Content-Type"] = "application/json"
            body = json.dumps(body)
        hdrs.update(headers or {})
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp, data

    def get_json(self, path, **kw):
        resp, data = self.request("GET", path, **kw)
        return resp.status, (json.loads(data) if data and resp.getheader("Content-Type", "").startswith("application/json") else None)

    def test_local_and_tailnet_access(self):
        status, cfg = self.get_json("/api/config")
        self.assertEqual((status, cfg["where"]), (200, "local"))
        self.assertEqual(cfg["electro_gui"]["url"], "http://127.0.0.1:9")
        self.assertEqual(self.get_json("/api/config", host="evil.example:80")[0], 403)
        self.assertEqual(self.get_json("/api/config", host=f"{NODE}:8766")[0], 403)
        self.assertEqual(self.get_json("/api/config", host=f"{NODE}:8766",
                                       headers={"Tailscale-User-Login": "someone@else"})[0], 403)
        self.assertEqual(self.get_json("/api/config", host="evil.example",
                                       headers={"Tailscale-User-Login": OWNER})[0], 403)
        status, cfg = self.get_json("/api/config", host=f"{NODE}:8766", headers={"Tailscale-User-Login": OWNER})
        self.assertEqual((status, cfg["where"]), (200, "tailnet"))
        self.assertEqual(cfg["electro_gui"]["url"], "")  # no remote_url configured
        status, cfg = self.get_json("/api/config", headers={"Tailscale-User-Login": OWNER})  # Host rewritten by a proxy
        self.assertEqual((status, cfg["where"]), (200, "tailnet"))

    def test_page_and_static(self):
        resp, data = self.request("GET", "/")
        self.assertEqual(resp.status, 200)
        self.assertIn(b"/static/app.js", data)
        self.assertEqual(self.request("GET", "/static/app.js")[0].status, 200)
        self.assertEqual(self.request("GET", "/static/../server.py")[0].status, 404)

    def test_home_screen_icon_and_manifest(self):
        _, page = self.request("GET", "/")
        self.assertIn(b'rel="apple-touch-icon" href="/static/apple-touch-icon.png"', page)
        self.assertIn(b'rel="manifest" href="/static/manifest.webmanifest"', page)
        for path in ("/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/static/apple-touch-icon.png",
                     "/favicon.ico", "/static/favicon.svg"):
            resp, data = self.request("GET", path)
            self.assertEqual(resp.status, 200, path)
            self.assertTrue(resp.getheader("Content-Type").startswith("image/"), path)
        resp, data = self.request("GET", "/static/manifest.webmanifest")
        self.assertEqual(resp.getheader("Content-Type"), "application/manifest+json")
        manifest = json.loads(data)
        self.assertEqual((manifest["short_name"], manifest["display"]), ("Rasters", "standalone"))
        for icon in manifest["icons"]:
            self.assertEqual(self.request("GET", icon["src"])[0].status, 200, icon["src"])

    def test_sessions_and_session(self):
        status, body = self.get_json("/api/sessions")
        self.assertEqual(body["sessions"][0]["id"], SID)
        status, body = self.get_json(f"/api/session?sid={SID}")
        self.assertEqual(status, 200)
        self.assertEqual([u["id"] for u in body["session"]["units"]], [1, 2, 3, 4])
        self.assertEqual(self.get_json("/api/session?sid=None_20260101")[0], 404)
        self.assertEqual(self.get_json("/api/session?sid=../x")[0], 400)

    def test_figures(self):
        _, body = self.get_json(f"/api/session?sid={SID}")
        url = body["session"]["units"][0]["figures"]["raster"]["url"]
        resp, data = self.request("GET", url)
        self.assertEqual((resp.status, resp.getheader("Content-Type")), (200, "image/png"))
        etag = resp.getheader("ETag")
        self.assertEqual(self.request("GET", url, headers={"If-None-Match": etag})[0].status, 304)
        self.assertEqual(self.request("GET", f"/fig/0/{SID}/../../data/settings.json")[0].status, 404)
        self.assertEqual(self.request("GET", "/fig/0/%2e%2e/%2e%2e/etc/passwd.png")[0].status, 404)

    def test_note_round_trip_and_post_guards(self):
        body = {"sid": SID, "unit": 2, "note": "relabel check", "tags": ["noise"], "flag": True}
        resp, _ = self.request("POST", "/api/note", body, headers={"Origin": "http://evil.example"})
        self.assertEqual(resp.status, 403)
        resp, _ = self.request("POST", "/api/note", body, headers={"Content-Type": "text/plain"})
        self.assertEqual(resp.status, 415)
        resp, data = self.request("POST", "/api/note", body, headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(resp.status, 200, data)
        entry = json.loads(data)["entry"]
        self.assertEqual((entry["quality"], entry["area"], entry["peak_channel"]), ("noise", "pmd", 140))
        self.assertTrue((self.data / "notes" / f"{SID}.json").exists())
        self.assertTrue((self.data / "electro_gui" / SID / "electro_gui_configs" / "unit_0002.json").exists())
        resp, _ = self.request("POST", "/api/note", {"sid": SID, "unit": 99, "flag": True})
        self.assertEqual(resp.status, 404)
        resp, _ = self.request("POST", "/api/note", {"sid": SID, "unit": "x", "flag": True})
        self.assertEqual(resp.status, 400)
        status, nb = self.get_json(f"/api/notebook?sid={SID}")
        self.assertEqual(nb["notebook"]["units"]["2"]["note"], "relabel check")
        resp, _ = self.request("POST", "/api/note", {"sid": SID, "unit": 2, "note": "", "tags": [], "flag": False},
                               host=f"{NODE}:8766", headers={"Tailscale-User-Login": OWNER, "Origin": f"https://{NODE}:8766"})
        self.assertEqual(resp.status, 200)
        self.assertFalse((self.data / "electro_gui" / SID / "electro_gui_configs" / "unit_0002.json").exists())

    def test_refused_post_leaves_the_connection_usable(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/api/note", body=json.dumps({"sid": SID, "unit": 1, "flag": True}),
                     headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        resp = conn.getresponse()
        resp.read()
        self.assertEqual(resp.status, 403)
        conn.request("GET", "/api/health")
        resp = conn.getresponse()
        self.assertEqual((resp.status, json.loads(resp.read())["ok"]), (200, True))
        conn.close()

    def test_electro_gui_status_when_down(self):
        status, body = self.get_json("/api/electro_gui")
        self.assertEqual((body["url"], body["running"]), ("http://127.0.0.1:9", False))
        self.assertFalse(body["launch"]["can_start"])
        self.assertIn("no electro_gui package", body["launch"]["problem"])
        self.assertFalse(self.get_json("/api/config")[1]["electro_gui"]["can_start"])

    def test_electro_gui_start_is_local_only(self):
        resp, data = self.request("POST", "/api/electro_gui/start", {}, host=f"{NODE}:8766",
                                  headers={"Tailscale-User-Login": OWNER, "Origin": f"https://{NODE}:8766"})
        self.assertEqual(resp.status, 403)
        resp, data = self.request("POST", "/api/electro_gui/start", {})
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(data)["started"], False)


if __name__ == "__main__":
    unittest.main()
