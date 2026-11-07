"""Truth tables of original, one-shot glider collision constructions.

Every native generation is compared with an independent scalar B3/S23 model;
the fixed readout is checked against independently specified final cell sets.
"""
from collections import Counter
import json
from pathlib import Path

import pytest

from life.formats import parse_state
from life.native import NativeEngine


ROOT = Path(__file__).resolve().parents[1] / "examples" / "logic"
TABLES = json.loads((ROOT / "truth-tables.json").read_text("utf-8"))
CASES = [(demo, case) for demo in TABLES["demos"] for case in demo["cases"]]


def scalar_step(live, width, height):
    neighbors = Counter()
    for x, y in live:
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if (dx or dy) and 0 <= nx < width and 0 <= ny < height:
                    neighbors[nx, ny] += 1
    return {cell for cell, count in neighbors.items()
            if count == 3 or count == 2 and cell in live}


def translated(cells, delta):
    return {(x + delta, y + delta) for x, y in cells}


@pytest.mark.parametrize("demo,case", CASES,
                         ids=[demo["id"] + "-" + "".join(map(str, case["inputs"]))
                              for demo, case in CASES])
def test_truth_table_native_matches_every_reference_generation(demo, case):
    state = parse_state((ROOT / case["state"]).read_text("utf-8"), "json")
    rle = parse_state((ROOT / case["rle"]).read_text("utf-8"), "rle")
    assert set(state.cells) == set(rle.cells)
    assert (state.width, state.height, state.wrap, state.generation) == (64, 64, False, 0)
    assert (rle.width, rle.height, rle.wrap, rle.generation) == (64, 64, False, 0)
    reference = set(state.cells)
    engine = NativeEngine(64, 64, False, tile_size=64, threads=2,
                          cache_mb=4, memory_bytes=64 << 20)
    try:
        engine.import_cells(reference)
        for generation in range(1, TABLES["read_generation"] + 1):
            reference = scalar_step(reference, 64, 64)
            engine.step()
            assert engine.generation == generation
            assert set(engine.cells()) == reference

        roi = demo["read_roi"]
        output_cells = {cell for cell in reference
                        if roi["x"] <= cell[0] < roi["x"] + roi["width"]
                        and roi["y"] <= cell[1] < roi["y"] + roi["height"]}
        assert len(output_cells) == case["expected_roi_population"]
        assert bool(output_cells) == bool(case["output"])

        if demo["id"] == "not":
            expected = translated(demo["clock_cells"], 16) if case["inputs"] == [0] else set()
        elif case["inputs"] == [1, 1]:
            expected = {(20, 20), (20, 21), (21, 20), (21, 21)}
        else:
            expected = set()
            if case["inputs"][0]:
                expected |= translated(demo["input_cells"]["a"], 16)
            if case["inputs"][1]:
                expected |= translated(demo["input_cells"]["b"], -16)
        assert reference == expected

        # The conjunction's readout is a stored block, not a transient spark.
        if demo["id"] == "and" and case["inputs"] == [1, 1]:
            for _ in range(64):
                engine.step()
                assert set(engine.cells()) == expected
    finally:
        engine.close()
