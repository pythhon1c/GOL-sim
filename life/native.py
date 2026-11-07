"""Small ctypes binding; all authoritative cells live in the native engine."""
from __future__ import annotations

import ctypes as C
import os
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent.parent
U64_MAX = (1 << 64) - 1


def library_path() -> Path:
    override = os.environ.get("LIFE_NATIVE_LIBRARY")
    if override:
        return Path(override)
    name = "life_native.dll" if os.name == "nt" else "liblife_native.dylib" if __import__("sys").platform == "darwin" else "liblife_native.so"
    return ROOT / "native" / "target" / "release" / name


def load_library() -> C.CDLL:
    path = library_path()
    if not path.exists():
        raise RuntimeError(f"Native engine missing: {path}. Build it with cargo build --release --manifest-path native/Cargo.toml")
    lib = C.CDLL(str(path))
    pointer = C.c_void_p
    specs = {
        "life_create": ([C.c_uint32] * 5, pointer),
        "life_destroy": ([pointer], None),
        "life_set_wrap": ([pointer, C.c_uint8], C.c_uint8),
        "life_set_cell": ([pointer, C.c_uint32, C.c_uint32, C.c_uint8], C.c_uint8),
        "life_get_cell": ([pointer, C.c_uint32, C.c_uint32], C.c_uint8),
        "life_step": ([pointer], C.c_uint64),
        "life_generation": ([pointer], C.c_uint64),
        "life_population": ([pointer], C.c_uint64),
        "life_clear": ([pointer], None),
        "life_set_generation": ([pointer, C.c_uint64], None),
        "life_import_cells": ([pointer, C.POINTER(C.c_uint64), C.c_size_t], C.c_uint8),
        "life_export_cells": ([pointer, C.POINTER(C.c_uint64), C.c_size_t], C.c_size_t),
        "life_render": ([pointer, C.c_uint32, C.c_uint32, C.c_uint32, C.c_uint32, C.c_uint32, C.POINTER(C.c_uint64)], C.c_uint8),
        "life_stat": ([pointer, C.c_uint32], C.c_uint64),
        "life_last_error": ([pointer], C.c_char_p),
        "life_set_memory_limit": ([pointer, C.c_uint64], C.c_uint8),
    }
    optional = {
        "life_randomize": ([pointer, C.c_uint32, C.c_uint32, C.c_uint32, C.c_uint32, C.c_double, C.c_uint64], C.c_uint8),
        "life_export_range": ([pointer, C.c_uint64, C.POINTER(C.c_uint64), C.c_size_t], C.c_size_t),
        "life_progress": ([pointer, C.c_uint32], C.c_uint64),
        "life_configure_cycles": ([pointer, C.c_uint32, C.c_uint64, C.c_uint32, C.c_uint32, C.c_uint32], C.c_uint8),
        "life_cluster_info": ([pointer, C.c_uint32, C.c_uint32, C.c_uint32], C.c_uint64),
        "life_render_cycles": ([pointer, C.c_uint32, C.c_uint32, C.c_uint32, C.c_uint32, C.c_uint32,
                                C.POINTER(C.c_uint64), C.POINTER(C.c_uint64), C.POINTER(C.c_double),
                                C.POINTER(C.c_uint32)], C.c_uint8),
    }
    for name, (args, result) in {**specs, **optional}.items():
        if name in optional and not hasattr(lib, name):
            continue
        function = getattr(lib, name)
        function.argtypes = args
        function.restype = result
    return lib


