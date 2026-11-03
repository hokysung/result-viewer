"""A tiny fake viewer-sessions tree in the session_viewer layout."""
from __future__ import annotations

import json
import os
from pathlib import Path

SID = "Test_20260102"
TAG = "Test_20260102"
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


def touch(path, data=PNG, mtime=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def make_session(root, sid=SID, tag=TAG):
    s = Path(root) / sid
    rasters = s / "figures" / "unit_rasters"
    touch(rasters / f"unit_0001_sua_{tag}_acc_rates_raster.png")
    # unit 2 was relabelled mua -> noise; the rates summary names the current label
    touch(rasters / f"unit_0002_mua_{tag}_pmd_rates_raster.png", mtime=2_000_000_000)
    touch(rasters / f"unit_0002_noise_{tag}_pmd_rates_raster.png", mtime=1_000_000_000)
    # unit 3 has two rasters and no summary: the newest wins
    touch(rasters / f"unit_0003_mua_{tag}_acc_rates_raster.png", mtime=1_000_000_000)
    touch(rasters / f"unit_0003_sua_{tag}_acc_rates_raster.png", mtime=2_000_000_000)
    # an old figure of another kind left in unit_rasters, and an untagged-quality raster
    touch(rasters / f"unit_0009_mua_{tag}_acc.png")
    touch(rasters / f"unit_0004_{tag}_acc_rates_raster.png")
    touch(rasters / ".unit_0005_sua_{tag}_acc_rates_raster.png")
    touch(s / "session.h5", b"", mtime=1_500_000_000)
    tables = s / "tables"
    tables.mkdir(parents=True, exist_ok=True)
    (tables / "unit_0002_rates_summary.json").write_text(json.dumps({"unit": {"unit_id": 2, "quality": "noise"}}))
    # the current units: 3 is MUA now (its newest raster says SUA), 4 is not in this build, 5 has no raster
    (tables / "units.csv").write_text(
        "unit_id,quality,area,peak_channel,depth_um,stream,source_unit_id,n_spikes,mean_rate_hz,"
        "n_completed_trials,n_stable_trials,conn_basis,conn_pulse_p\n"
        "1,sua,ACC,22.0,220.0,imec0,1,9000,5.5123,300,300,stable,0.0002\n"
        "2,noise,PMD,140,1400.5,imec0,2,4000,1.2,300,150,all,nan\n"
        "3,mua,ACC,,,imec0,3,800,0.4,300,0,all,inf\n"
        "5,mua,ACC,,,imec0,5,100,0.1,300,300,all,\n")
    figs = s / "figures"
    touch(figs / "selectivity_classes" / f"unit_0001_sua_{tag}_acc.png")
    touch(figs / "selectivity_classes" / f"unit_0002_mua_{tag}_pmd.png")
    touch(figs / "selectivity_classes_onset" / f"unit_0001_sua_{tag}_acc.png")
    touch(figs / f"intention_decoding_unit_0001_sua_{tag}_acc.png")
    touch(figs / "session_overview.png")
    summaries = s / "figures" / "unit_summaries"
    touch(summaries / "unit_0001_sua.jpg")
    touch(summaries / "unit_0002_mua.jpg")
    return s


DATA = Path(__file__).with_name("data")
# small h5py files whose root attribute "meta" names the sortings (made with h5py 'earliest' and 'latest' formats)
META_SINGLE = DATA / "meta_single_v0.h5"   # streams: imec0 ms5_lar_v8
META_MIXED = DATA / "meta_mixed_v3.h5"     # streams: imec0 ms5_lar_v8, imec1 ms5_lar_v6


def make_sortings(root, sid=SID, tag=TAG):
    """``make_session`` plus other sortings under ``<sid>/sortings/``:

    * ``ms5_lar_v6``: units 1 and 7 (its unit 1 is another unit than the default's unit 1), a figure kind, META_MIXED;
    * ``ks4_nwb``: unit 1 only, a ``session.h5`` without meta (labelled by its folder name);
    * ``broken``: figures but no ``session.h5``, so it is not a sorting.
    The default's ``session.h5`` gets META_SINGLE (same mtime as before).
    """
    s = make_session(root, sid, tag)
    (s / "session.h5").write_bytes(META_SINGLE.read_bytes())
    os.utime(s / "session.h5", (1_500_000_000, 1_500_000_000))
    alt = s / "sortings" / "ms5_lar_v6"
    touch(alt / "session.h5", META_MIXED.read_bytes(), mtime=1_500_000_000)
    touch(alt / "figures" / "unit_rasters" / f"unit_0001_mua_{tag}_pmd_rates_raster.png")
    touch(alt / "figures" / "unit_rasters" / f"unit_0007_sua_{tag}_acc_rates_raster.png")
    touch(alt / "figures" / "connectivity" / f"unit_0007_sua_{tag}_acc.png")
    (alt / "tables").mkdir(parents=True, exist_ok=True)
    (alt / "tables" / "units.csv").write_text(
        "unit_id,quality,area,peak_channel,depth_um,mean_rate_hz,n_completed_trials,n_stable_trials\n"
        "1,mua,PMD,300,3000,2.5,300,10\n"
        "7,sua,ACC,77,770,9.0,300,300\n")
    other = s / "sortings" / "ks4_nwb"
    touch(other / "session.h5", b"", mtime=1_500_000_000)
    touch(other / "figures" / "unit_rasters" / f"unit_0001_sua_{tag}_acc_rates_raster.png")
    touch(s / "sortings" / "broken" / "figures" / "unit_rasters" / f"unit_0001_sua_{tag}_acc_rates_raster.png")
    return s
