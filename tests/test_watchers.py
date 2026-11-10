"""Guarded cycle replay, current-generation metadata and live configuration."""
from __future__ import annotations

from collections import Counter
import copy
import math

import pytest
from fastapi.testclient import TestClient

from life.config import CYCLE_KEYS, DEFAULTS, load_config, merge_config
from life.native import NativeEngine, library_path, load_library
from life.runtime import Simulation
from life.server import create_app


@pytest.fixture
def guarded_native():
    if not library_path().exists():
        pytest.skip("Build the native library")
    library = load_library()
    if not hasattr(library, "life_render_cycles"):
        pytest.skip("Build the guarded-cycle native library")


def configure(engine, *, enabled=True, start=0, period=16, memory=8, interval=1):
    engine.configure_cycles(enabled, start, period, memory, interval)


def scalar(cells, width, height, wrap=False):
    counts = Counter()
    for x, y in cells:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == dy == 0:
                    continue
                xx, yy = x + dx, y + dy
                if wrap:
                    xx, yy = xx % width, yy % height
                if 0 <= xx < width and 0 <= yy < height:
                    counts[xx, yy] += 1
    return {cell for cell, count in counts.items() if count == 3 or count == 2 and cell in cells}


def test_legacy_config_receives_cycle_and_heat_defaults(tmp_path):
    path = tmp_path / "old.toml"
    path.write_text("[grid]\nwidth=64\nheight=64\n[engine]\nthreads=2\n", encoding="utf-8")
    config = load_config(path)
    assert {key: config["engine"][key] for key in CYCLE_KEYS} == {
        "cycles_enabled": True, "cycles_start_generation": 128, "cycles_max_period": 16,
        "cycles_memory_mb": 128, "cycles_detection_interval": 8,
    }
    assert config["display"]["heat_stable"] < config["display"]["heat_cycle_max"] < config["display"]["heat_active"]


@pytest.mark.parametrize("key,value", [
    ("cycles_enabled", 1), ("cycles_start_generation", -1), ("cycles_start_generation", 10**15 + 1),
    ("cycles_max_period", 0), ("cycles_max_period", 65), ("cycles_max_period", 1.5),
    ("cycles_memory_mb", -1), ("cycles_memory_mb", 1_048_577),
    ("cycles_detection_interval", 0), ("cycles_detection_interval", 65536),
])
def test_invalid_cycle_controls_are_rejected(key, value):
    with pytest.raises(ValueError):
        merge_config({"engine": {key: value}})


@pytest.mark.parametrize("update", [
    {"heat_stable": 0.45}, {"heat_cycle_max": 0.65}, {"heat_active": 0.45},
    {"heat_density_gain": 0.36}, {"heat_density_reference": 0}, {"heat_hotspot_mix": 1.01},
])
def test_heat_coefficients_preserve_fixed_order_and_bounds(update):
    with pytest.raises(ValueError):
        merge_config({"display": update})


def test_delayed_capture_and_replay_preserve_scalar_life(guarded_native):
    block = {(70, 70), (71, 70), (70, 71), (71, 71)}
    blinker = {(145, 20), (145, 21), (145, 22)}
    cells = block | blinker
    engine = NativeEngine(192, 128, tile_size=64, threads=2, cache_mb=0, memory_bytes=64 << 20)
    try:
        configure(engine, start=12)
        engine.import_cells(cells)
        for generation in range(40):
            assert set(engine.cells()) == cells
            if generation < 12:
                assert engine.cluster_info(1, 1)["period"] == 0
                assert engine.cluster_info(2, 0)["period"] == 0
                assert engine.stats()["cycle_replays"] == 0
            cells = scalar(cells, 192, 128)
            engine.step()
        assert set(engine.cells()) == cells
        assert engine.cluster_info(1, 1)["period"] == 1
        assert engine.cluster_info(2, 0)["period"] == 2
        assert engine.stats()["cycle_replays"] >= 2
    finally:
        engine.close()


