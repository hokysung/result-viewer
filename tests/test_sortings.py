"""Other sortings of a session: <sid>/sortings/<name>/ exports, their notebooks and electro_gui links."""
import base64
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from result_viewer import electro_gui
from result_viewer.catalog import Catalog, sorting_label
from result_viewer.h5meta import session_meta
from result_viewer.notebook import Notebooks, notebook_key, split_key
from result_viewer.server import App, Tailnet, make_server
from result_viewer.settings import DEFAULTS
from tests.helpers import META_MIXED, META_SINGLE, SID, make_sortings, touch

TAGS = DEFAULTS["tags"]


class MetaTest(unittest.TestCase):
    def test_reads_meta_from_both_hdf5_formats(self):
        self.assertEqual([s["sorting"] for s in session_meta(META_SINGLE)["streams"]], ["ms5_lar_v8"])
        self.assertEqual([s["sorting"] for s in session_meta(META_MIXED)["streams"]], ["ms5_lar_v8", "ms5_lar_v6"])

    def test_unreadable_files_give_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty = touch(Path(tmp) / "empty.h5", b"")
            junk = touch(Path(tmp) / "junk.h5", b"\x89HDF\r\n\x1a\n" + b"\xff" * 200)
            self.assertIsNone(session_meta(empty))
            self.assertIsNone(session_meta(junk))
            self.assertIsNone(session_meta(Path(tmp) / "missing.h5"))

    def test_label(self):
        self.assertEqual(sorting_label({"streams": [{"stream": "imec0", "sorting": "a"}, {"stream": "imec1", "sorting": "a"}]}), "a")
        self.assertEqual(sorting_label(session_meta(META_MIXED)), "imec0 ms5_lar_v8 · imec1 ms5_lar_v6")
        self.assertIsNone(sorting_label(None))
        self.assertIsNone(sorting_label({"streams": []}))


class CatalogSortingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "results"
        make_sortings(self.root)
        self.catalog = Catalog([self.root])

    def tearDown(self):
        self.tmp.cleanup()

    def test_lists_default_then_alternates_with_a_session_h5(self):
        self.assertEqual(self.catalog.sortings(SID), [
            {"name": None, "label": "ms5_lar_v8 (default)", "is_default": True, "n_units": 4},
            {"name": "ks4_nwb", "label": "ks4_nwb", "is_default": False, "n_units": None},
            {"name": "ms5_lar_v6", "label": "imec0 ms5_lar_v8 · imec1 ms5_lar_v6", "is_default": False, "n_units": 2},
        ])
        self.assertEqual(self.catalog.sortings("Nope_20260101"), [])

    def test_sortings_folder_is_not_a_session_or_a_figure_kind(self):
        self.assertEqual(list(self.catalog.sessions()), [SID])
        default = self.catalog.session(SID)
        self.assertIsNone(default["sorting"])
        self.assertNotIn("sortings", [v["kind"] for v in default["views"]])
        self.assertNotIn("connectivity", [v["kind"] for v in default["views"]])  # only the alternate has it
        # even inside figures/, a "sortings" folder is never a figure kind
        touch(self.root / SID / "figures" / "sortings" / "unit_0001_sua_Test_20260102_acc.png")
        rescanned = Catalog([self.root]).session(SID)
        self.assertNotIn("sortings", [v["kind"] for v in rescanned["views"]])
        self.assertEqual(sorted(u["id"] for u in rescanned["units"]), [1, 2, 3, 4])

    def test_default_is_unchanged(self):
        default = self.catalog.session(SID)
        units = {u["id"]: u for u in default["units"]}
        self.assertEqual(sorted(units), [1, 2, 3, 4])
        self.assertEqual(units[1]["quality"], "sua")
        self.assertEqual(units[1]["figures"]["raster"]["url"],
                         "/fig/0/Test_20260102/figures/unit_rasters/unit_0001_sua_Test_20260102_acc_rates_raster.png")

    def test_alternate_units_and_figures(self):
        alt = self.catalog.session(SID, "ms5_lar_v6")
        self.assertEqual(alt["sorting"], "ms5_lar_v6")
        units = {u["id"]: u for u in alt["units"]}
        self.assertEqual(sorted(units), [1, 7])
        self.assertEqual((units[1]["quality"], units[1]["area"], units[1]["peak_channel"]), ("mua", "pmd", 300))
        self.assertEqual((units[7]["rate_hz"], units[7]["full_stable"]), (9.0, True))
        self.assertEqual([v["kind"] for v in alt["views"]], ["raster", "connectivity"])
        url = units[7]["figures"]["connectivity"]["url"]
        self.assertEqual(url, "/fig/0/Test_20260102/sortings/ms5_lar_v6/figures/connectivity/unit_0007_sua_Test_20260102_acc.png")
        index, _, rel = url[len("/fig/"):].partition("/")
        self.assertTrue(self.catalog.resolve_figure(index, rel).is_file())

    def test_unknown_or_bad_sortings(self):
        with self.assertRaises(LookupError):
            self.catalog.session(SID, "broken")  # no session.h5
        with self.assertRaises(LookupError):
            self.catalog.session(SID, "nope")
        for bad in ("../x", "..", "", ".hidden", "a/b"):
            with self.assertRaises((LookupError, ValueError)):
                self.catalog.session(SID, bad)

    def test_cache_is_per_sorting(self):
        self.assertEqual(len(self.catalog.session(SID)["units"]), 4)
        self.assertEqual(len(self.catalog.session(SID, "ms5_lar_v6")["units"]), 2)
        self.assertEqual(len(self.catalog.session(SID, "ks4_nwb")["units"]), 1)
        self.assertEqual(len(self.catalog.session(SID)["units"]), 4)


class NotebookKeyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.nb = Notebooks(self.data)

    def tearDown(self):
        self.tmp.cleanup()

    def test_keys(self):
        self.assertEqual(notebook_key(SID), SID)
        self.assertEqual(notebook_key(SID, "ms5_lar_v6"), f"{SID}@ms5_lar_v6")
        self.assertEqual(split_key(f"{SID}@ms5_lar_v6"), (SID, "ms5_lar_v6"))
        self.assertEqual(split_key(SID), (SID, None))
        for bad in (f"{SID}@", f"{SID}@../x", "@x", f"{SID}@a@b"):
            with self.assertRaises(ValueError):
                split_key(bad)

    def test_default_keeps_its_path(self):
        self.assertEqual(self.nb.path(SID), self.data / "notes" / f"{SID}.json")
        self.assertEqual(self.nb.path(SID, "ms5_lar_v6"), self.data / "notes" / f"{SID}@ms5_lar_v6.json")

    def test_notes_on_one_sortings_unit_never_show_on_another(self):
        self.nb.update(SID, 1, {"note": "default unit 1"}, None, TAGS)
        self.nb.update(SID, 1, {"note": "v6 unit 1", "flag": True}, None, TAGS, sorting="ms5_lar_v6")
        self.assertEqual(self.nb.load(SID)["units"]["1"]["note"], "default unit 1")
        self.assertFalse(self.nb.load(SID)["units"]["1"]["flag"])
        v6 = self.nb.load(SID, "ms5_lar_v6")
        self.assertEqual((v6["units"]["1"]["note"], v6["sorting"]), ("v6 unit 1", "ms5_lar_v6"))
        self.assertEqual(self.nb.load(SID, "ks4_nwb")["units"], {})
        self.assertNotIn("sorting", self.nb.load(SID))
        self.assertEqual(self.nb.summary(), {SID: {"noted": 1, "flagged": 0},
                                             f"{SID}@ms5_lar_v6": {"noted": 1, "flagged": 1}})
        md = self.nb.path(SID, "ms5_lar_v6").with_suffix(".md").read_text()
        self.assertIn(f"# Unit notebook · {SID} · sorting ms5_lar_v6", md)

    def test_existing_default_notebook_still_loads(self):
        (self.data / "notes").mkdir()
        old = {"schema": "result-viewer.notebook/1", "session_id": SID, "updated_at_utc": None,
               "units": {"3": {"unit_id": 3, "note": "from before sortings", "tags": [], "flag": False}}}
        (self.data / "notes" / f"{SID}.json").write_text(json.dumps(old))
        self.assertEqual(self.nb.load(SID)["units"]["3"]["note"], "from before sortings")
        self.assertEqual(self.nb.load(SID, "ms5_lar_v6")["units"], {})

    def test_conflicts_are_per_sorting(self):
        notes = self.data / "notes"
        notes.mkdir()
        (notes / f"{SID} (imac's conflicted copy).json").write_text("{}")
        (notes / f"{SID}@ms5_lar_v6 (imac's conflicted copy).json").write_text("{}")
        self.assertEqual(self.nb.conflicts(SID), [f"{SID} (imac's conflicted copy).json"])
        self.assertEqual(self.nb.conflicts(SID, "ms5_lar_v6"), [f"{SID}@ms5_lar_v6 (imac's conflicted copy).json"])


