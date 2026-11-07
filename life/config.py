from __future__ import annotations

import copy
import ctypes
import math
import os
from pathlib import Path
import re
import tomllib


DEFAULTS = {
    "server": {"host": "127.0.0.1", "port": 8765},
    "grid": {"width": 4096, "height": 4096, "wrap": False},
    "engine": {"tile_size": "auto", "threads": "auto", "memory_mb": "auto", "cache_mb": 128,
               "cpu_max_percent": 90, "cpu_min_percent": 0, "gpu": "off", "gpu_max_percent": 100, "gpu_min_percent": 0,
               "max_generations_per_second": 0, "cycles_enabled": True, "cycles_start_generation": 128,
               "cycles_max_period": 16, "cycles_memory_mb": 128, "cycles_detection_interval": 8},
    "initial": {"path": "", "random": False, "seed": 42, "density": 0.15},
    "checkpoints": {"directory": "checkpoints", "every_generations": 1000, "min_interval_seconds": 1800,
                    "mode": "coalesce", "segment_mb": 256, "quota_mb": 10240,
                    "write_mb_per_second": 32, "disk_min_percent": 0, "disk_max_percent": 100},
    "display": {"gradient_levels": 32, "first_level_saturation": 4.0, "upper_level_saturation": 1.5, "tile_cache_mb": 64,
                "heat_stable": 0.08, "heat_cycle_max": 0.45, "heat_active": 0.65,
                "heat_density_gain": 0.30, "heat_density_reference": 0.15, "heat_hotspot_mix": 0.25},
}

CYCLE_KEYS = ("cycles_enabled", "cycles_start_generation", "cycles_max_period",
              "cycles_memory_mb", "cycles_detection_interval")


def cycle_settings(config: dict) -> dict:
    engine = config["engine"]
    return {key: engine[key] for key in CYCLE_KEYS}


def available_memory() -> int:
    if os.name == "nt":
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in
                       ("total_phys", "avail_phys", "total_page", "avail_page", "total_virtual", "avail_virtual", "extended")]
        status = MEMORYSTATUSEX()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.avail_phys)
    try:
        return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, AttributeError):
        return 4 << 30


def merge_config(update: dict, base: dict | None = None, *, validate_initial_bounds: bool = True) -> dict:
    result = copy.deepcopy(base or DEFAULTS)
    for section, values in update.items():
        if section not in result or not isinstance(values, dict):
            raise ValueError(f"Unknown configuration section: {section}")
        for key, value in values.items():
            if key not in result[section] and not (section == "initial" and key == "rectangle"):
                raise ValueError(f"Unknown configuration setting: {section}.{key}")
            result[section][key] = value
    result["initial"]["seed"] = seed_value(result["initial"]["seed"])
    validate_config(result, validate_initial_bounds=validate_initial_bounds)
    return result