class NativeEngine:
    def __init__(self, width: int, height: int, wrap: bool = False, tile_size: int = 128,
                 threads: int = 1, memory_bytes: int = 2 << 30, cache_mb: int = 128):
        self.width, self.height, self.wrap = width, height, wrap
        self.memory_bytes = memory_bytes
        self.lib = load_library()
        self.handle = self.lib.life_create(width, height, tile_size, threads, cache_mb)
        if not self.handle:
            raise RuntimeError("Native engine could not allocate its initial state")
        try:
            self._check(self.lib.life_set_memory_limit(self.handle, memory_bytes))
            self._check(self.lib.life_set_wrap(self.handle, int(wrap)))
        except BaseException:
            self.close()
            raise

    def _check(self, ok: int) -> None:
        if not ok:
            message = self.lib.life_last_error(self.handle)
            raise RuntimeError(message.decode("utf-8", "replace") if message else "Native operation failed")

    def close(self) -> None:
        if getattr(self, "handle", None):
            self.lib.life_destroy(self.handle)
            self.handle = None

    def __del__(self):
        self.close()

    @property
    def generation(self) -> int:
        return int(self.lib.life_generation(self.handle))

    @generation.setter
    def generation(self, value: int) -> None:
        self.lib.life_set_generation(self.handle, value)

    @property
    def population(self) -> int:
        return int(self.lib.life_population(self.handle))

    def step(self) -> int:
        result = int(self.lib.life_step(self.handle))
        if result == U64_MAX:
            self._check(0)
        return result

    def import_packed(self, values: Iterable[int]) -> None:
        items = list(values)
        data = (C.c_uint64 * len(items))(*items)
        self._check(self.lib.life_import_cells(self.handle, data, len(items)))

    def import_cells(self, cells: Iterable[tuple[int, int]]) -> None:
        batch = []
        for x, y in cells:
            if not (0 <= x < self.width and 0 <= y < self.height):
                raise ValueError(f"Cell outside field: {x}.{y}")
            batch.append((y << 32) | x)
            if len(batch) == 65536:
                self.import_packed(batch)
                batch.clear()
        if batch:
            self.import_packed(batch)

    def iter_packed(self, batch_size: int = 65536):
        population = self.population
        if hasattr(self.lib, "life_export_range"):
            buffer = (C.c_uint64 * batch_size)()
            offset = 0
            while offset < population:
                count = int(self.lib.life_export_range(self.handle, offset, buffer, batch_size))
                if not count or count > batch_size:
                    raise RuntimeError("Native export returned an invalid chunk")
                yield from buffer[:count]
                offset += count
        else:
            if population * 16 > self.memory_bytes // 4:
                raise ValueError("Export exceeds memory budget; native chunked export is required")
            buffer = (C.c_uint64 * population)()
            count = int(self.lib.life_export_cells(self.handle, buffer, population))
            if count != population:
                raise RuntimeError("Native export changed during snapshot")
            yield from buffer

    def cells(self):
        for cell in self.iter_packed():
            yield cell & 0xFFFFFFFF, cell >> 32

    def randomize(self, density: float, seed: int, x: int, y: int, width: int, height: int):
        if not hasattr(self.lib, "life_randomize"):
            raise RuntimeError("Native randomization is unavailable. Rebuild the native engine for splitmix64-coordinate-v1.")
        from .config import seed_value
        self._check(self.lib.life_randomize(self.handle, x, y, width, height, density, seed_value(seed)))

    def render(self, x: int, y: int, columns: int, rows: int, scale: int) -> list[int]:
        data = (C.c_uint64 * (columns * rows))()
        self._check(self.lib.life_render(self.handle, x, y, columns, rows, scale, data))
        return list(data)

    @property
    def supports_cycles(self) -> bool:
        return hasattr(self.lib, "life_configure_cycles") and hasattr(self.lib, "life_render_cycles")

    def configure_cycles(self, cycles_enabled: bool, cycles_start_generation: int, cycles_max_period: int,
                         cycles_memory_mb: int, cycles_detection_interval: int) -> None:
        from .config import integer
        if type(cycles_enabled) is not bool:
            raise ValueError("cycles_enabled must be boolean")
        integer(cycles_start_generation, 0, U64_MAX, "cycles_start_generation")
        integer(cycles_max_period, 1, 64, "cycles_max_period")
        integer(cycles_memory_mb, 0, 1_048_576, "cycles_memory_mb")
        integer(cycles_detection_interval, 1, 65535, "cycles_detection_interval")
        if not self.supports_cycles:
            if cycles_enabled:
                raise RuntimeError("This native library does not support guarded cycles; rebuild the native engine")
            return
        self._check(self.lib.life_configure_cycles(self.handle, int(cycles_enabled), cycles_start_generation,
                                                  cycles_max_period, cycles_memory_mb, cycles_detection_interval))

    def cluster_info(self, tile_x: int, tile_y: int) -> dict:
        if not self.supports_cycles or not hasattr(self.lib, "life_cluster_info"):
            raise RuntimeError("Guarded cycle metadata is unavailable in this native library")
        names = ("population", "period", "replayed", "state")
        return {name: int(self.lib.life_cluster_info(self.handle, tile_x, tile_y, code))
                for code, name in enumerate(names)}

    def render_cycles(self, x: int, y: int, columns: int, rows: int, scale: int) -> tuple[list[int], dict]:
        if not self.supports_cycles:
            raise RuntimeError("Guarded cycle metadata is unavailable; rebuild the native engine")
        count = columns * rows
        counts = (C.c_uint64 * count)()
        known_live = (C.c_uint64 * count)()
        logarithms = (C.c_double * count)()
        periods = (C.c_uint32 * count)()
        self._check(self.lib.life_render_cycles(self.handle, x, y, columns, rows, scale,
                                                counts, known_live, logarithms, periods))
        return list(counts), {"known_live": list(known_live), "period_log2_sum": list(logarithms),
                              "period_max": list(periods), "period_reference": 64,
                              "weighting": "live_population", "unknown_period": 0}

    def stats(self) -> dict:
        names = ("nonempty_tiles", "cache_hits", "computed_tiles", "cache_bytes", "unchanged_tiles",
                 "empty_candidates", "estimated_native_bytes", "candidate_tiles", "tile_size", "threads",
                 "memory_budget_bytes", "step_microseconds", "cache_entries", "skipped_empty_tiles",
                 "period2_tiles", "higher_period_tiles", "max_observed_period", "history_bytes",
                 "watched_cycles", "cycle_replays", "cycle_wakes", "cycle_captures", "cycle_bytes",
                 "cycles_start_generation", "cycles_enabled", "cycle_probes", "cycles_max_period",
                 "cycles_budget_bytes")
        return {name: int(self.lib.life_stat(self.handle, i)) for i, name in enumerate(names)}

    def progress(self):
        if not hasattr(self.lib, "life_progress"):
            return 0, 0, 0
        return tuple(int(self.lib.life_progress(self.handle, i)) for i in range(3))
