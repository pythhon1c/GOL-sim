"""A single generation owner; readers observe complete immutable generations."""
from __future__ import annotations

import copy
from collections import deque
import json
from pathlib import Path
import threading
import time
import uuid

import psutil

from .checkpoint import Checkpoints, checkpoint_metadata, load_checkpoint_into
from .config import CYCLE_KEYS, cycle_settings, integer, merge_config, random_rectangle, resolved_engine, seed_value, validate_grid
from .formats import MAX_IMPORT_CELLS, State, parse_state
from .native import NativeEngine, ROOT


class Simulation:
    def __init__(self, config: dict, root: Path = ROOT, engine_factory=NativeEngine):
        self.config = merge_config(config)
        config = self.config
        self.root = root
        self.engine_factory = engine_factory
        self.effective = resolved_engine(config)
        if engine_factory is NativeEngine and config["engine"]["tile_size"] == "auto":
            try:
                from .autotune import choose_tile_size
                self.effective["tile_size"] = choose_tile_size(self.effective)
            except ImportError:
                pass
        self.lock = threading.RLock()
        self.meta_lock = threading.Lock()
        self.progress_lock = threading.Lock()
        self.wake = threading.Event()
        self.stop_event = threading.Event()
        self.running = False
        self.pending_steps = 0
        self.error = None
        self.run_id = uuid.uuid4().hex
        self.metadata_revision = 0
        self.stage = "idle"
        self.started_step = 0.0
        self.last_step_seconds = 0.0
        self.completions = deque(maxlen=32)
        self.last_checkpoint = None
        self.checkpoint_error = None
        self.checkpoint_started = time.monotonic()
        self.checkpoint_generation = 0
        self.engine = self._make_engine(**config["grid"], effective=self.effective)
        self.checkpoints = Checkpoints(config["checkpoints"], root)
        self.process = psutil.Process()
        self.process.cpu_percent()
        self.snapshot = {}
        try:
            self._initial_state()
            self._refresh()
        except BaseException:
            self.engine.close()
            raise
        self.thread = threading.Thread(target=self._loop, name="life-generation-owner", daemon=True)
        self.thread.start()

    def _initial_state(self):
        initial = self.config["initial"]
        if initial["path"]:
            path = Path(initial["path"])
            path = path if path.is_absolute() else self.root / path
            if path.stat().st_size > 64 << 20:
                raise ValueError("Initial text state exceeds 64 MiB; use segmented checkpoints")
            if path.suffix.lower() == ".rle":
                state = parse_state(path.read_text("utf-8"), "rle")
                self._replace_state(state)
            else:
                data = json.loads(path.read_text("utf-8"))
                if data.get("format") == "exact-life-checkpoint":
                    metadata = checkpoint_metadata(path)
                    replacement = self._replacement(metadata["width"], metadata["height"], metadata["wrap"])
                    try:
                        load_checkpoint_into(path, replacement, metadata)
                        self._swap(replacement)
                    except BaseException:
                        replacement.close()
                        raise
                else:
                    self._replace_state(parse_state(json.dumps(data), "json"))
        elif initial["random"]:
            rectangle = self._config_rectangle(initial.get("rectangle"))
            self.engine.randomize(initial["density"], initial["seed"], **rectangle)
        self.checkpoint_generation = self.engine.generation

    def _config_rectangle(self, rectangle: dict | None) -> dict:
        return random_rectangle(rectangle, self.engine.width, self.engine.height)

    def _make_engine(self, width, height, wrap, effective):
        engine = self.engine_factory(width, height, wrap, **effective)
        try:
            if getattr(engine, "supports_cycles", False):
                engine.configure_cycles(**cycle_settings(self.config))
            return engine
        except BaseException:
            engine.close()
            raise

    def _replacement(self, width, height, wrap):
        effective = self.effective.copy()
        occupied = self.engine.stats().get("estimated_native_bytes", 0)
        effective["memory_bytes"] -= occupied
        if effective["memory_bytes"] < 32 << 20:
            raise ValueError("Insufficient memory budget for an atomic state replacement; raise memory_mb")
        return self._make_engine(width, height, wrap, effective)

    def _swap(self, replacement):
        if isinstance(replacement, NativeEngine):
            replacement._check(replacement.lib.life_set_memory_limit(replacement.handle, self.effective["memory_bytes"]))
            replacement.memory_bytes = self.effective["memory_bytes"]
        with self.progress_lock:
            old = self.engine
            self.engine = replacement
            old.close()
            self.run_id = uuid.uuid4().hex
            self.metadata_revision += 1
        self.config["grid"] = {"width": replacement.width, "height": replacement.height, "wrap": replacement.wrap}
        self.checkpoint_generation = replacement.generation
        self.checkpoint_started = time.monotonic()
        self.last_step_seconds = 0
        self.completions.clear()
        self.pending_steps = 0
        self.error = None

    def _replace_state(self, state: State):
        replacement = self._replacement(state.width, state.height, state.wrap)
        try:
            replacement.import_cells(state.cells)
            replacement.generation = state.generation
            self._swap(replacement)
        except BaseException:
            replacement.close()
            raise

    def replace_state(self, state: State):
        with self.lock:
            was_running = self.running
            self.running = False
            try:
                self._replace_state(state)
                self.stage = "idle"
                self._refresh()
            except BaseException:
                self.running = was_running
                raise
        return self.status()

    def new(self, data: dict):
        width, height, wrap = data.get("width"), data.get("height"), data.get("wrap", False)
        validate_grid(width, height, wrap)
        cells = data.get("cells", [])
        if not isinstance(cells, list) or len(cells) > MAX_IMPORT_CELLS:
            raise ValueError(f"At most {MAX_IMPORT_CELLS} explicit cells are accepted; use native randomization for dense fields")
        # Reuse strict parsing before creating or mutating any native state.
        state = parse_state(json.dumps({"width": width, "height": height, "wrap": wrap, "cells": cells}), "json")
        random_spec = data.get("random")
        if random_spec and cells:
            raise ValueError("Choose explicit cells or random initialization")
        if random_spec is not None:
            if not isinstance(random_spec, dict):
                raise ValueError("random must be an object")
            density, seed = random_spec.get("density", 0.15), random_spec.get("seed", 42)
            if not isinstance(density, (int, float)) or not 0.01 <= density <= 0.99:
                raise ValueError("density must be between 0.01 and 0.99")
            seed = seed_value(seed)
            rect = random_spec.get("rect") or {"x": 0, "y": 0, "width": width, "height": height}
            if not isinstance(rect, dict) or set(rect) != {"x", "y", "width", "height"}:
                raise ValueError("Random rect requires x,y,width,height")
            integer(rect["x"], 0, width - 1, "random x")
            integer(rect["y"], 0, height - 1, "random y")
            integer(rect["width"], 1, width - rect["x"], "random width")
            integer(rect["height"], 1, height - rect["y"], "random height")
        with self.lock:
            replacement = self._replacement(width, height, wrap)
            try:
                if random_spec is not None:
                    replacement.randomize(density, seed, **rect)
                else:
                    replacement.import_cells(state.cells)
                self.running = False
                self._swap(replacement)
                self.stage = "idle"
                self._refresh()
            except BaseException:
                replacement.close()
                raise
        return self.status()

    def _refresh(self):
        stats = self.engine.stats()
        supported = bool(getattr(self.engine, "supports_cycles", False))
        cycle_config = self.config["engine"]
        cycle_status = {
            "supported": supported,
            "requested_enabled": cycle_config["cycles_enabled"],
            "enabled": supported and bool(stats.get("cycles_enabled", 0)),
            "start_generation": cycle_config["cycles_start_generation"],
            "max_period": cycle_config["cycles_max_period"],
            "memory_mb": cycle_config["cycles_memory_mb"],
            "detection_interval": cycle_config["cycles_detection_interval"],
            "watched_clusters": stats.get("watched_cycles", 0),
            "last_replays": stats.get("cycle_replays", 0),
            "last_wakes": stats.get("cycle_wakes", 0),
            "candidate_captures": stats.get("cycle_captures", 0),
            "probes": stats.get("cycle_probes", 0),
            "bytes": stats.get("cycle_bytes", 0),
            "budget_bytes": stats.get("cycles_budget_bytes", 0),
            "period_semantics": "Exact current phase and boundary guard; future external changes may invalidate the cycle",
            "message": None if supported else "This native library has no guarded-cycle engine; rebuild to enable it",
        }
        snapshot = {"width": self.engine.width, "height": self.engine.height, "wrap": self.engine.wrap, "run_id": self.run_id,
                    "metadata_revision": self.metadata_revision, "cycles": cycle_status,
                    "generation": self.engine.generation, "population": self.engine.population, "rule": "B3/S23",
                    "engine": "Rust / tiled exact B3/S23", "effective_engine": self.effective.copy(),
                    "tiles": stats, "gpu_supported": False,
                    "capabilities": {"cpu": True, "gpu": False, "distributed": False, "guarded_cycles": supported,
                                     "life_viewport_bins": 2_097_152, "cycle_viewport_bins": 524_288,
                                     "memory_limit": "estimated native allocations plus monitored process RSS; not an OS hard cap",
                                     "cpu_limit": "average cooperative duty-cycle limit",
                                     "disk_limit": "paced checkpoint writes and directory quota"}}
        with self.meta_lock:
            self.snapshot = snapshot

    def status(self):
        with self.meta_lock:
            result = copy.deepcopy(self.snapshot)
        progress, eta = None, None
        phase = self.stage
        if self.stage == "stepping":
            with self.progress_lock:
                engine = self.engine
                if hasattr(engine, "progress"):
                    completed, total, native_phase = engine.progress()
                    if total and native_phase == 2:
                        progress = min(1.0, completed / total)
                        elapsed = time.monotonic() - self.started_step
                        if completed:
                            eta = elapsed * (total - completed) / completed
                    phase = {0: "idle", 1: "preparing", 2: "computing", 3: "committing"}.get(native_phase, self.stage)
        rss = self.process.memory_info().rss
        completions = list(self.completions)
        observed_rate = (len(completions) - 1) / (completions[-1] - completions[0]) if len(completions) > 1 and completions[-1] > completions[0] else 0
        result.update({"running": self.running, "pending_steps": self.pending_steps, "stage": phase,
                       "progress": progress, "eta_seconds": eta, "eta_estimated": eta is not None,
                       "generations_per_second": observed_rate,
                       "native_generations_per_second": 1 / self.last_step_seconds if self.last_step_seconds else 0,
                       "max_generations_per_second": self.config["engine"]["max_generations_per_second"],
                       "last_step_seconds": self.last_step_seconds, "error": self.error,
                       "resources": {"process_id": self.process.pid, "rss_bytes": rss, "cpu_percent": self.process.cpu_percent() / (psutil.cpu_count() or 1),
                                     "logical_cpus": psutil.cpu_count()},
                       "checkpoint": {"last": self.last_checkpoint, "error": self.checkpoint_error,
                                      "next_generation": self.checkpoint_generation + self.config["checkpoints"]["every_generations"],
                                      "seconds_until_write_allowed": max(0, self.config["checkpoints"]["min_interval_seconds"] - (time.monotonic() - self.checkpoint_started))}})
        return result

    def control(self, action: str, steps: int = 1, generations_per_second: float = 0):
        if action == "pause":
            self.running = False
            self.pending_steps = 0
        elif action == "run":
            self.error = None
            self.running = True
        elif action == "step":
            integer(steps, 1, 10000, "steps")
            self.running = False
            self.error = None
            self.pending_steps = steps
        elif action == "speed":
            if not isinstance(generations_per_second, (int, float)) or not 0 <= generations_per_second <= 1_000_000:
                raise ValueError("generations_per_second must be from 0 (unlimited) through 1000000")
            with self.lock:
                self.config["engine"]["max_generations_per_second"] = generations_per_second
        else:
            raise ValueError("action must be run, pause, step, or speed")
        self.wake.set()
        return self.status()

    def _save_locked(self):
        self.stage = "checkpoint"
        self.last_checkpoint = self.checkpoints.write(self.engine, self.stop_event)
        self.checkpoint_started = time.monotonic()
        self.checkpoint_generation = self.engine.generation
        self.checkpoint_error = None
        self.stage = "idle"

    def checkpoint(self):
        with self.lock:
            if self.last_checkpoint and time.monotonic() - self.checkpoint_started < self.config["checkpoints"]["min_interval_seconds"]:
                raise ValueError("Minimum checkpoint interval has not elapsed")
            try:
                self._save_locked()
            except BaseException as exc:
                self.checkpoint_error = str(exc)
                self.stage = "idle"
                raise
        return self.last_checkpoint

    def _checkpoint_due(self) -> bool:
        cp = self.config["checkpoints"]
        return self.engine.generation - self.checkpoint_generation >= cp["every_generations"]

    def _loop(self):
        while not self.stop_event.is_set():
            if not self.running and not self.pending_steps:
                cp = self.config["checkpoints"]
                with self.lock:
                    checkpoint_due = cp["mode"] == "strict" and self.error is None and self._checkpoint_due()
                if checkpoint_due:
                    if time.monotonic() - self.checkpoint_started >= cp["min_interval_seconds"]:
                        try:
                            with self.lock:
                                if self._checkpoint_due():
                                    self._save_locked()
                        except BaseException as exc:
                            self.checkpoint_error = self.error = str(exc)
                            self.stage = "error"
                    else:
                        self.stage = "waiting_for_checkpoint"
                self.wake.wait(0.2)
                self.wake.clear()
                continue
            started = time.monotonic()
            try:
                with self.lock:
                    if not self.running and not self.pending_steps:
                        continue
                    cp = self.config["checkpoints"]
                    if self._checkpoint_due():
                        remaining = cp["min_interval_seconds"] - (time.monotonic() - self.checkpoint_started)
                        if remaining <= 0:
                            self._save_locked()
                        elif cp["mode"] == "strict":
                            self.stage = "waiting_for_checkpoint"
                            self.stop_event.wait(min(0.2, remaining))
                            continue
                    self.stage = "stepping"
                    self.started_step = time.monotonic()
                    self.engine.step()
                    self.last_step_seconds = time.monotonic() - self.started_step
                    self.completions.append(time.monotonic())
                    if self.pending_steps:
                        self.pending_steps -= 1
                    self.stage = "idle"
                    self._refresh()
                    if self._checkpoint_due() and time.monotonic() - self.checkpoint_started >= cp["min_interval_seconds"]:
                        self._save_locked()
                budget = self.config["engine"]["memory_mb"]
                if budget != "auto" and self.process.memory_info().rss > budget << 20:
                    raise RuntimeError("Process memory budget reached; simulation paused with its last complete generation preserved")
                throttle = (time.monotonic() - started) * (100 / self.config["engine"]["cpu_max_percent"] - 1)
                rate = self.config["engine"]["max_generations_per_second"]
                if rate:
                    throttle = max(throttle, 1 / rate - (time.monotonic() - started))
                self.wake.wait(max(0, throttle))
                self.wake.clear()
            except BaseException as exc:
                self.error = str(exc)
                if self.stage == "checkpoint":
                    self.checkpoint_error = str(exc)
                self.running = False
                self.pending_steps = 0
                self.stage = "error"

    def viewport(self, x, y, width, height, scale, generation=None, run_id=None, layer="life", metadata_revision=None):
        integer(x, 0, 1_999_999_999, "x")
        integer(y, 0, 1_999_999_999, "y")
        integer(width, 1, 2_000_000_000, "width")
        integer(height, 1, 2_000_000_000, "height")
        integer(scale, 1, 1 << 30, "scale")
        if scale & (scale - 1):
            raise ValueError("scale must be a power of two")
        if layer not in ("life", "cycles"):
            raise ValueError("layer must be life or cycles")
        if metadata_revision is not None:
            integer(metadata_revision, 0, (1 << 63) - 1, "metadata_revision")
        columns, rows = (width + scale - 1) // scale, (height + scale - 1) // scale
        limit = 524_288 if layer == "cycles" else 2_097_152
        if columns * rows > limit:
            raise ValueError(f"Viewport exceeds {limit:,} {layer} bins; increase scale")
        with self.lock:
            if run_id is not None and run_id != self.run_id:
                raise StaleGeneration("Requested world has been replaced")
            if generation is not None and generation != self.engine.generation:
                raise StaleGeneration("Requested generation is no longer current")
            if metadata_revision is not None and metadata_revision != self.metadata_revision:
                raise StaleGeneration("Requested cycle metadata has changed")
            if x >= self.engine.width or y >= self.engine.height:
                raise ValueError("Viewport origin is outside the field")
            cycles = None
            if layer == "cycles":
                counts, cycles = self.engine.render_cycles(x, y, columns, rows, scale)
            else:
                counts = self.engine.render(x, y, columns, rows, scale)
            result = {"generation": self.engine.generation, "population": self.engine.population, "run_id": self.run_id,
                    "metadata_revision": self.metadata_revision, "layer": layer,
                    "x": x, "y": y, "width": width, "height": height, "scale": scale,
                    "columns": columns, "rows": rows, "counts": counts}
            if cycles is not None:
                result["cycles"] = cycles
            return result

    def update_config(self, update: dict):
        with self.lock:
            # Validate and commit against one generation/world/config version. A concurrent
            # New/Import must never have its grid settings overwritten by a stale candidate.
            candidate = merge_config(update, self.config, validate_initial_bounds=False)
            if candidate["grid"] != self.config["grid"] or candidate["initial"] != self.config["initial"]:
                raise ValueError("Use New/Import to change the field; initial file settings apply at startup")
            native_keys = ("tile_size", "threads", "memory_mb", "cache_mb")
            if any(candidate["engine"][key] != self.config["engine"][key] for key in native_keys):
                raise ValueError("Native tile/thread/memory/cache settings require a restart using config.toml")
            if candidate["server"] != self.config["server"]:
                raise ValueError("Server binding changes require a restart")
            checkpoints = Checkpoints(candidate["checkpoints"], self.root)
            cycles_changed = any(candidate["engine"][key] != self.config["engine"][key] for key in CYCLE_KEYS)
            if cycles_changed:
                if not getattr(self.engine, "supports_cycles", False):
                    if candidate["engine"]["cycles_enabled"]:
                        raise RuntimeError("This native library does not support guarded cycles; rebuild it before enabling this feature")
                else:
                    self.engine.configure_cycles(**cycle_settings(candidate))
            self.config = candidate
            self.checkpoints = checkpoints
            if cycles_changed:
                self.metadata_revision += 1
                self._refresh()
            return copy.deepcopy(self.config)

    def close(self):
        self.running = False
        self.pending_steps = 0
        self.stop_event.set()
        self.wake.set()
        self.thread.join()
        with self.lock, self.progress_lock:
            self.engine.close()


class StaleGeneration(ValueError):
    pass
