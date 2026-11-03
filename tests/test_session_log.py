import json
import tempfile
import unittest
from pathlib import Path

from result_viewer import session_log as sl

OFFSET = -1_792_088_267.0      # imec = epoch + OFFSET


def _stops(n=400, dropped=(50, 51, 200)):
    """Trial stops every 3 s; the trial table lost some trials the dashboard counted."""
    stops = [100.0 + 3.0 * k for k in range(n)]
    return [s for k, s in enumerate(stops) if k not in dropped], stops


class AlignTest(unittest.TestCase):
    def test_offset_from_trial_ends_despite_dropped_trials(self):
        table, dash = _stops()
        entries = [{"kind": "set", "after_trial": n + 1, "epoch": dash[n] - OFFSET + 0.05} for n in range(0, 400, 7)]
        entries.append({"kind": "mark", "text": "Recording ON", "epoch": 100.0 - OFFSET - 60})
        got = sl.align(entries, table)
        self.assertEqual(got["method"], "trial ends")
        self.assertAlmostEqual(got["offset"], OFFSET, delta=0.5)

    def test_falls_back_to_the_recording_mark(self):
        entries = [{"kind": "mark", "text": "Recording ON", "epoch": 5000.0}, {"kind": "note", "text": "x", "epoch": 5100.0}]
        got = sl.align(entries, [1.0, 2.0])
        self.assertEqual((got["method"], got["offset"]), ("Recording ON mark", -5000.0))

    def test_vote_far_from_the_mark_is_not_trusted(self):
        table, dash = _stops()
        entries = [{"kind": "set", "after_trial": n + 1, "epoch": dash[n] - OFFSET} for n in range(0, 400, 5)]
        entries.append({"kind": "mark", "text": "Recording ON", "epoch": -OFFSET + 3600})  # an hour away
        self.assertEqual(sl.align(entries, table)["method"], "Recording ON mark")

    def test_protocol_runs(self):
        entries = [{"kind": "control", "action": "start", "protocol": "Fixation", "t": 10, "run": 1},
                   {"kind": "control", "action": "stop", "t": 40},
                   {"kind": "control", "action": "start", "protocol": "MultiTask_Train", "t": 50, "run": 2},
                   {"kind": "control", "action": "start", "protocol": "MultiTask_Train", "t": 90, "run": 3}]
        runs = sl.protocol_runs(entries)
        self.assertEqual([(r["protocol"], r["t0"], r["t1"]) for r in runs],
                         [("Fixation", 10, 40), ("MultiTask_Train", 50, 90), ("MultiTask_Train", 90, None)])


class FindLogsTest(unittest.TestCase):
    def test_dashboard_folder_of_the_date_and_the_exports_own_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            dash = tmp / "Dashboard"
            for name in ("20261015-Nielsen-Multitask_Train-125842", "20261016-Nielsen-Multitask_Train-1", "20261015-Other-x"):
                (dash / name).mkdir(parents=True)
                (dash / name / sl.LOG_NAME).write_text(json.dumps({"kind": "note", "text": name, "epoch": 1}) + "\n")
            session = tmp / "sessions" / "Nielsen_20261015"
            (session / "tables").mkdir(parents=True)
            found = sl.find_logs(session, "Nielsen_20261015", [str(tmp / "missing"), str(dash)])
            self.assertEqual([p.parent.name for p in found], ["20261015-Nielsen-Multitask_Train-125842"])
            (session / "tables" / sl.LOG_NAME).write_text("")
            self.assertEqual(sl.find_logs(session, "Nielsen_20261015", [str(dash)]), [session / "tables" / sl.LOG_NAME])

    def test_session_log_without_a_timeline_still_lists_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            folder = tmp / "Dashboard" / "20261015-Nielsen-Multitask_Train-1"
            folder.mkdir(parents=True)
            lines = [{"kind": "mark", "text": "Recording ON", "epoch": 1000.0, "wall": "14:00:00"},
                     {"kind": "note", "text": "hello", "epoch": 1010.0, "wall": "14:00:10"},
                     {"kind": "replayed_into_mwk2", "epoch": 1011.0}]
            (folder / sl.LOG_NAME).write_text("\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
            out = sl.session_log(tmp / "sessions" / "Nielsen_20261015", "Nielsen_20261015", [], [str(tmp / "Dashboard")])
            self.assertEqual([e["kind"] for e in out["entries"]], ["mark", "note"])
            self.assertEqual(out["entries"][1]["t"], 10.0)
            json.dumps(out, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
