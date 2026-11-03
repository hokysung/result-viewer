import json
import tempfile
import unittest
from pathlib import Path

from result_viewer.catalog import Catalog, kind_label, session_tag
from tests.helpers import SID, make_session, touch


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "results"
        make_session(self.root)
        self.catalog = Catalog([Path(self.tmp.name) / "missing", self.root])
        self.session = self.catalog.session(SID)
        self.units = {u["id"]: u for u in self.session["units"]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_session_tag_is_the_session_id(self):
        self.assertEqual(session_tag("Nielsen_20261015"), "Nielsen_20261015")
        self.assertEqual(session_tag("odd session!"), "odd-session")

    def test_units_come_from_rasters_only(self):
        self.assertEqual(sorted(self.units), [1, 2, 3, 4])

    def test_relabelled_unit_takes_the_summary_label(self):
        u = self.units[2]
        self.assertEqual(u["quality"], "noise")
        self.assertEqual(u["relabelled_from"], ["mua"])
        self.assertEqual(u["figures"]["raster"]["name"], "unit_0002_noise_Test_20260102_pmd_rates_raster.png")
        self.assertEqual(u["figures"]["selectivity_classes"]["label_in_figure"], "mua")
        self.assertEqual(u["figures"]["sorter_summary"]["label_in_figure"], "mua")

    def test_stability_table_names_the_current_label(self):
        u = self.units[3]  # rasters labelled mua and (newer) sua; the stability table says mua
        self.assertEqual(u["quality"], "mua")
        self.assertEqual(u["figures"]["raster"]["name"], "unit_0003_mua_Test_20260102_acc_rates_raster.png")
        self.assertEqual(u["relabelled_from"], ["sua"])

    def test_stability_fields(self):
        one, two, three, four = (self.units[i] for i in (1, 2, 3, 4))
        self.assertEqual((one["rate_hz"], one["n_stable"], one["n_trials"], one["full_stable"]), (5.512, 300, 300, True))
        self.assertEqual((two["n_stable"], two["full_stable"]), (150, False))
        self.assertEqual((three["n_stable"], three["full_stable"]), (0, False))
        self.assertTrue(one["in_units"])
        self.assertFalse(four["in_units"])  # a raster of a unit the current build does not have
        self.assertIsNone(four["rate_hz"])

    def test_metrics_are_the_finite_numeric_columns(self):
        one, two, three, four = (self.units[i] for i in (1, 2, 3, 4))
        self.assertEqual(one["metrics"]["conn_pulse_p"], 0.0002)
        self.assertEqual(one["metrics"]["mean_rate_hz"], 5.5123)
        self.assertEqual(one["metrics"]["n_stable_trials"], 300)
        for hidden in ("unit_id", "source_unit_id", "peak_channel", "n_completed_trials", "conn_basis", "quality"):
            self.assertNotIn(hidden, one["metrics"])
        self.assertNotIn("conn_pulse_p", two["metrics"])    # nan
        self.assertNotIn("conn_pulse_p", three["metrics"])  # inf: not JSON
        self.assertEqual(four["metrics"], {})               # not in the units table
        json.dumps(self.units, allow_nan=False)

    def test_panels_folder_per_unit_with_shared_session_panels(self):
        base = self.root / SID / "figures" / "panels"
        tag = SID
        touch(base / f"unit_0001_sua_{tag}_acc" / "task_ms_target.png")
        touch(base / f"unit_0001_sua_{tag}_acc" / "stim_ms_onset.png")
        touch(base / f"unit_0001_sua_{tag}_acc" / "extra_panel.png")          # not in the manifest: last
        touch(base / "_session" / "eye_ms.png")
        touch(base / f"unit_0099_sua_{tag}_acc" / "stim_ms_onset.png")        # no such unit: ignored
        (base / "manifest.json").write_text(json.dumps({"panels": [
            {"key": "stim_ms_onset", "title": "MS onset", "group": "Stim"},
            {"key": "eye_ms", "title": "MS eye", "group": "Stim", "session": True},
            {"key": "task_ms_target", "title": "MS target", "group": "Task"}]}))
        session = Catalog([self.root]).session(SID)
        self.assertEqual(session["views"][0]["kind"], "panels")
        panels = {u["id"]: u for u in session["units"]}[1]["figures"]["panels"]["panels"]
        self.assertEqual([p["key"] for p in panels], ["stim_ms_onset", "eye_ms", "task_ms_target", "extra_panel"])
        self.assertTrue(panels[1]["url"].endswith("/figures/panels/_session/eye_ms.png"))
        self.assertNotIn("panels", {u["id"]: u for u in session["units"]}[2]["figures"])
        self.assertEqual([p["key"] for p in session["panels"]][-1], "extra_panel")
        self.assertIsNotNone(Catalog([self.root]).resolve_figure(0, f"{SID}/figures/panels/_session/eye_ms.png"))

    def test_without_a_stability_table(self):
        (self.root / SID / "tables" / "units.csv").unlink()
        units = {u["id"]: u for u in Catalog([self.root]).session(SID)["units"]}
        self.assertEqual(units[3]["quality"], "sua")  # no table, no summary: the newest raster
        self.assertEqual(units[2]["quality"], "noise")  # the rates summary
        self.assertIsNone(units[1]["in_units"])
        self.assertIsNone(units[1]["n_stable"])
        self.assertFalse(units[1]["full_stable"])

    def test_raster_without_quality_token(self):
        self.assertIsNone(self.units[4]["quality"])
        self.assertEqual(self.units[4]["area"], "acc")

    def test_other_figures_and_channels(self):
        u = self.units[1]
        self.assertEqual(set(u["figures"]), {"raster", "sorter_summary", "selectivity_classes",
                                             "selectivity_classes_onset", "intention_decoding"})
        self.assertNotIn("label_in_figure", u["figures"]["selectivity_classes"])
        self.assertEqual((u["peak_channel"], u["depth_um"]), (22, 220))
        self.assertEqual(self.units[2]["depth_um"], 1400.5)
        self.assertIsNone(self.units[3]["peak_channel"])

    def test_channels_from_a_table_older_than_the_session_file_are_ignored(self):
        import os
        table = self.root / SID / "tables" / "units.csv"
        os.utime(table, (1_000_000_000, 1_000_000_000))
        os.utime(table.parent.parent / "figures" / "unit_rasters", None)  # invalidate the cache
        units = {u["id"]: u for u in Catalog([self.root]).session(SID)["units"]}
        self.assertIsNone(units[1]["peak_channel"])
        self.assertIsNone(units[1]["depth_um"])

    def test_view_order_and_labels(self):
        kinds = [v["kind"] for v in self.session["views"]]
        self.assertEqual(kinds[:2], ["raster", "sorter_summary"])
        self.assertEqual(kinds[2:], sorted(kinds[2:]))
        self.assertEqual(kind_label("selectivity_classes_onset"), "Selectivity classes onset")

    def test_figure_urls_resolve_inside_the_root_only(self):
        url = self.units[1]["figures"]["raster"]["url"]
        index, _, rel = url[len("/fig/"):].partition("/")
        self.assertEqual(index, "1")
        self.assertTrue(self.catalog.resolve_figure(index, rel).is_file())
        self.assertIsNone(self.catalog.resolve_figure("1", f"{SID}/../../outside.png"))
        self.assertIsNone(self.catalog.resolve_figure("1", f"{SID}/tables/unit_0002_rates_summary.json"))
        self.assertIsNone(self.catalog.resolve_figure("7", rel))
        self.assertIsNone(self.catalog.resolve_figure("x", rel))

    def test_first_root_wins_and_folders_without_rasters_are_skipped(self):
        first = Path(self.tmp.name) / "first"
        make_session(first)
        (self.root / "Other_20260103" / "tables").mkdir(parents=True)
        (self.root / ".partial" / "figures" / "unit_rasters").mkdir(parents=True)
        catalog = Catalog([first, self.root])
        self.assertEqual(list(catalog.sessions()), [SID])
        self.assertEqual(catalog.session(SID)["root_index"], 0)

    def test_cache_notices_new_figures(self):
        rasters = self.root / SID / "figures" / "unit_rasters"
        touch(rasters / "unit_0010_mua_Test_20260102_acc_rates_raster.png")
        import os
        st = rasters.stat()
        os.utime(rasters, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))
        self.assertIn(10, [u["id"] for u in self.catalog.session(SID)["units"]])


if __name__ == "__main__":
    unittest.main()
