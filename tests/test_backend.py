from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import json
from pathlib import Path
import random
import threading
import time

import pytest
from fastapi.testclient import TestClient

from life.checkpoint import Checkpoints, checkpoint_metadata, load_checkpoint_into
from life.config import DEFAULTS, load_config, merge_config, public_config
from life.formats import json_chunks, parse_state, rle_text
from life.native import NativeEngine, library_path
from life.runtime import Simulation
from life.server import create_app


def scalar(cells, width, height, wrap):
    result = set()
    for y in range(height):
        for x in range(width):
            neighbors = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == dy == 0:
                        continue
                    xx, yy = x + dx, y + dy
                    if wrap:
                        xx, yy = xx % width, yy % height
                    if (xx, yy) in cells:
                        neighbors += 1
            if neighbors == 3 or (neighbors == 2 and (x, y) in cells):
                result.add((x, y))
    return result


native = pytest.mark.skipif(not library_path().exists(), reason="Build native library to run integration tests")


@pytest.mark.parametrize("format", ["json", "rle"])
def test_state_roundtrip(format):
    cells = [(0, 0), (4, 3), (5, 3), (6, 3), (18, 10)]
    text = "".join(json_chunks(19, 11, True, 123, cells)) if format == "json" else rle_text(19, 11, True, 123, cells)
    state = parse_state(text, format)
    assert (state.width, state.height, state.wrap, state.generation) == (19, 11, True, 123)
    assert state.cells == cells


@pytest.mark.parametrize("text", ["x=3,y=3,rule=B36/S23\nbo$3o!", "x=3,y=3\n4o!", "x=3,y=3\n3o", "x=3,y=3\n0o!", "x=3,y=3\no!o!", "x=3,y=3\n3$ob!"])
def test_rle_rejects_invalid(text):
    with pytest.raises(ValueError):
        parse_state(text, "rle")


def test_rle_metadata_and_large_empty_runs():
    state = parse_state("#C LIFE width=1000 height=2000 origin_x=5 origin_y=7 wrap=0 generation=12\nx=3,y=3,rule=B3/S23\nbo$2bo$3o!", "rle")
    assert state.cells == [(6, 7), (7, 8), (5, 9), (6, 9), (7, 9)]
    assert state.generation == 12
    with pytest.raises(ValueError):
        parse_state("x=1000000000,y=1\n1000000000o!", "rle", max_cells=10)


def test_json_coordinate_base_and_validation():
    state = parse_state(json.dumps({"width": 10, "height": 10, "coordinate_base": 1, "cells": [[1, 1], [10, 10]]}), "json")
    assert state.cells == [(0, 0), (9, 9)]
    for cells in ([[0, 0], [0, 0]], [[True, 0]], [[10, 0]], [[0, -1]]):
        with pytest.raises(ValueError):
            parse_state(json.dumps({"width": 10, "height": 10, "cells": cells}), "json")


def test_config_rejects_unsupported_gpu_and_unsafe_dimensions():
    with pytest.raises(ValueError):
        merge_config({"engine": {"gpu": "auto"}})
    with pytest.raises(ValueError):
        merge_config({"grid": {"width": 2, "wrap": True}})
    with pytest.raises(ValueError):
        merge_config({"engine": {"tile_size": 96}})


def test_config_uint64_seed_roundtrips_without_precision_loss(tmp_path):
    maximum = (1 << 64) - 1
    path = tmp_path / "config.toml"
    path.write_text('[initial]\nseed = "18446744073709551615"\n', encoding="utf-8")
    loaded = load_config(path)
    assert loaded["initial"]["seed"] == maximum
    exposed = public_config(loaded)
    assert exposed["initial"]["seed"] == "18446744073709551615"
    assert merge_config(json.loads(json.dumps(exposed)))["initial"]["seed"] == maximum
    for value in ("18446744073709551616", "-1", "1.5", "1e8", "1" * 21, True):
        with pytest.raises(ValueError):
            merge_config({"initial": {"seed": value}})


