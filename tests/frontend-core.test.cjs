const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../web/core.js");
const publicationProfile = require("../publication-profile.json");
assert(["full", "public"].includes(publicationProfile.profile));
const sort = (g) => [...g.cells()].map(([x, y]) => `${x},${y}`).sort();

test("sparse bit storage preserves word edges and huge coordinates", () => {
  const g = new C.SparseGrid(1000000000, 1000000000);
  const points = [
    [0, 0],
    [31, 0],
    [32, 0],
    [63, 63],
    [64, 64],
    [999999999, 999999999],
  ];
  for (const [x, y] of points) g.set(x, y, 1);
  assert.equal(g.population, points.length);
  for (const [x, y] of points) assert.equal(g.get(x, y), 1);
  assert.equal(g.tiles.size, 3);
  g.set(31, 0, 0);
  assert.equal(g.population, 5);
  assert.equal(g.get(32, 0), 1);
  assert.equal(g.get(-1, 0), 0);
});

test("LOD counts equal direct counting at all zoom levels", () => {
  const g = new C.SparseGrid(259, 197);
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++)
      if ((x * 17 + y * 31) % 13 < 3) g.set(x, y, 1);
  for (const scale of [1, 2, 4, 16, 32, 64, 128, 512]) {
    for (const rect of [
      { x: 0, y: 0, width: 512, height: 512 },
      { x: 64, y: 64, width: 128, height: 128 },
      { x: 7, y: 13, width: 71, height: 99 },
    ]) {
      const a = C.aggregate(g, rect, scale),
        expected = new Array(a.columns * a.rows).fill(0);
      for (const [x, y] of g.cells(rect))
        expected[
          Math.floor((y - rect.y) / scale) * a.columns +
            Math.floor((x - rect.x) / scale)
        ]++;
      assert.deepEqual(
        [...a.counts],
        expected,
        JSON.stringify({ scale, rect }),
      );
    }
  }
});

test("RLE shapes round-trip relative to their bounding box and reject other rules", () => {
  for (const rle of [
    "x = 3, y = 3, rule = B3/S23\nbo$2bo$3o!",
    "x = 140, y = 3\n70bo68bo2$140o!",
  ]) {
    const { grid } = C.parseRLE(rle),
      b = grid.bounds();
    const restored = C.parseRLE(C.encodeRLE(grid)).grid;
    assert.deepEqual(
      sort(restored),
      [...grid.cells()].map(([x, y]) => `${x - b.x},${y - b.y}`).sort(),
    );
  }
  for (const invalid of [
    "x = 3, y = 3, rule = B36/S23\no!",
    "x = 3, y = 3\n4o!",
    "x = 3, y = 3\no",
  ])
    assert.throws(() => C.parseRLE(invalid));
});

test("state JSON preserves dimensions, one-based coordinates and topology", () => {
  const g = new C.SparseGrid(1666, 1888, true);
  g.set(1665, 1887, 1);
  g.set(0, 0, 1);
  const data = JSON.parse(C.encodeStateJSON(g, 17));
  assert.equal(data.coordinate_base, 1);
  assert(data.cells.some(([x, y]) => x === 1666 && y === 1888));
  const r = C.parseStateJSON(data);
  assert.deepEqual(sort(r.grid), sort(g));
  assert.equal(r.grid.wrap, true);
  assert.equal(r.generation, 17);
});

test("four rotations restore the exact cells", () => {
  let state = {
    cells: [
      [0, 0],
      [2, 1],
      [0, 3],
    ],
    width: 3,
    height: 4,
  };
  const original = JSON.stringify(state);
  for (let i = 0; i < 4; i++)
    state = C.transform(state.cells, state.width, state.height, "rotate");
  assert.equal(JSON.stringify(state), original);
});

test("visibility boost never makes an empty block alive-looking", () => {
  assert.equal(C.shade(0, 1e12, 32, 0.9, 10), 0);
  assert(C.shade(1, 1e12, 32, 0.1, 2) > 0);
});

test("bundled clock is an actual large B3/S23 state", {
  skip: publicationProfile.profile === "public" ? "Clock is excluded pending redistribution permission" : false,
}, () => {
  const text = fs.readFileSync(
    path.join(__dirname, "../web/patterns/digital-clock.rle"),
    "utf8",
  );
  const { grid } = C.parseRLE(text);
  assert.equal(grid.width, 10284);
  assert.equal(grid.height, 6796);
  assert.equal(grid.population, 272802); // The bundled AM+PM variation has extra cells.
  assert.equal(
    C.aggregate(
      grid,
      { x: 0, y: 0, width: 16384, height: 8192 },
      128,
    ).counts.reduce((a, b) => a + b, 0),
    grid.population,
  );
});