def integer(value, low: int, high: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{label} must be an integer between {low} and {high}")
    return value


def seed_value(value) -> int:
    """Accept uint64 decimal strings without passing through JavaScript's float type."""
    if isinstance(value, str):
        if not re.fullmatch(r"[0-9]{1,20}", value):
            raise ValueError("seed must be a uint64 integer or a decimal string of at most 20 digits")
        value = int(value)
    return integer(value, 0, (1 << 64) - 1, "seed")


def public_config(config: dict) -> dict:
    """JSON representation preserves the entire uint64 seed range in browsers."""
    result = copy.deepcopy(config)
    result["initial"]["seed"] = str(result["initial"]["seed"])
    return result


def number(value, low: float, high: float | None, label: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite or value < low or (high is not None and value > high):
        raise ValueError(f"{label} must be finite and within its allowed range")
    return value


def random_rectangle(rectangle: dict | None, width: int, height: int) -> dict:
    if rectangle is None:
        return {"x": 0, "y": 0, "width": width, "height": height}
    if not isinstance(rectangle, dict) or set(rectangle) != {"top_left", "bottom_right"}:
        raise ValueError("initial.rectangle requires top_left and bottom_right in one-based column.row notation")
    def corner(value):
        if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,9}\.[1-9][0-9]{0,9}", value):
            raise ValueError("Rectangle corner must be one-based column.row")
        return tuple(int(part) - 1 for part in value.split("."))
    x, y = corner(rectangle["top_left"])
    right, bottom = corner(rectangle["bottom_right"])
    if not (x <= right < width and y <= bottom < height):
        raise ValueError("Random rectangle exceeds the field or its corners are reversed")
    return {"x": x, "y": y, "width": right - x + 1, "height": bottom - y + 1}


def validate_grid(width: int, height: int, wrap: bool) -> None:
    integer(width, 1, 2_000_000_000, "width")
    integer(height, 1, 2_000_000_000, "height")
    if type(wrap) is not bool:
        raise ValueError("wrap must be boolean")
    if wrap and (width < 3 or height < 3):
        raise ValueError("Toroidal fields require width and height >= 3")


def validate_config(config: dict, *, validate_initial_bounds: bool = True) -> None:
    validate_grid(**config["grid"])
    engine, cp = config["engine"], config["checkpoints"]
    for key in ("tile_size", "threads", "memory_mb"):
        if engine[key] != "auto":
            integer(engine[key], 1, 1_048_576, "engine." + key)
    if engine["tile_size"] != "auto" and (engine["tile_size"] < 64 or engine["tile_size"] > 1024 or engine["tile_size"] & (engine["tile_size"] - 1)):
        raise ValueError("tile_size must be auto or a power of two from 64 through 1024")
    if engine["threads"] != "auto" and engine["threads"] > 256:
        raise ValueError("threads must not exceed 256")
    if engine["memory_mb"] != "auto" and engine["memory_mb"] < 64:
        raise ValueError("memory_mb must be at least 64")
    integer(engine["cache_mb"], 0, 1_048_576, "cache_mb")
    if type(engine["cycles_enabled"]) is not bool:
        raise ValueError("cycles_enabled must be boolean")
    integer(engine["cycles_start_generation"], 0, 10**15, "cycles_start_generation")
    integer(engine["cycles_max_period"], 1, 64, "cycles_max_period")
    integer(engine["cycles_memory_mb"], 0, 1_048_576, "cycles_memory_mb")
    integer(engine["cycles_detection_interval"], 1, 65535, "cycles_detection_interval")
    number(engine["max_generations_per_second"], 0, 1_000_000, "max_generations_per_second")
    for prefix in ("cpu", "gpu"):
        lo, hi = engine[prefix + "_min_percent"], engine[prefix + "_max_percent"]
        number(lo, 0, 100, prefix + "_min_percent")
        number(hi, 0, 100, prefix + "_max_percent")
        if lo > hi or hi == 0:
            raise ValueError(f"Invalid {prefix} utilization range")
    if engine["gpu"] != "off":
        raise ValueError("This build supports the exact CPU engine only; gpu must be 'off'")
    integer(cp["every_generations"], 1, 10**15, "every_generations")
    integer(cp["segment_mb"], 1, 256, "segment_mb")
    integer(cp["quota_mb"], cp["segment_mb"], 10**9, "quota_mb")
    number(cp["min_interval_seconds"], 0, None, "min_interval_seconds")
    number(cp["write_mb_per_second"], 0, None, "write_mb_per_second")
    if cp["write_mb_per_second"] == 0:
        raise ValueError("write_mb_per_second must be positive")
    if cp["mode"] not in ("coalesce", "strict"):
        raise ValueError("checkpoint mode must be coalesce or strict")
    if not isinstance(cp["directory"], str) or not cp["directory"]:
        raise ValueError("checkpoint directory is required")
    number(cp["disk_min_percent"], 0, 100, "disk_min_percent")
    number(cp["disk_max_percent"], 0, 100, "disk_max_percent")
    if cp["disk_min_percent"] > cp["disk_max_percent"]:
        raise ValueError("Invalid disk utilization range")
    integer(config["server"]["port"], 1, 65535, "port")
    if not isinstance(config["server"]["host"], str) or not config["server"]["host"].strip():
        raise ValueError("server.host must be a nonempty string")
    initial = config["initial"]
    if type(initial["random"]) is not bool or not isinstance(initial["path"], str):
        raise ValueError("initial.random must be boolean; initial.path must be a string")
    number(initial["density"], 0.01, 0.99, "random density")
    integer(initial["seed"], 0, (1 << 64) - 1, "seed")
    # A live New/Import can replace the current grid while startup initialization stays unchanged.
    # Such live updates validate corner syntax but do not reinterpret the old startup rectangle.
    random_rectangle(initial.get("rectangle"),
                     config["grid"]["width"] if validate_initial_bounds else 2_000_000_000,
                     config["grid"]["height"] if validate_initial_bounds else 2_000_000_000)
    display = config["display"]
    integer(display["gradient_levels"], 2, 256, "gradient_levels")
    integer(display["tile_cache_mb"], 1, 1024, "tile_cache_mb")
    for key in ("first_level_saturation", "upper_level_saturation"):
        number(display[key], 0, 1000, key)
    for key in ("heat_stable", "heat_cycle_max", "heat_active", "heat_density_gain",
                "heat_density_reference", "heat_hotspot_mix"):
        number(display[key], 0, 1, key)
    if not display["heat_stable"] < display["heat_cycle_max"] < display["heat_active"]:
        raise ValueError("Heat levels must satisfy heat_stable < heat_cycle_max < heat_active")
    if display["heat_density_gain"] > 1 - display["heat_active"]:
        raise ValueError("heat_density_gain must be at most 1 - heat_active")
    if display["heat_density_reference"] == 0:
        raise ValueError("heat_density_reference must be greater than zero")


def resolved_engine(config: dict) -> dict:
    e = config["engine"]
    memory_mb = e["memory_mb"] if e["memory_mb"] != "auto" else max(128, min(4096, available_memory() // (2 << 20)))
    # Reserve Python, HTTP serialization and bounded snapshot buffers outside native arena.
    native_bytes = max(32 << 20, (memory_mb << 20) - min(256 << 20, (memory_mb << 20) // 3))
    return {"tile_size": 128 if e["tile_size"] == "auto" else e["tile_size"],
            "threads": min(256, os.cpu_count() or 1) if e["threads"] == "auto" else e["threads"],
            "memory_bytes": native_bytes, "cache_mb": min(e["cache_mb"], native_bytes // (4 << 20))}


def load_config(path: str | Path | None = None) -> dict:
    if path is None:
        return copy.deepcopy(DEFAULTS)
    with Path(path).open("rb") as stream:
        return merge_config(tomllib.load(stream))