def test_detection_interval_does_not_alias_period_two_to_stable(guarded_native):
    cells = {(30, 30), (31, 30), (32, 30)}
    engine = NativeEngine(64, 64, tile_size=64, cache_mb=0, memory_bytes=32 << 20)
    try:
        configure(engine, period=1, interval=8)
        engine.import_cells(cells)
        for _ in range(80):
            engine.step()
            assert engine.cluster_info(0, 0)["period"] == 0
        assert set(engine.cells()) == cells
    finally:
        engine.close()


@pytest.mark.parametrize("wrap", [False, True])
def test_changed_external_halo_invalidates_metadata_before_next_step(guarded_native, wrap):
    width, height = (131, 129) if wrap else (128, 128)
    cells = {(0, 31), (1, 31), (2, 31)} if wrap else {(61, 31), (62, 31), (63, 31)}
    disturbance = (130, 31) if wrap else (64, 31)
    engine = NativeEngine(width, height, wrap, tile_size=64, cache_mb=0, memory_bytes=64 << 20)
    reference = NativeEngine(width, height, wrap, tile_size=64, cache_mb=0, memory_bytes=64 << 20)
    try:
        configure(engine)
        configure(reference, enabled=False)
        for item in (engine, reference):
            item.import_cells(cells)
            for _ in range(40):
                item.step()
        assert engine.cluster_info(0, 0)["period"] == 2
        for item in (engine, reference):
            item._check(item.lib.life_set_cell(item.handle, *disturbance, 1))
        # No step has occurred since the edit: stale borders cannot retain a period claim.
        assert engine.cluster_info(0, 0)["period"] == 0
        before = set(engine.cells())
        generation = engine.generation
        counts, metadata = engine.render_cycles(0, 0, 1, 1, 64)
        assert metadata["known_live"] == [0]
        assert metadata["period_max"] == [0]
        assert counts == engine.render(0, 0, 1, 1, 64)
        assert engine.generation == generation and set(engine.cells()) == before
        for _ in range(50):
            engine.step()
            reference.step()
            assert set(engine.cells()) == set(reference.cells())
    finally:
        engine.close()
        reference.close()