@pytest.mark.parametrize("update", [
    {"engine": {"cpu_min_percent": True}},
    {"engine": {"max_generations_per_second": True}},
    {"checkpoints": {"min_interval_seconds": float("inf")}},
    {"checkpoints": {"min_interval_seconds": float("nan")}},
    {"checkpoints": {"write_mb_per_second": float("inf")}},
    {"checkpoints": {"disk_min_percent": "0"}},
    {"checkpoints": {"disk_max_percent": False}},
    {"display": {"first_level_saturation": True}},
    {"server": {"host": ""}},
])
def test_config_rejects_nonfinite_wrong_type_numbers(update):
    with pytest.raises(ValueError):
        merge_config(update)


@pytest.mark.parametrize("rectangle", [
    {"top_left": "0.1", "bottom_right": "5.5"},
    {"top_left": "2.2", "bottom_right": "1.5"},
    {"top_left": "1.1", "bottom_right": "65.64"},
    {"top_left": "1.1", "bottom_right": "5.5", "extra": 1},
    [],
])
def test_config_validates_random_rectangle_before_startup(rectangle):
    with pytest.raises(ValueError):
        merge_config({"grid": {"width": 64, "height": 64}, "initial": {"rectangle": rectangle}})


@native
@pytest.mark.parametrize("wrap", [False, True])
@pytest.mark.parametrize("shape", [(3, 3), (7, 5), (65, 67), (130, 67)])
def test_native_matches_scalar_at_tile_edges(wrap, shape):
    width, height = shape
    rng = random.Random(width + 1000 * height)
    cells = {(x, y) for y in range(height) for x in range(width) if rng.random() < 0.24}
    engine = NativeEngine(width, height, wrap, tile_size=64, threads=2, cache_mb=4, memory_bytes=128 << 20)
    try:
        engine.import_cells(cells)
        for generation in range(12):
            assert set(engine.cells()) == cells
            assert engine.generation == generation
            cells = scalar(cells, width, height, wrap)
            engine.step()
    finally:
        engine.close()


@native
def test_native_random_is_reproducible_and_rectangle_bounded():
    engines = [NativeEngine(130, 90, tile_size=size, threads=threads, memory_bytes=128 << 20) for size, threads in [(64, 1), (128, 2)]]
    try:
        for engine in engines:
            engine.randomize(0.31, 12345, 60, 3, 30, 70)
        cells = set(engines[0].cells())
        assert cells == set(engines[1].cells())
        assert all(60 <= x < 90 and 3 <= y < 73 for x, y in cells)
        assert engines[0].render(0, 0, 1, 1, 256) == [len(cells)]
    finally:
        for engine in engines:
            engine.close()


@native
def test_checkpoint_integrity_and_roundtrip(tmp_path):
    config = copy.deepcopy(DEFAULTS["checkpoints"])
    config.update({"directory": "snapshots", "segment_mb": 1, "quota_mb": 8, "write_mb_per_second": 1000})
    first = NativeEngine(130, 90, memory_bytes=128 << 20)
    second = NativeEngine(130, 90, memory_bytes=128 << 20)
    try:
        first.randomize(0.31, 121, 0, 0, 130, 90)
        for _ in range(4):
            first.step()
        result = Checkpoints(config, tmp_path).write(first)
        manifest = Path(result["path"])
        metadata = checkpoint_metadata(manifest)
        load_checkpoint_into(manifest, second, metadata)
        assert first.generation == second.generation
        assert set(first.cells()) == set(second.cells())
        first.step()
        second.step()
        assert set(first.cells()) == set(second.cells())
        segment = manifest.parent / metadata["segments"][0]["file"]
        segment.write_bytes(segment.read_bytes() + b"corrupt")
        with pytest.raises(ValueError, match="integrity"):
            load_checkpoint_into(manifest, second, metadata)
    finally:
        first.close()
        second.close()


