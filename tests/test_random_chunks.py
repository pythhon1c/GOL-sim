"""Exact initialization across partitions and bounded native generation work."""
from __future__ import annotations

from collections import Counter
import random

import pytest

from life.native import NativeEngine, library_path


pytestmark = pytest.mark.skipif(not library_path().exists(), reason="Build the native engine first")
MASK64 = (1 << 64) - 1


def coordinate_random(seed: int, x: int, y: int) -> float:
    """Independent scalar implementation of the documented global-coordinate PRNG."""
    word = (seed ^ ((y << 32) | x)) + 0x9E3779B97F4A7C15
    word &= MASK64
    word = ((word ^ (word >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    word = ((word ^ (word >> 27)) * 0x94D049BB133111EB) & MASK64
    word ^= word >> 31
    return (word >> 11) / (1 << 53)


def partitions(x, y, widths, heights):
    result = []
    yy = y
    for height in heights:
        xx = x
        for width in widths:
            result.append((xx, yy, width, height))
            xx += width
        yy += height
    return result


def scalar_step(cells, width, height, wrap):
    neighbors = Counter()
    for x, y in cells:
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == dy == 0:
                    continue
                xx, yy = x + dx, y + dy
                if wrap:
                    xx, yy = xx % width, yy % height
                elif not (0 <= xx < width and 0 <= yy < height):
                    continue
                neighbors[xx, yy] += 1
    return {cell for cell, count in neighbors.items() if count == 3 or (count == 2 and cell in cells)}


@pytest.mark.parametrize("tile_size,threads,order", [(64, 1, "forward"), (128, 2, "reverse"), (256, 3, "shuffled")])
@pytest.mark.parametrize("wrap", [False, True])
def test_random_partitions_use_global_coordinates_and_preserve_outside(tile_size, threads, order, wrap):
    extent = 1_000_000
    x, y, width, height = 999_780, 999_811, 211, 181
    density, seed = 0.37, MASK64
    outside = {(0, 0), (extent - 1, extent - 1), (x - 1, y), (x, y - 1), (x + width, y + 1)}
    original = outside | {(x, y), (x + 1, y), (x + width - 1, y + height - 1)}
    expected = outside | {(xx, yy) for yy in range(y, y + height) for xx in range(x, x + width)
                          if coordinate_random(seed, xx, yy) < density}
    chunks = partitions(x, y, [1, 62, 65, 7, 76], [3, 61, 1, 64, 52])
    if order == "reverse":
        chunks.reverse()
    elif order == "shuffled":
        random.Random(187).shuffle(chunks)
    engine = NativeEngine(extent, extent, wrap, tile_size=tile_size, threads=threads,
                          cache_mb=0, memory_bytes=32 << 20)
    try:
        engine.import_cells(original)
        engine.generation = 77
        for rectangle in chunks:
            engine.randomize(density, seed, *rectangle)
            assert engine.generation == 77
        assert set(engine.cells()) == expected
        # Reapplying the entire region is idempotent and matches any partition ordering.
        engine.randomize(density, seed, x, y, width, height)
        assert set(engine.cells()) == expected
        assert engine.population == len(expected)
        assert engine.generation == 77
        assert engine.wrap is wrap
    finally:
        engine.close()


@pytest.mark.parametrize("tile_size", [64, 128])
@pytest.mark.parametrize("wrap", [False, True])
def test_partitioned_random_world_evolves_synchronously_across_tile_boundaries(tile_size, wrap):
    width, height = 259, 197
    density, seed = 0.27, 9_007_199_254_740_993
    cells = {(x, y) for y in range(height) for x in range(width)
             if coordinate_random(seed, x, y) < density}
    chunks = partitions(0, 0, [63, 2, 63, 1, 127, 3], [1, 62, 2, 64, 68])
    random.Random(23).shuffle(chunks)
    engine = NativeEngine(width, height, wrap, tile_size=tile_size, threads=3,
                          cache_mb=1, memory_bytes=32 << 20)
    try:
        for rectangle in chunks:
            engine.randomize(density, seed, *rectangle)
        for generation in range(8):
            assert engine.generation == generation
            assert set(engine.cells()) == cells
            cells = scalar_step(cells, width, height, wrap)
            engine.step()
        assert set(engine.cells()) == cells
    finally:
        engine.close()


def test_random_preflight_failure_preserves_cells_generation_and_population():
    engine = NativeEngine(1_000_000, 1_000_000, True, tile_size=64, threads=2,
                          cache_mb=0, memory_bytes=8 << 20)
    cells = {(0, 0), (0, 999_999), (999_999, 0), (999_999, 999_999), (127, 128)}
    try:
        engine.import_cells(cells)
        engine.generation = 913
        with pytest.raises(RuntimeError, match="memory"):
            # Required final state alone exceeds 8 MiB; no large allocation should occur.
            engine.randomize(0.5, 42, 0, 0, 8192, 8192)
        assert set(engine.cells()) == cells
        assert engine.population == len(cells)
        assert engine.generation == 913
        with pytest.raises(RuntimeError, match="outside"):
            engine.randomize(0.5, 42, 999_999, 0, 2, 3)
        assert set(engine.cells()) == cells
        assert engine.generation == 913
    finally:
        engine.close()


def test_step_preflight_failure_preserves_last_complete_generation():
    engine = NativeEngine(259, 197, True, tile_size=64, threads=2,
                          cache_mb=0, memory_bytes=8 << 20)
    try:
        engine.randomize(0.41, 523, 0, 0, 259, 197)
        cells = set(engine.cells())
        engine.generation = 27
        resident = engine.stats()["estimated_native_bytes"]
        engine._check(engine.lib.life_set_memory_limit(engine.handle, resident + 4096))
        with pytest.raises(RuntimeError, match="memory"):
            engine.step()
        assert set(engine.cells()) == cells
        assert engine.population == len(cells)
        assert engine.generation == 27
    finally:
        engine.close()


def test_bounded_step_fits_preflight_budget_and_matches_unconstrained_engine():
    # Only 67 million bits (~10 MiB of native tiles), not a billion-cell allocation.
    # The former all-results-at-once step needed ~54.75 MiB; bounded batches fit 48 MiB.
    constrained = NativeEngine(8192, 8192, True, tile_size=64, threads=2,
                               cache_mb=0, memory_bytes=48 << 20)
    reference = NativeEngine(8192, 8192, True, tile_size=64, threads=3,
                             cache_mb=0, memory_bytes=128 << 20)
    try:
        for engine in (constrained, reference):
            engine.randomize(0.15, 7823, 0, 0, 8192, 8192)
        for generation in range(1, 4):
            constrained.step()
            reference.step()
            assert constrained.generation == reference.generation == generation
            assert constrained.population == reference.population
            assert constrained.render(0, 0, 256, 256, 32) == reference.render(0, 0, 256, 256, 32)
            # Exact individual cells at toroidal corners, internal edges and batch-heavy center.
            for x, y in ((0, 0), (63, 127), (4055, 4055), (8064, 8064)):
                assert constrained.render(x, y, 128, 128, 1) == reference.render(x, y, 128, 128, 1)
    finally:
        constrained.close()
        reference.close()
