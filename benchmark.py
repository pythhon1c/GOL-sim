"""Reproducible CPU benchmark. Run from the project root with .venv Python."""
from __future__ import annotations

import argparse
import json
import os
import time

import psutil

from life.native import NativeEngine


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", nargs="+", type=int, default=[1024, 4096, 10000])
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--threads", type=int, default=os.cpu_count() or 1)
    parser.add_argument("--tile", type=int, default=128)
    parser.add_argument("--density", type=float, default=0.15)
    args = parser.parse_args()
    process = psutil.Process()
    for side in args.sizes:
        engine = NativeEngine(side, side, tile_size=args.tile, threads=args.threads,
                              cache_mb=64, memory_bytes=2 << 30)
        try:
            started = time.perf_counter()
            engine.randomize(args.density, 42, 0, 0, side, side)
            initialize_seconds = time.perf_counter() - started
            for _ in range(3):
                engine.step()
            started = time.perf_counter()
            for _ in range(args.steps):
                engine.step()
            duration = time.perf_counter() - started
            print(json.dumps({
                "width": side, "height": side, "cells": side * side,
                "threads": args.threads, "tile_size": args.tile, "initial_density": args.density,
                "seed": 42, "warmup_steps": 3, "measured_steps": args.steps,
                "initialization_seconds": round(initialize_seconds, 4),
                "seconds": round(duration, 4),
                "generations_per_second": round(args.steps / duration, 2),
                "population": engine.population,
                "process_rss_mib": round(process.memory_info().rss / (1 << 20), 1),
                "stats": engine.stats(),
            }), flush=True)
        finally:
            engine.close()


if __name__ == "__main__":
    main()
