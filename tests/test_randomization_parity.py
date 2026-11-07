"""The browser and native engine must agree on actual cells, not just density."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess

import pytest

from life.native import NativeEngine, library_path

ROOT = Path(__file__).resolve().parents[1]
MASK = (1 << 64) - 1
pytestmark = pytest.mark.skipif(not library_path().exists(), reason="Build native engine first")


def mix(seed: int, x: int, y: int) -> int:
    n = ((seed ^ ((y << 32) | x)) + 0x9E3779B97F4A7C15) & MASK
    n = ((n ^ (n >> 30)) * 0xBF58476D1CE4E5B9) & MASK
    n = ((n ^ (n >> 27)) * 0x94D049BB133111EB) & MASK
    return n ^ (n >> 31)


def test_native_exact_53bit_threshold_using_shared_golden_vectors():
    vectors = json.loads((ROOT / 'tests/randomization-vectors.json').read_text())['vectors']
    engine = NativeEngine(1_000_000_000, 1_000_000_000, tile_size=64, cache_mb=0, memory_bytes=4 << 20)
    try:
        for seed, x, y, hex_word, numerator in vectors:
            assert mix(int(seed), x, y) == int(hex_word, 16)
            threshold = numerator / (1 << 53)
            # Strict '<', including the exact boundary and the next representable double.
            for density, expected in [(threshold, 0), (math.nextafter(threshold, 1.0), 1)]:
                engine.randomize(density, int(seed), x, y, 1, 1)
                assert engine.render(x, y, 1, 1, 1) == [expected]
    finally:
        engine.close()


@pytest.mark.parametrize('seed,tile,threads', [(0,64,1),(1,128,2),(42,256,3),(MASK,512,2)])
def test_browser_matches_native_and_scalar_at_all_99_percent_thresholds(seed, tile, threads):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node required for cross-language comparison')
    x0, y0, width, height = 871, 923, 67, 59
    script = """
    const C=require('./web/core.js'),crypto=require('node:crypto');
    const rect={x:871,y:923,width:67,height:59}, result=[];
    for(let p=1;p<=99;p++) {
      const g=C.randomGrid(1024,1024,rect,p/100,process.argv[1]), b=Buffer.alloc(67*59);
      for(let y=0;y<59;y++) for(let x=0;x<67;x++) b[y*67+x]=g.get(rect.x+x,rect.y+y);
      result.push([g.population,crypto.createHash('sha256').update(b).digest('hex')]);
    }
    process.stdout.write(JSON.stringify(result));
    """
    browser = json.loads(subprocess.check_output([node,'-e',script,str(seed)], cwd=ROOT, text=True))
    gates = [(mix(seed,x,y) >> 11) / (1 << 53) for y in range(y0,y0+height) for x in range(x0,x0+width)]
    engine = NativeEngine(1024,1024, tile_size=tile, threads=threads, cache_mb=0, memory_bytes=8 << 20)
    try:
        for percent in range(1,100):
            p = percent / 100
            engine.randomize(p,seed,x0,y0,width,height)
            actual = bytes(engine.render(x0,y0,width,height,1))
            expected = bytes(value < p for value in gates)
            assert actual == expected
            assert browser[percent-1] == [engine.population,hashlib.sha256(actual).hexdigest()]
    finally:
        engine.close()


def test_obsolete_dll_without_native_randomization_cannot_silently_change_the_recipe():
    class MissingABI:
        lib = object()
    with pytest.raises(RuntimeError, match='Rebuild the native engine'):
        NativeEngine.randomize(MissingABI(), .15, 42, 0, 0, 1, 1)

def test_direct_native_randomization_rejects_wrapping_invalid_seeds():
    engine = NativeEngine(64,64,tile_size=64,threads=1,cache_mb=0,memory_bytes=2 << 20)
    try:
        engine.randomize(.15, '18446744073709551615',0,0,64,64)
        old = set(engine.cells())
        for invalid in [-1,1<<64,'18446744073709551616',True]:
            with pytest.raises(ValueError, match='seed'):
                engine.randomize(.15,invalid,0,0,64,64)
            assert set(engine.cells()) == old
    finally:
        engine.close()
