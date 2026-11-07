"""Verify the actual RLE devices against independent B3/S23 reference states."""
import hashlib
import json
from pathlib import Path
import struct

import pytest

from life.formats import parse_state
from life.native import NativeEngine


ROOT = Path(__file__).resolve().parents[1]
DEVICES = json.loads((ROOT / 'tests/fixtures/devices-validation.json').read_text('utf8'))['devices']
PROFILE = json.loads((ROOT / 'publication-profile.json').read_text('utf8'))['profile']


def test_device_fixture_matches_publication_profile():
    assert PROFILE in ('full', 'public')
    expected = set() if PROFILE == 'public' else {
        'otca-blinker', 'hex-counter', 'constructor-memory-loop', 'pi-calculator'}
    assert {device['id'] for device in DEVICES} == expected


@pytest.mark.parametrize('device', DEVICES, ids=[device['id'] for device in DEVICES])
def test_device_import_and_exact_first_generation(device):
    raw = (ROOT / device['asset_path']).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == device['asset_sha256']
    state = parse_state(raw.decode('utf8'), 'rle')
    assert [state.width, state.height] == device['import_field']
    assert state.generation == 0 and not state.wrap
    assert len(state.cells) == device['initial_population']
    expected = next(frame for frame in device['native_exact_snapshots'] if frame['generation'] == 1)
    margin = device['field_margin']
    engine = NativeEngine(state.width, state.height, threads=2, tile_size=64, cache_mb=4)
    try:
        engine.import_cells(state.cells)
        del state
        engine.step()
        assert engine.population == expected['population']
        # Canonical order is by row and then column; the compared coordinates
        # are relative to the initial pattern rather than our finite-field pad.
        digest = hashlib.sha256()
        chunk = bytearray()
        for packed in sorted(engine.iter_packed()):
            chunk.extend(struct.pack('<ii', (packed & 0xffffffff) - margin, (packed >> 32) - margin))
            if len(chunk) >= 65536:
                digest.update(chunk)
                chunk.clear()
        digest.update(chunk)
        assert digest.hexdigest() == expected['coordinate_sha256']
    finally:
        engine.close()
