from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import json
from pathlib import Path
import random
import threading
import time
from types import SimpleNamespace

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


def test_rle_export_orders_native_tiles_and_preserves_long_runs_and_gaps():
    width = 2_000_000_000
    height = 100_000
    generation = (1 << 64) - 2
    cells = [(width - 1, height - 1), (4, 3), (5, 3)]
    cells += [(x, 1) for x in reversed(range(63, 300))]
    cells += [(x, 9) for x in range(0, 600, 3)]
    encoded = rle_text(width, height, True, generation, iter(cells))
    lines = encoded.splitlines()[2:]
    assert all(0 < len(line) <= 70 for line in lines)
    assert "".join(lines).startswith("$63b237o2$4b2o6$")
    assert "".join(lines).endswith("99990$1999999999bo!")
    restored = parse_state(encoded, "rle")
    assert (restored.width, restored.height, restored.wrap, restored.generation) == (width, height, True, generation)
    assert restored.cells == sorted(cells, key=lambda cell: (cell[1], cell[0]))
    assert rle_text(5, 5, False, 0, []).splitlines()[-1] == "!"


def test_state_version_rejects_boolean():
    data = {"width": 3, "height": 3, "cells": [], "version": True}
    with pytest.raises(ValueError, match="version"):
        parse_state(json.dumps(data), "json")


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
            for layer in ("life", "cycles"):
                for scale in (4, 64):
                    clipped = client.get("/api/viewport", params={"x": 31, "y": 30, "width": 1, "height": 1,
                                                                   "scale": scale, "layer": layer}).json()
                    assert clipped["counts"] == [1]
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


@pytest.fixture
def small_sim(tmp_path):
    if not library_path().exists():
        pytest.skip("Build the native library")
    config = merge_config({"grid": {"width": 64, "height": 64},
                           "engine": {"tile_size": 64, "threads": 1, "memory_mb": 512, "cache_mb": 0},
                           "checkpoints": {"directory": str(tmp_path / "checkpoints")}})
    simulation = Simulation(config, tmp_path)
    try:
        yield simulation
    finally:
        simulation.close()