def test_bulk_metadata_weights_exact_clipped_live_cells(guarded_native):
    block = {(10, 10), (11, 10), (10, 11), (11, 11)}
    blinker = {(80, 10), (80, 11), (80, 12)}
    glider = {(11, 90), (12, 91), (10, 92), (11, 92), (12, 92)}
    engine = NativeEngine(128, 128, tile_size=64, threads=2, cache_mb=0, memory_bytes=64 << 20)
    try:
        configure(engine, period=4)
        engine.import_cells(block | blinker | glider)
        for _ in range(40):
            engine.step()
        assert engine.cluster_info(0, 0)["period"] == 1
        assert engine.cluster_info(1, 0)["period"] == 2
        assert engine.cluster_info(0, 1)["period"] == 0
        counts, meta = engine.render_cycles(0, 0, 1, 1, 128)
        assert counts == [12]
        assert meta["known_live"] == [7]
        assert meta["period_log2_sum"] == [3.0]
        assert meta["period_max"] == [2]
        # The requested area ends halfway through the block, before the blinker.
        for scale in (16, 64, 128):
            counts, clipped = engine.render_cycles(10, 10, 1, 1, scale, extent=(1, 2))
            assert counts == clipped["known_live"] == [2]
            assert clipped["period_log2_sum"] == [0.0]
            assert clipped["period_max"] == [1]
        cells = set(engine.cells())
        for scale in (1, 3, 16, 64, 128, 200):
            for x, y in ((0, 0), (11, 10), (63, 63), (127, 127), (128, 128)):
                columns, rows = 4, 3
                expected_counts = [0] * (columns * rows)
                known = [0] * (columns * rows)
                logs = [0.0] * (columns * rows)
                periods = [0] * (columns * rows)
                for xx, yy in cells:
                    if x <= xx < x + columns * scale and y <= yy < y + rows * scale:
                        index = ((yy - y) // scale) * columns + (xx - x) // scale
                        expected_counts[index] += 1
                        period = engine.cluster_info(xx // 64, yy // 64)["period"]
                        if period:
                            known[index] += 1
                            logs[index] += math.log2(period)
                            periods[index] = max(periods[index], period)
                actual, metadata = engine.render_cycles(x, y, columns, rows, scale)
                assert actual == expected_counts == engine.render(x, y, columns, rows, scale)
                assert metadata["known_live"] == known
                assert metadata["period_log2_sum"] == pytest.approx(logs)
                assert metadata["period_max"] == periods
        assert set(engine.cells()) == cells and engine.generation == 40
    finally:
        engine.close()


def test_cycle_helpers_yield_to_authoritative_state_memory(guarded_native):
    enabled = NativeEngine(259, 197, True, tile_size=64, threads=2, cache_mb=0, memory_bytes=2 << 20)
    disabled = NativeEngine(259, 197, True, tile_size=64, threads=1, cache_mb=0, memory_bytes=2 << 20)
    try:
        configure(enabled, start=8, period=16, memory=128, interval=8)
        configure(disabled, enabled=False)
        for engine in (enabled, disabled):
            engine.randomize(0.27, 7123, 0, 0, 259, 197)
        for _ in range(100):
            enabled.step()
            disabled.step()
            assert set(enabled.cells()) == set(disabled.cells())
            assert enabled.generation == disabled.generation
            stats = enabled.stats()
            assert stats["cycle_bytes"] <= stats["cycles_budget_bytes"]
            assert stats["estimated_native_bytes"] <= 2 << 20
    finally:
        enabled.close()
        disabled.close()


def test_api_cycle_controls_and_metadata_are_atomic(guarded_native, tmp_path):
    config = merge_config({"grid": {"width": 128, "height": 64},
                           "engine": {"tile_size": 64, "threads": 2, "memory_mb": 256, "cache_mb": 0,
                                      "cycles_enabled": False, "cycles_start_generation": 0,
                                      "cycles_detection_interval": 1, "cycles_memory_mb": 8},
                           "checkpoints": {"directory": str(tmp_path / "snapshots")}})
    simulation = Simulation(config, tmp_path)
    try:
        simulation.new({"width": 128, "height": 64, "cells": [[30, 30], [31, 30], [32, 30]]})
        with TestClient(create_app(config, simulation), base_url="http://127.0.0.1") as client:
            before = client.get("/api/status").json()
            original = client.get("/api/viewport?width=128&height=64&scale=1").json()["counts"]
            update = client.put("/api/config", json={"engine": {"cycles_enabled": True}})
            assert update.status_code == 200
            after = client.get("/api/status").json()
            assert (after["run_id"], after["generation"], after["population"]) == (before["run_id"], before["generation"], before["population"])
            assert after["metadata_revision"] == before["metadata_revision"] + 1
            assert client.get(f'/api/viewport?layer=cycles&metadata_revision={before["metadata_revision"]}').status_code == 409
            with simulation.lock:
                for _ in range(30):
                    simulation.engine.step()
                simulation._refresh()
            view = client.get("/api/viewport?layer=cycles&width=128&height=64&scale=1").json()
            assert view["generation"] == 30 and view["counts"] == original
            assert sum(view["cycles"]["known_live"]) == 3
            assert max(view["cycles"]["period_max"]) == 2
            saved_config = copy.deepcopy(simulation.config)
            revision = simulation.metadata_revision
            assert client.put("/api/config", json={"engine": {"cycles_max_period": 65}}).status_code == 400
            assert simulation.config == saved_config and simulation.metadata_revision == revision
            assert client.put("/api/config", json={"engine": {"cycles_enabled": False}}).status_code == 200
            disabled = client.get("/api/viewport?layer=cycles&width=128&height=64&scale=1").json()
            assert disabled["generation"] == 30 and disabled["counts"] == original
            assert sum(disabled["cycles"]["known_live"]) == 0
            assert max(disabled["cycles"]["period_max"]) == 0
            assert client.get("/api/viewport?layer=cycles&width=1024&height=1024&scale=1").status_code == 400
            assert client.get("/api/viewport?layer=unrecognized").status_code == 400
    finally:
        simulation.close()