class ElectroGuiSortingTest(unittest.TestCase):
    def state(self, link):
        frag = urlsplit(link).fragment[len("s="):]
        return json.loads(base64.urlsafe_b64decode(frag + "=" * (-len(frag) % 4)))

    def test_deep_link_carries_the_sorting_only_for_alternates(self):
        default = electro_gui.deep_link("http://127.0.0.1:8765", SID, 4)
        self.assertEqual(urlsplit(default).query, "")
        self.assertNotIn("sorting", self.state(default))
        alt = electro_gui.deep_link("http://127.0.0.1:8765/?token=abc", SID, 4, sorting="ms5_lar_v6")
        self.assertEqual(parse_qs(urlsplit(alt).query), {"token": ["abc"], "sorting": ["ms5_lar_v6"]})
        self.assertEqual(self.state(alt), {"session": SID, "unit": 4, "sorting": "ms5_lar_v6"})

    def test_config_files_are_per_sorting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = {"unit_id": 1, "note": "n", "tags": [], "flag": False}
            self.assertEqual(electro_gui.sync_unit(root, SID, 1, entry), root / SID / "electro_gui_configs" / "unit_0001.json")
            path = electro_gui.sync_unit(root, SID, 1, entry, "ms5_lar_v6")
            self.assertEqual(path, root / f"{SID}@ms5_lar_v6" / "electro_gui_configs" / "unit_0001.json")
            cfg = json.loads(path.read_text())
            self.assertEqual(cfg["state"]["sorting"], "ms5_lar_v6")
            self.assertEqual(cfg["group"], f"Notes · {SID} · ms5_lar_v6")
            self.assertNotIn("sorting", json.loads((root / SID / "electro_gui_configs" / "unit_0001.json").read_text())["state"])


class FixedTailnet(Tailnet):
    def _read(self):
        return None


class ServerSortingsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        make_sortings(base / "results")
        cls.data = base / "data"
        cls.data.mkdir()
        app = App(Catalog([base / "results"]), Notebooks(cls.data), cls.data, cls.data / "electro_gui",
                  FixedTailnet("me@example.com", []), electro_gui_url="http://127.0.0.1:9",
                  electro_gui_repo=base / "no-electrogui")
        cls.server = make_server(app, "127.0.0.1", 0)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": f"127.0.0.1:{self.port}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body)
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        data = json.loads(resp.read() or b"null")
        conn.close()
        return resp.status, data

    def test_session_list_has_the_sortings(self):
        status, data = self.call("GET", "/api/sessions")
        self.assertEqual(status, 200)
        (session,) = data["sessions"]
        self.assertEqual(session["n_units"], 4)
        self.assertEqual([(s["name"], s["is_default"], s["n_units"]) for s in session["sortings"]],
                         [(None, True, 4), ("ks4_nwb", False, None), ("ms5_lar_v6", False, 2)])

    def test_session_by_sorting(self):
        status, data = self.call("GET", f"/api/session?sid={SID}&sorting=ms5_lar_v6")
        self.assertEqual(status, 200)
        self.assertEqual(data["session"]["sorting"], "ms5_lar_v6")
        self.assertEqual([u["id"] for u in data["session"]["units"]], [1, 7])
        self.assertEqual(data["sorting"], "ms5_lar_v6")
        self.assertTrue(data["files"]["json"].endswith(f"{SID}@ms5_lar_v6.json"))
        self.assertEqual(len(data["sortings"]), 3)
        status, data = self.call("GET", f"/api/session?sid={SID}&sorting=")
        self.assertEqual((status, data["session"]["sorting"], len(data["session"]["units"])), (200, None, 4))
        self.assertEqual(self.call("GET", f"/api/session?sid={SID}&sorting=nope")[0], 404)
        self.assertEqual(self.call("GET", f"/api/session?sid={SID}&sorting=..%2Fx")[0], 400)

    def test_notes_are_kept_per_sorting(self):
        status, r = self.call("POST", "/api/note", {"sid": SID, "sorting": "ms5_lar_v6", "unit": 7, "note": "only in v6"})
        self.assertEqual(status, 200, r)
        self.assertEqual((r["entry"]["quality"], r["entry"]["peak_channel"]), ("sua", 77))  # the v6 catalog's unit 7
        # unit 7 exists only in ms5_lar_v6
        self.assertEqual(self.call("POST", "/api/note", {"sid": SID, "unit": 7, "note": "x"})[0], 404)
        status, r = self.call("POST", "/api/note", {"sid": SID, "sorting": "ms5_lar_v6", "unit": 1, "tags": ["eye"]})
        self.assertEqual((status, r["entry"]["quality"]), (200, "mua"))
        _s, default = self.call("GET", f"/api/notebook?sid={SID}")
        self.assertNotIn("1", default["notebook"]["units"])
        _s, v6 = self.call("GET", f"/api/notebook?sid={SID}&sorting=ms5_lar_v6")
        self.assertEqual(sorted(v6["notebook"]["units"]), ["1", "7"])
        self.assertTrue((self.data / "electro_gui" / f"{SID}@ms5_lar_v6" / "electro_gui_configs" / "unit_0007.json").is_file())
        _s, data = self.call("GET", "/api/sessions")
        counts = {s["name"]: s["noted"] for s in data["sessions"][0]["sortings"]}
        self.assertEqual(counts["ms5_lar_v6"], 2)
        self.assertEqual(data["sessions"][0]["noted"], counts[None])


if __name__ == "__main__":
    unittest.main()
