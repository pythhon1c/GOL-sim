"""Check each advertised demonstration against an independently evolved frame."""
import hashlib
import json
from pathlib import Path
import struct

import pytest

from life.formats import parse_rle
from life.native import NativeEngine


ROOT = Path(__file__).resolve().parents[1]
DEVICES = json.loads(
    (ROOT / "tests/fixtures/fast-machines-validation.json").read_text("utf-8")
)["devices"]
CATALOG = {
    pattern["id"]: pattern
    for pattern in json.loads((ROOT / "web/patterns.json").read_text("utf-8"))
}
PROFILE = json.loads((ROOT / 'publication-profile.json').read_text('utf-8'))['profile']


def test_fast_machine_fixtures_match_publication_profile():
    assert PROFILE in ('full', 'public')
    assert len(DEVICES) == (2 if PROFILE == 'public' else 10)
    assert {device['id'] for device in DEVICES} == {
        pattern['id'] for pattern in CATALOG.values() if pattern.get('demo')}


@pytest.mark.parametrize("device", DEVICES, ids=[device["id"] for device in DEVICES])
def test_fast_machine_demonstration_matches_reference(device):
    raw = (ROOT / device["asset_path"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == device["asset_sha256"]
    state = parse_rle(raw.decode("utf-8"))
    assert [state.width, state.height] == device["field"]
    assert len(state.cells) == device["initial_population"]
    assert state.generation == 0 and not state.wrap
    demo = CATALOG[device["id"]]["demo"]
    assert demo["generation"] == device["generation"]
    margin = device["field_margin"]
    view = demo["view"]
    assert 0 <= margin + view["x"] < margin + view["x"] + view["width"] <= state.width
    assert 0 <= margin + view["y"] < margin + view["y"] + view["height"] <= state.height

    engine = NativeEngine(
        state.width, state.height, threads=2, tile_size=64,
        cache_mb=8, memory_bytes=128 << 20,
    )
    try:
        engine.import_cells(state.cells)
        for _ in range(device["generation"]):
            engine.step()
        assert engine.population == device["population"]
        digest = hashlib.sha256()
        for packed in sorted(engine.iter_packed()):
            digest.update(struct.pack(
                "<ii", (packed & 0xffffffff) - margin, (packed >> 32) - margin,
            ))
        assert digest.hexdigest() == device["coordinate_sha256"]
    finally:
        engine.close()