@native
def test_api_atomic_import_controls_and_security(tmp_path):
    config = merge_config({"grid": {"width": 64, "height": 64},
                           "engine": {"tile_size": 64, "threads": 2, "memory_mb": 256, "cache_mb": 8},
                           "checkpoints": {"directory": str(tmp_path / "snapshots"), "min_interval_seconds": 0}})
    simulation = Simulation(config, tmp_path)
    try:
        with TestClient(create_app(config, simulation), base_url="http://127.0.0.1") as client:
            assert client.post("/api/new", json={"width": 64, "height": 64, "cells": [[31, 30], [31, 31], [31, 32]]}).status_code == 200
            before = client.get("/api/viewport?width=64&height=64").json()
            assert before["run_id"] == client.get("/api/status").json()["run_id"]
            assert client.get("/api/viewport?run_id=stale-world").status_code == 409
            assert sum(before["counts"]) == 3
            bad = client.post("/api/import", json={"format": "rle", "text": "x=3,y=3\n4o!"})
            assert bad.status_code == 400
            assert client.get("/api/viewport?width=64&height=64").json()["counts"] == before["counts"]
            assert client.post("/api/control", json={"action": "step"}).status_code == 200
            deadline = time.monotonic() + 3
            while client.get("/api/status").json()["generation"] < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            status = client.get("/api/status").json()
            assert status["generation"] == 1
            assert client.get("/api/viewport?generation=0").status_code == 409
            exported = client.get("/api/export?format=json")
            assert exported.status_code == 200
            state = parse_state(exported.text, "json")
            assert set(state.cells) == {(30, 31), (31, 31), (32, 31)}
            assert client.post("/api/control", json={"action": "run"}, headers={"origin": "https://evil.example"}).status_code == 403
            assert client.get("/api/status", headers={"host": "evil.example"}).status_code == 403
            assert client.post("/api/checkpoint").status_code == 200
    finally:
        simulation.close()


def test_remote_bind_requires_secret(monkeypatch):
    monkeypatch.delenv("LIFE_ACCESS_TOKEN", raising=False)
    config = merge_config({"server": {"host": "0.0.0.0"}})
    with pytest.raises(ValueError, match="LIFE_ACCESS_TOKEN"):
        create_app(config)


@native
def test_segment_size_quota_and_unrelated_files(tmp_path):
    config = copy.deepcopy(DEFAULTS["checkpoints"])
    config.update({"directory": "snapshots", "segment_mb": 1, "quota_mb": 8, "write_mb_per_second": 1000})
    checkpoint = Checkpoints(config, tmp_path)
    unrelated = checkpoint.directory / "precious.json"
    unrelated.write_text("Do not delete me", encoding="utf-8")
    engine = NativeEngine(512, 512, memory_bytes=128 << 20)
    restored = NativeEngine(512, 512, memory_bytes=128 << 20)
    try:
        engine.randomize(0.99, 22, 0, 0, 512, 512)
        result = checkpoint.write(engine)
        metadata = checkpoint_metadata(Path(result["path"]))
        assert len(metadata["segments"]) >= 2
        assert all(part["bytes"] <= 1 << 20 for part in metadata["segments"])
        load_checkpoint_into(Path(result["path"]), restored, metadata)
        assert set(restored.cells()) == set(engine.cells())
        assert unrelated.read_text("utf-8") == "Do not delete me"
        config["quota_mb"] = 1
        with pytest.raises(ValueError, match="quota"):
            Checkpoints(config, tmp_path).write(engine)
        assert Path(result["path"]).exists()
    finally:
        engine.close()
        restored.close()


