"""Independent differential checks at the public Python/native boundary."""
from array import array
from random import Random

import pytest

from life.native import NativeEngine, library_path

pytestmark = pytest.mark.skipif(not library_path().exists(), reason="Build the native core first")


def reference(cells, width, height, wrap):
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


@pytest.mark.parametrize("width,height", [(3, 3), (7, 5), (65, 5), (131, 9), (129, 129)])
@pytest.mark.parametrize("wrap", [False, True])
def test_public_boundary_matches_scalar(width, height, wrap):
    rng = Random(144)
    cells = {(x, y) for y in range(height) for x in range(width) if rng.random() < 0.28}
    engine = NativeEngine(width, height, wrap=wrap, threads=3, cache_mb=4)
    try:
        engine.import_cells(cells)
        for generation in range(1, 9):
            cells = reference(cells, width, height, wrap)
            engine.step()
            assert engine.generation == generation
            assert engine.population == len(cells)
            assert set(engine.cells()) == cells
    finally:
        engine.close()


def test_random_seed_is_independent_of_tile_and_threads():
    states = []
    for tile_size, threads in [(64, 1), (128, 2), (256, 4)]:
        engine = NativeEngine(333, 277, tile_size=tile_size, threads=threads, cache_mb=2)
        try:
            engine.randomize(0.27, 12345, 5, 7, 310, 250)
            assert all(5 <= x < 315 and 7 <= y < 257 for x, y in engine.cells())
            for _ in range(4):
                engine.step()
            states.append(set(engine.cells()))
        finally:
            engine.close()
    assert states[0] == states[1] == states[2]


def test_lod_is_population_not_simulation_input():
    engine = NativeEngine(301, 257, cache_mb=2)
    cells = {(0, 0), (1, 1), (127, 127), (128, 128), (300, 256)}
    try:
        engine.import_cells(cells)
        for scale in [1, 2, 16, 64, 128, 512]:
            columns = (engine.width + scale - 1) // scale
            rows = (engine.height + scale - 1) // scale
            image = engine.render(0, 0, columns, rows, scale)
            assert sum(image) == len(cells)
            expected = [0] * (columns * rows)
            for x, y in cells:
                expected[(y // scale) * columns + (x // scale)] += 1
            assert image == expected
        assert set(engine.cells()) == cells
        assert engine.generation == 0
    finally:
        engine.close()


def test_cached_blinker_wakes_when_external_glider_arrives():
    # A vertical oscillator straddles a tile boundary; a SE glider approaches it.
    cells = {(128, 127), (128, 128), (128, 129), (116, 116), (117, 117), (115, 118), (116, 118), (117, 118)}
    cached = NativeEngine(150, 150, tile_size=64, threads=4, cache_mb=4)
    uncached = NativeEngine(150, 150, tile_size=128, threads=1, cache_mb=0)
    try:
        cached.import_cells(cells)
        uncached.import_cells(cells)
        for _ in range(70):
            cached.step()
            uncached.step()
            assert set(cached.cells()) == set(uncached.cells())
    finally:
        cached.close()
        uncached.close()


@pytest.fixture(scope="module")
def render_seed_grid():
    """Summed-area reference is independent of native word slicing/popcount."""
    width, height, seed, density = 1027, 517, 0xF123456789ABCDEF, 0.37
    stride = width + 1
    prefix = array("I", [0]) * (stride * (height + 1))
    mask64 = (1 << 64) - 1
    for y in range(height):
        row_sum = 0
        for x in range(width):
            value = ((seed ^ ((y << 32) | x)) + 0x9E3779B97F4A7C15) & mask64
            value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & mask64
            value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & mask64
            value ^= value >> 31
            row_sum += (value >> 11) / (1 << 53) < density
            prefix[(y + 1) * stride + x + 1] = prefix[y * stride + x + 1] + row_sum
    # Torus changes evolution only: rendering beyond the field must remain zero.
    engine = NativeEngine(width, height, True, tile_size=512, threads=3,
                          cache_mb=0, memory_bytes=32 << 20)
    try:
        engine.randomize(density, seed, 0, 0, width, height)
        assert engine.population == prefix[-1]
        yield engine, prefix
    finally:
        engine.close()


def expected_render(prefix, width, height, x, y, columns, rows, scale):
    stride = width + 1
    result = []
    for row in range(rows):
        top = min(height, y + row * scale)
        bottom = min(height, y + (row + 1) * scale)
        for col in range(columns):
            left = min(width, x + col * scale)
            right = min(width, x + (col + 1) * scale)
            result.append(prefix[bottom * stride + right] - prefix[top * stride + right]
                          - prefix[bottom * stride + left] + prefix[top * stride + left])
    return result


@pytest.mark.parametrize("scale", [1, 3, 64, 128, 200, 256, 512, 1024])
def test_word_popcount_render_matches_seed_sums_at_unaligned_origins(render_seed_grid, scale):
    engine, prefix = render_seed_grid
    origins = [(0, 0), (1, 3), (63, 127), (64, 128), (127, 255), (511, 509),
               (512, 511), (1001, 501), (1026, 516), (1027, 0), (0, 517), (1028, 520)]
    for x, y in origins:
        columns, rows = 9, 5
        actual = engine.render(x, y, columns, rows, scale)
        expected = expected_render(prefix, engine.width, engine.height, x, y, columns, rows, scale)
        assert actual == expected, (scale, x, y)
    # Include the complete population and extra buckets clipped beyond both edges.
    columns = (engine.width + scale - 1) // scale + 1
    rows = (engine.height + scale - 1) // scale + 1
    full = engine.render(0, 0, columns, rows, scale)
    assert full == expected_render(prefix, engine.width, engine.height, 0, 0, columns, rows, scale)
    assert sum(full) == engine.population == prefix[-1]
    assert engine.generation == 0