def wait_status(simulation, predicate, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = simulation.status()
        if predicate(status):
            return status
        time.sleep(0.005)
    pytest.fail(f"Worker did not reach the expected state: {simulation.status()}")


def test_acknowledged_step_requests_accumulate_and_pause_commits_inflight_generation(small_sim, monkeypatch):
    simulation = small_sim
    # Hold the generation barrier while both commands are accepted before the worker can service either.
    with simulation.lock:
        simulation.control("step", 2)
        assert simulation.control("step", 3)["pending_steps"] == 5
    wait_status(simulation, lambda status: status["generation"] == 5 and status["pending_steps"] == 0)

    entered, release = threading.Event(), threading.Event()
    real_step = simulation.engine.step
    def delayed_step():
        entered.set()
        assert release.wait(4)
        return real_step()
    monkeypatch.setattr(simulation.engine, "step", delayed_step)
    simulation.control("run")
    assert entered.wait(3)
    with ThreadPoolExecutor(max_workers=2) as pool:
        try:
            pausing = pool.submit(simulation.control, "pause")
            status = pool.submit(simulation.status).result(timeout=1)
            assert status["generation"] == 5 and status["running"]
            with pytest.raises(FutureTimeout):
                pausing.result(timeout=0.05)
        finally:
            release.set()
        acknowledged = pausing.result(timeout=3)
    assert acknowledged["generation"] == 6 and acknowledged["pending_steps"] == 0
    assert acknowledged["running"] is False
    assert simulation.viewport(0, 0, 64, 64, 64, generation=6)["generation"] == 6


def test_strict_checkpoint_wait_releases_field_and_rechecks_live_settings(small_sim):
    simulation = small_sim
    simulation.new({"width": 64, "height": 64, "cells": [[10, 11], [11, 11], [12, 11]]})
    simulation.update_config({"checkpoints": {"mode": "strict", "every_generations": 1,
                                               "min_interval_seconds": 3600}})
    simulation.control("step", 3)
    wait_status(simulation, lambda s: s["stage"] == "waiting_for_checkpoint" and s["generation"] == 1)
    with ThreadPoolExecutor(max_workers=2) as pool:
        view = pool.submit(simulation.viewport, 10, 10, 3, 3, 1, 1).result(timeout=2)
        assert view["counts"] == [0, 1, 0, 0, 1, 0, 0, 1, 0]
        paused = pool.submit(simulation.control, "pause").result(timeout=2)
        assert paused["generation"] == 1 and not paused["pending_steps"]
    simulation.update_config({"checkpoints": {"min_interval_seconds": 0}})
    result = wait_status(simulation, lambda s: s["checkpoint"]["last"] is not None)
    saved = result["checkpoint"]["last"]
    assert (saved["run_id"], saved["generation"], saved["population"]) == (view["run_id"], 1, 3)
    manifest = Path(saved["path"])
    restored = NativeEngine(64, 64, tile_size=64, threads=1, cache_mb=0, memory_bytes=64 << 20)
    try:
        load_checkpoint_into(manifest, restored, checkpoint_metadata(manifest))
        assert restored.generation == 1 and set(restored.cells()) == {(11, 10), (11, 11), (11, 12)}
    finally:
        restored.close()


def test_api_rejects_stale_control_and_invalid_random_selection_without_changing_world(small_sim):
    simulation = small_sim
    with TestClient(create_app(simulation.config, simulation), base_url="http://127.0.0.1") as client:
        old = client.get("/api/status").json()
        current = client.post("/api/new", json={"width": 64, "height": 64, "cells": [[15, 15]]}).json()
        for version in ({"run_id": old["run_id"], "generation": 0},
                        {"run_id": current["run_id"], "generation": 1}):
            assert client.post("/api/control", json={"action": "step", **version}).status_code == 409
        assert client.post("/api/new", json={"width": 64, "height": 64, "cells": [[1, 2]],
                                             "random": {}}).status_code == 400
        assert client.post("/api/new", json={"width": 64, "height": 64, "random": {"rect": {}}}).status_code == 400
        unchanged = client.get("/api/status").json()
        assert (unchanged["run_id"], unchanged["generation"], unchanged["population"],
                unchanged["pending_steps"]) == (current["run_id"], 0, 1, 0)
        assert client.post("/api/control", json={"action": "step", "run_id": current["run_id"],
                                                 "generation": 0}).status_code == 200
        wait_status(simulation, lambda s: s["generation"] == 1 and s["population"] == 0)


def test_shutdown_joins_worker_and_rejects_late_mutations(small_sim):
    simulation = small_sim
    simulation.close()
    assert not simulation.thread.is_alive()
    assert simulation.status()["stage"] == "closed"
    for operation in (lambda: simulation.control("run"), lambda: simulation.new({"width": 8, "height": 8}),
                      lambda: simulation.viewport(0, 0, 1, 1, 1), simulation.checkpoint):
        with pytest.raises(RuntimeError, match="closed"):
            operation()
    simulation.close()


def test_shutdown_interrupts_paced_checkpoint_and_retains_previous_snapshot(small_sim):
    simulation = small_sim
    simulation.new({"width": 64, "height": 64, "cells": [[3, 4], [4, 4], [5, 4]]})
    saved = simulation.checkpoint()
    directory = Path(saved["path"]).parent
    original_files = set(directory.iterdir())
    simulation.update_config({"checkpoints": {"min_interval_seconds": 0, "write_mb_per_second": 0.000001}})
    with ThreadPoolExecutor(max_workers=2) as pool:
        writing = pool.submit(simulation.checkpoint)
        wait_status(simulation, lambda s: s["stage"] == "checkpoint")
        pool.submit(simulation.close).result(timeout=3)
        with pytest.raises(RuntimeError, match="cancelled"):
            writing.result(timeout=3)
    assert set(directory.iterdir()) == original_files
    assert checkpoint_metadata(Path(saved["path"]))["population"] == 3


def test_running_field_advances_under_continuous_viewport_reads(small_sim, monkeypatch):
    simulation = small_sim
    simulation.new({"width": 64, "height": 64, "cells": [[20, 21], [21, 21], [22, 21]]})
    simulation.update_config({"engine": {"cpu_max_percent": 100}})
    render = simulation.engine.render
    def slow_render(*args, **kwargs):
        time.sleep(0.002)
        return render(*args, **kwargs)
    monkeypatch.setattr(simulation.engine, "render", slow_render)
    stop = threading.Event()
    gate = threading.Barrier(9)
    def reader():
        gate.wait(timeout=5)
        seen = 0
        while not stop.is_set():
            view = simulation.viewport(20, 20, 3, 3, 1)
            expected = ([0, 0, 0, 1, 1, 1, 0, 0, 0] if view["generation"] % 2 == 0
                        else [0, 1, 0, 0, 1, 0, 0, 1, 0])
            assert view["counts"] == expected
            seen += 1
        return seen
    with ThreadPoolExecutor(max_workers=8) as pool:
        readers = [pool.submit(reader) for _ in range(8)]
        try:
            gate.wait(timeout=5)
            simulation.control("run")
            generation = simulation.status()["generation"]
            wait_status(simulation, lambda state: state["generation"] >= generation + 8)
            simulation.control("pause")
        finally:
            stop.set()
        assert all(f.result(timeout=4) > 0 for f in readers)


def test_checkpoint_retention_tolerates_unrelated_malformed_json(small_sim):
    store = small_sim.checkpoints
    unrelated = store.directory / "life-00000000000000000000-deadbeef1234.json"
    unrelated.write_text("[]", encoding="utf-8")
    checkpoint = small_sim.checkpoint()
    manifest = Path(checkpoint["path"])
    assert checkpoint_metadata(manifest)["population"] == 0 and unrelated.read_bytes() == b"[]"
    data = json.loads(manifest.read_bytes())
    for bad in ([], {**data, "coordinate_base": 1}, {**data, "version": True}, {**data, "segments": [None]}):
        unrelated.write_text(json.dumps(bad), encoding="utf-8")
        with pytest.raises(ValueError):
            checkpoint_metadata(unrelated)


def test_cpu_pacing_includes_controller_work_on_small_fields(small_sim, monkeypatch):
    import life.runtime as runtime
    simulation = small_sim
    simulation.update_config({"engine": {"cpu_max_percent": 20}})
    # Generation timings must still advance when the checkpoint clock stands still.
    checkpoint_tick = time.monotonic()
    monkeypatch.setattr(runtime, "time", SimpleNamespace(monotonic=lambda: checkpoint_tick,
                                                        perf_counter=time.perf_counter, sleep=time.sleep))
    real_stats = simulation.engine.stats
    samples = []
    def delayed_stats():
        samples.append(time.perf_counter())
        time.sleep(0.02)
        return real_stats()
    monkeypatch.setattr(simulation.engine, "stats", delayed_stats)
    simulation.control("step", 2)
    status = wait_status(simulation, lambda s: s["generation"] == 2)
    assert status["last_step_seconds"] > 0 and status["generations_per_second"] > 0
    assert len(samples) == 2
    # At least 20 ms of controller work per generation, paced to 20% utilization.
    assert samples[1] - samples[0] >= 0.09


def test_checkpoint_io_fulfills_elapsed_generation_pacing(small_sim, monkeypatch):
    import life.runtime as runtime
    simulation = small_sim
    simulation.update_config({"engine": {"cpu_max_percent": 20},
                              "checkpoints": {"every_generations": 1, "min_interval_seconds": 0}})
    elapsed_io = 0.0
    monkeypatch.setattr(runtime, "time", SimpleNamespace(monotonic=time.monotonic,
                                                        perf_counter=lambda: time.perf_counter() + elapsed_io,
                                                        sleep=time.sleep))
    real_write = simulation.checkpoints.write
    def paced_write(*args):
        nonlocal elapsed_io
        saved = real_write(*args)
        elapsed_io += 60.0
        return saved
    monkeypatch.setattr(simulation.checkpoints, "write", paced_write)
    simulation.control("step", 2)
    wait_status(simulation, lambda s: s["checkpoint"]["last"] and s["checkpoint"]["last"]["generation"] == 2)
    assert elapsed_io == 120


@pytest.mark.parametrize("rate", [0, 1000])
def test_short_cpu_waits_accumulate_while_explicit_rate_caps_each_step(small_sim, monkeypatch, rate):
    import life.runtime as runtime
    sim = small_sim
    sim.update_config({"engine": {"cpu_max_percent": 90, "max_generations_per_second": rate}})
    now = 1.0
    starts, sleeps = [], []
    work = 0.0001
    native_step = sim.engine.step
    def measured_step():
        nonlocal now
        starts.append(now)
        now += work
        return native_step()
    def precise_sleep(seconds):
        nonlocal now
        sleeps.append(seconds)
        now += seconds
    monkeypatch.setattr(runtime, "CPU_BATCH_SECONDS", 0.002)
    monkeypatch.setattr(runtime, "SHORT_WAIT_SECONDS", 0.016)
    monkeypatch.setattr(runtime, "time", SimpleNamespace(monotonic=time.monotonic,
                                                        perf_counter=lambda: now, sleep=precise_sleep))
    monkeypatch.setattr(sim.engine, "step", measured_step)
    sim.control("step", 500)
    wait_status(sim, lambda s: s["generation"] == 500)
    assert len(starts) == 500
    if rate:
        assert len(sleeps) == 499
        assert all(later - earlier == pytest.approx(1 / rate, abs=1e-9)
                   for earlier, later in zip(starts, starts[1:]))
    else:
        assert 1 <= len(sleeps) <= 3
        # At most one unspent 2 ms batch (and the final step) is outstanding.
        desired_idle = len(starts) * work / 9
        assert 0 <= desired_idle - sum(sleeps) <= 0.002 + work


@pytest.mark.parametrize("action", ["pause", "new", "close"])
def test_short_sleep_releases_field_and_rechecks_controls(small_sim, monkeypatch, action):
    import life.runtime as runtime
    sim = small_sim
    sim.update_config({"engine": {"max_generations_per_second": 100}})
    entered, release = threading.Event(), threading.Event()
    def gated_sleep(delay):
        assert 0 < delay <= 0.016
        entered.set()
        assert release.wait(3)
    monkeypatch.setattr(runtime, "SHORT_WAIT_SECONDS", 0.016)
    monkeypatch.setattr(runtime, "time", SimpleNamespace(monotonic=time.monotonic,
                                                        perf_counter=lambda: 1.0, sleep=gated_sleep))
    sim.control("step", 2)
    assert entered.wait(2)
    with ThreadPoolExecutor(max_workers=1) as pool:
        try:
            if action == "pause":
                assert pool.submit(sim.control, "pause").result(timeout=1)["generation"] == 1
            elif action == "new":
                assert pool.submit(sim.new, {"width": 23, "height": 17}).result(timeout=1)["generation"] == 0
            else:
                closing = pool.submit(sim.close)
                wait_status(sim, lambda s: s["stage"] == "closed", timeout=1)
        finally:
            release.set()
        if action == "close":
            closing.result(timeout=2)
    status = sim.status()
    assert status["generation"] == (0 if action == "new" else 1)
    assert not status["pending_steps"] and not status["running"]
