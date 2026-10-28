import base64
import json
import tempfile
import unittest
from pathlib import Path

from result_viewer import electro_gui
from result_viewer.notebook import Notebooks, clean_tags, render_markdown
from result_viewer.settings import DEFAULTS, load_settings

SID = "Test_20260102"
TAGS = DEFAULTS["tags"]
SNAP = {"quality": "noise", "area": "acc", "peak_channel": 22, "depth_um": 220,
        "figure": "unit_0004_noise_Test_20260102_acc_rates_raster.png"}


class NotebookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.nb = Notebooks(self.data)

    def tearDown(self):
        self.tmp.cleanup()

    def test_update_writes_json_and_markdown(self):
        notebook, entry = self.nb.update(SID, 4, {"note": "dip at outcome\r\nsecond line", "tags": ["eye", "interesting"],
                                                  "flag": True}, SNAP, TAGS)
        self.assertEqual(entry["tags"], ["interesting", "eye"])  # settings order
        self.assertEqual(entry["note"], "dip at outcome\nsecond line")
        self.assertEqual(entry["quality"], "noise")
        on_disk = json.loads(self.nb.path(SID).read_text())
        self.assertEqual(on_disk["units"]["4"]["peak_channel"], 22)
        md = self.nb.path(SID).with_suffix(".md").read_text()
        self.assertIn("## Unit 4 · NOISE · ACC · ch 22 ★", md)
        self.assertIn("- **interesting:** 4", md)
        self.assertIn("dip at outcome\nsecond line", md)

    def test_partial_updates_keep_other_fields(self):
        self.nb.update(SID, 4, {"note": "keep me"}, SNAP, TAGS)
        _, entry = self.nb.update(SID, 4, {"flag": True}, None, TAGS)
        self.assertEqual(entry["note"], "keep me")
        self.assertEqual(entry["figure"], SNAP["figure"])  # kept when the results are not mounted

    def test_empty_entry_is_removed(self):
        self.nb.update(SID, 4, {"tags": ["noise"]}, SNAP, TAGS)
        notebook, entry = self.nb.update(SID, 4, {"tags": []}, SNAP, TAGS)
        self.assertIsNone(entry)
        self.assertEqual(notebook["units"], {})
        self.assertEqual(self.nb.update(SID, 5, {"note": "  "}, SNAP, TAGS)[1], None)

    def test_saves_merge_with_changes_made_elsewhere(self):
        self.nb.update(SID, 4, {"note": "here"}, SNAP, TAGS)
        other = json.loads(self.nb.path(SID).read_text())  # another machine, synced by Dropbox
        other["units"]["9"] = {"unit_id": 9, "note": "there", "tags": [], "flag": False}
        self.nb.path(SID).write_text(json.dumps(other))
        notebook, _ = self.nb.update(SID, 4, {"flag": True}, SNAP, TAGS)
        self.assertEqual(sorted(notebook["units"], key=int), ["4", "9"])

    def test_bad_input(self):
        for changes in ({"note": 3}, {"tags": "x"}, {"tags": [""]}, {"flag": "yes"}, {}, {"note": "x" * 20001}):
            with self.assertRaises(ValueError):
                self.nb.update(SID, 4, changes, SNAP, TAGS)
        with self.assertRaises(ValueError):
            self.nb.path("../escape")
        self.assertEqual(clean_tags([" a ", "b", "a"]), ["a", "b"])

    def test_conflicts_and_summary(self):
        self.nb.update(SID, 4, {"flag": True}, SNAP, TAGS)
        self.nb.update(SID, 5, {"note": "x"}, SNAP, TAGS)
        (self.nb.notes_dir / f"{SID} (Ruidong Chen's conflicted copy 2026-10-08).json").write_text("{}")
        self.assertEqual(len(self.nb.conflicts(SID)), 1)
        self.assertEqual(self.nb.summary(), {SID: {"noted": 2, "flagged": 1}})

    def test_markdown_of_an_empty_notebook(self):
        self.assertIn("0 units noted", render_markdown({"session_id": SID, "units": {}}))


class ElectroGuiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_deep_link_matches_electro_gui_encoding(self):
        link = electro_gui.deep_link("http://127.0.0.1:8765", SID, 4, "noise")
        self.assertTrue(link.startswith("http://127.0.0.1:8765/#s="))
        payload = link.split("#s=", 1)[1]
        self.assertNotIn("=", payload)
        state = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        self.assertEqual(state, {"session": SID, "unit": 4, "unitQ": ["sua", "mua", "noise"]})
        self.assertNotIn("unitQ", electro_gui.view_state(SID, 4, "sua"))
        tokened = electro_gui.deep_link("http://100.1.2.3:8777/?token=abc", SID, 1, "sua")
        self.assertTrue(tokened.startswith("http://100.1.2.3:8777/?token=abc#s="))

    def test_sync_writes_and_removes_only_its_own_files(self):
        entry = {"unit_id": 4, "note": "first line\nmore", "tags": ["eye"], "flag": True, **SNAP}
        path = electro_gui.sync_unit(self.root, SID, 4, entry)
        config = json.loads(path.read_text())
        self.assertEqual(path, self.root / SID / "electro_gui_configs" / "unit_0004.json")
        self.assertEqual(config["electro_gui_config"], 1)
        self.assertEqual(config["state"]["unit"], 4)
        self.assertEqual(config["hint"], "eye · first line")
        foreign = self.root / SID / "electro_gui_configs" / "unit_0005.json"
        foreign.write_text(json.dumps({"electro_gui_config": 1, "state": {}}))
        self.assertIsNone(electro_gui.sync_unit(self.root, SID, 5, entry))
        electro_gui.sync_unit(self.root, SID, 5, None)
        self.assertTrue(foreign.exists())
        kept = electro_gui.sync_session(self.root, SID, {"units": {}})
        self.assertEqual(kept, [])
        self.assertFalse(path.exists())
        self.assertTrue(foreign.exists())


class SettingsTest(unittest.TestCase):
    def test_defaults_written_once_and_sanitized(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = load_settings(tmp)
            self.assertEqual(settings["tags"], TAGS)
            self.assertTrue((Path(tmp) / "settings.json").exists())
            (Path(tmp) / "settings.json").write_text(json.dumps({"tags": ["a", "a", " b ", 3] + list("cdefghijk"),
                                                                "electro_gui": {"remote_url": "http://x:8777"}}))
            settings = load_settings(tmp)
            self.assertEqual(settings["tags"], ["a", "b", "c", "d", "e", "f", "g", "h", "i"])
            self.assertEqual(settings["electro_gui"], {"url": "http://127.0.0.1:8765", "remote_url": "http://x:8777"})


if __name__ == "__main__":
    unittest.main()