@native
def test_strict_checkpoint_saves_after_paused_step(tmp_path):
    config = merge_config({"grid": {"width": 64, "height": 64},
                           "engine": {"tile_size": 64, "threads": 1, "memory_mb": 256, "cache_mb": 4},
                           "checkpoints": {"directory": str(tmp_path / "snapshots"), "mode": "strict",
                                           "every_generations": 1, "min_interval_seconds": 0.15}})
    simulation = Simulation(config, tmp_path)
    try:
        simulation.control("step")
        deadline = time.monotonic() + 3
        while simulation.last_checkpoint is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert simulation.last_checkpoint is not None
        assert simulation.last_checkpoint["generation"] == 1
        assert simulation.status()["generation"] == 1
        assert simulation.running is False
    finally:
        simulation.close()


@native
def test_visual_config_api_uint64_and_live_update_after_world_replacement(tmp_path):
    config = merge_config({"grid": {"width": 64, "height": 64},
                           "engine": {"tile_size": 64, "threads": 1, "memory_mb": 256, "cache_mb": 4},
                           "initial": {"seed": "18446744073709551615", "random": True,
                                       "rectangle": {"top_left": "33.33", "bottom_right": "64.64"}},
                           "checkpoints": {"directory": str(tmp_path / "snapshots")}})
    simulation = Simulation(config, tmp_path)
    try:
        with TestClient(create_app(config, simulation), base_url="http://127.0.0.1") as client:
            exposed = client.get("/api/config").json()
            assert exposed["initial"]["seed"] == "18446744073709551615"
            exposed["engine"]["cpu_max_percent"] = 60
            updated = client.put("/api/config", json=exposed)
            assert updated.status_code == 200
            assert updated.json()["initial"]["seed"] == "18446744073709551615"
            assert simulation.config["initial"]["seed"] == (1 << 64) - 1
            first = client.post("/api/new", json={"width": 16, "height": 16,
                                "random": {"density": 0.3, "seed": "18446744073709551615"}})
            assert first.status_code == 200
            cells_string_seed = client.get("/api/viewport?width=16&height=16").json()["counts"]
            second = client.post("/api/new", json={"width": 16, "height": 16,
                                 "random": {"density": 0.3, "seed": (1 << 64) - 1}})
            assert second.status_code == 200
            assert client.get("/api/viewport?width=16&height=16").json()["counts"] == cells_string_seed
            # Startup rectangle belongs to the former startup grid, not the new live grid.
            assert client.put("/api/config", json={"engine": {"cpu_max_percent": 70}}).status_code == 200
    finally:
        simulation.close()


@native
def test_config_update_serializes_validation_with_world_replacement(tmp_path, monkeypatch):
    import life.runtime as runtime_module
    config = merge_config({"grid": {"width": 64, "height": 64},
                           "engine": {"tile_size": 64, "threads": 1, "memory_mb": 256, "cache_mb": 4},
                           "checkpoints": {"directory": str(tmp_path / "snapshots")}})
    simulation = Simulation(config, tmp_path)
    candidate_built, allow_commit = threading.Event(), threading.Event()
    real_merge = runtime_module.merge_config
    def delayed_merge(*args, **kwargs):
        candidate = real_merge(*args, **kwargs)
        candidate_built.set()
        assert allow_commit.wait(3)
        return candidate
    monkeypatch.setattr(runtime_module, "merge_config", delayed_merge)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            updating = pool.submit(simulation.update_config, {"engine": {"cpu_max_percent": 65}})
            assert candidate_built.wait(3)
            replacing = pool.submit(simulation.new, {"width": 16, "height": 16, "cells": [[1, 1]]})
            try:
                with pytest.raises(FutureTimeout):
                    replacing.result(timeout=0.1)
            finally:
                allow_commit.set()
            assert updating.result(timeout=3)["engine"]["cpu_max_percent"] == 65
            assert replacing.result(timeout=3)["width"] == 16
        assert simulation.config["grid"] == {"width": 16, "height": 16, "wrap": False}
        assert simulation.status()["width"] == 16
        assert simulation.engine.width == 16
        assert simulation.config["engine"]["cpu_max_percent"] == 65
    finally:
        allow_commit.set()
        simulation.close()
