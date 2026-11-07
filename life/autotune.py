"""Small, bounded startup calibration. Only disposable grids are benchmarked."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import statistics
import time
from pathlib import Path

from .native import NativeEngine, library_path

ROOT = Path(__file__).resolve().parent.parent


def choose_tile_size(settings: dict) -> int:
    """Return a measured leaf size, reusing results for this binary/hardware.

    Tests three leaf sizes using the same coordinate-seeded state and the same
    worker budget. The calibration never reads or mutates the user's world.
    Failure leaves the conservative 128-cell baseline available.
    """
    cache_path = ROOT / ".run" / "autotune.json"
    try:
        key_data = {
            "binary_mtime": library_path().stat().st_mtime_ns,
            "machine": platform.machine(), "processor": platform.processor(),
            "threads": settings["threads"], "logical_cpus": os.cpu_count(),
            "version": 1,
        }
        key = hashlib.sha256(json.dumps(key_data, sort_keys=True).encode()).hexdigest()
        if cache_path.exists():
            saved = json.loads(cache_path.read_text(encoding="utf-8"))
            if saved.get("key") == key and saved.get("tile_size") in (64, 128, 256):
                return saved["tile_size"]

        timings = {}
        for tile in (64, 128, 256):
            engine = NativeEngine(1024, 1024, tile_size=tile,
                                  threads=settings["threads"], cache_mb=0,
                                  memory_bytes=min(settings["memory_bytes"], 128 << 20))
            try:
                engine.randomize(0.20, 87231, 0, 0, 1024, 1024)
                engine.step()
                samples = []
                for _ in range(4):
                    start = time.perf_counter()
                    engine.step()
                    samples.append(time.perf_counter() - start)
                timings[tile] = statistics.median(samples)
            finally:
                engine.close()
        tile_size = min(timings, key=timings.get)
        cache_path.parent.mkdir(exist_ok=True)
        temporary = cache_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"key": key, "tile_size": tile_size,
                                        "seconds_per_step": timings, "hardware": key_data}, indent=2), encoding="utf-8")
        temporary.replace(cache_path)
        return tile_size
    except (OSError, ValueError, RuntimeError, KeyError):
        return 128
