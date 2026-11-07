"""Exhaustive truth tables for the timed, finite glider circuits.

All comparisons evolve the shipped files. A logical 1 must be one *specific*
traveling glider at three consecutive phase-aligned samples (or an unchanged
stored block), not arbitrary activity somewhere in a readout region.
"""
from collections import Counter
from itertools import product
import json
from pathlib import Path

import pytest

from life.formats import parse_state
from life.native import NativeEngine


BASE = Path(__file__).resolve().parents[1] / "examples" / "logic"
TABLE = json.loads((BASE / "extended-truth-tables.json").read_text("utf-8"))
DEMOS = TABLE["demos"]
CASES = [(demo, case) for demo in DEMOS for case in demo["cases"]]
BITS = list(product((0, 1), repeat=2))


def expected_values(gate, a, b):
    if gate == "block-memory":
        return [a, int(a and not b)]
    return [int({"or": a or b, "nor": not (a or b), "nand": not (a and b),
                 "xor": a != b, "xnor": a == b, "inhibit": a and not b,
                 "implies": not a or b}[gate])]


def scalar(live, w, h):
    counts = Counter((x + dx, y + dy) for x, y in live
                     for dx, dy in product((-1, 0, 1), repeat=2)
                     if (dx or dy) and 0 <= x + dx < w and 0 <= y + dy < h)
    return {p for p, n in counts.items() if n == 3 or n == 2 and p in live}


def test_all_input_combinations_represented_by_actual_pins():
    assert {d["id"] for d in DEMOS} == {
        "nor", "or", "nand", "xor", "xnor", "inhibit", "implies", "block-memory"}
    for d in DEMOS:
        assert [tuple(c["inputs"]) for c in d["cases"]] == BITS
        pins = [set(map(tuple, p)) for p in d["input_cells"]]
        fixed = set(map(tuple, d["fixed_cells"]))
        assert len(pins[0]) == len(pins[1]) == 5
        assert pins[0].isdisjoint(pins[1]) and all(fixed.isdisjoint(p) for p in pins)
        for p in pins:
            # An input consists of a freely translating four-phase Life glider.
            after_four = set(p)
            for _ in range(4):
                after_four = scalar(after_four, TABLE["width"], TABLE["height"])
            assert any(after_four == {(x + dx, y + dy) for x, y in p}
                       for dx, dy in product((-1, 1), repeat=2))
        for case in d["cases"]:
            a, b = case["inputs"]
            state = parse_state((BASE / case["state"]).read_text("utf-8"), "json")
            assert set(state.cells) == fixed | (pins[0] if a else set()) | (pins[1] if b else set())
            assert case["outputs"] == expected_values(d["id"], a, b)


@pytest.mark.parametrize("demo,case", CASES, ids=[d["id"] + "-" + "".join(map(str,c["inputs"])) for d,c in CASES])
def test_shipped_circuit_native_scalar_and_physical_output(demo, case):
    js = parse_state((BASE / case["state"]).read_text("utf-8"), "json")
    rle = parse_state((BASE / case["rle"]).read_text("utf-8"), "rle")
    for state in (js, rle):
        assert (state.width, state.height, state.wrap, state.generation) == (TABLE["width"], TABLE["height"], False, 0)
    assert set(js.cells) == set(rle.cells)
    ref = set(js.cells)
    samples = {}
    for idx, (cp, bit) in enumerate(zip(demo["checkpoints"], expected_values(demo["id"], *case["inputs"]))):
        ones = set(map(tuple, cp["one_cells"]))
        roi = cp["output_roi"]
        assert len(ones) == (4 if cp["signal"] == "block" else 5)
        runs = [0, 4, 8]
        if cp["signal"] == "block":
            # Hold after write; final memory persists for at least 64 more ticks.
            runs = range(0, 65 if idx == len(demo["checkpoints"])-1 else 17)
        for dt in runs:
            dx, dy = [v * (dt//4) for v in cp["velocity_per_four"]]
            window = (roi["x"]+dx, roi["y"]+dy, roi["width"], roi["height"])
            expected = {(x+dx,y+dy) for x,y in ones} if bit else set()
            samples[cp["generation"]+dt] = (window, expected)
    engine = NativeEngine(js.width, js.height, False, tile_size=64, threads=2,
                          cache_mb=2, memory_bytes=64 << 20)
    try:
        engine.import_cells(js.cells)
        for generation in range(1, max(samples)+1):
            ref = scalar(ref, js.width, js.height)
            engine.step()
            assert engine.generation == generation
            assert set(engine.cells()) == ref
            if generation in samples:
                (x, y, w, h), expected = samples[generation]
                assert {(i,j) for i,j in ref if x <= i < x+w and y <= j < y+h} == expected
    finally:
        engine.close()
