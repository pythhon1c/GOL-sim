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
      { x: 0, y: 0, width: 33, height: 1 },
      { x: 64, y: 64, width: 65, height: 79 },
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

test("a small viewport and selection look up nearby tiles in a huge sparse world", () => {
  const g = new C.SparseGrid(2_000_000_000, 2_000_000_000);
  for (let i = 0; i < 1000; i++) g.set(i * 64, i * 64, 1);
  g.set(g.width - 1, g.height - 1, 1);
  const region = { x: g.width - 2, y: g.height - 2, width: 2, height: 2 };
  g.tiles.values = () => { throw Error("A close-up must not scan the entire world"); };
  assert.deepEqual(Array.from(g.cells(region)), [[g.width - 1, g.height - 1]]);
  assert.deepEqual([...C.aggregate(g, region, 1).counts], [0, 0, 0, 1]);
});

test("4K and 8K paste previews use the same bounded bins as the field", () => {
  const world = { width: 120000, height: 60000 };
  const view = { x: 16, y: 33, zoom: 1 };
  for (const [width, height] of [[3840, 2160], [7680, 4320]]) {
    for (const cap of [350000, 1500000]) {
      const r = C.viewportRegion(world, view, width, height, cap);
      assert(r.x <= view.x && r.y <= view.y);
      assert(r.x + r.width >= view.x + width && r.y + r.height >= view.y + height);
      assert(Math.ceil(r.width / r.scale) * Math.ceil(r.height / r.scale) <= cap);
    }
  }
  assert.equal(C.viewportRegion(world, { x: -2048, y: 0, zoom: 1 }, 1024, 600).width, 0);
});

test("saved RLE fields restore partial metadata, offsets and finite topology in the worker", () => {
  const body = "x = 3, y = 2, rule = 23/3\n2o$2bo!";
  const data = "#C LIFE width=512 origin_x=509 generation=37\n" + body;
  const r = C.parseRLE(data, { restoreField: true });
  assert.equal(r.placed, true);
  assert.deepEqual([r.grid.width, r.grid.height, r.grid.wrap], [512, 2, false]);
  assert.deepEqual(sort(r.grid), ["509,0", "510,0", "511,1"]);
  assert.equal(C.parseRLE(data).grid.width, 3);
  assert.equal(C.parseRLE(body, {restoreField:true}).placed, false);
  for (const bad of [
    "wrap=2", "width=0", "height=-1", "foo=3", "width=3junk",
    "width=3 width=4", "width=2", "origin_x=4", "wrap=1",
    "generation=18446744073709551616", "origin_y=9007199254740995",
  ]) assert.throws(() => C.parseRLE("#C LIFE " + bad + "\n" + body), undefined, bad);
  for (const count of ["1","2","0"]) assert.throws(() => C.parseRLE(body.replace("!", count+"!")));
});

test("JSON import rejects invalid topology, metadata and duplicate cells and keeps uint64 exact", () => {
  const base = { width: 9, height: 8, cells: [[0, 0]] };
  for (const change of [
    { wrap: "false" }, { wrap: 1 }, { wrap: true, width: 2 }, { width: undefined },
    { rule: "" }, { rule:null }, { generation: -1 }, { generation: 0.25 },
    { generation: "12" }, { cells: [[0, 0], [0, 0]] }, { coordinate_base: true },
  ]) assert.throws(() => C.parseStateJSON({ ...base, ...change }));
  for (const value of [null, [], 3]) assert.throws(() => C.parseStateJSON(value));
  for (const rule of ["23/3","b3/s23"]) assert.equal(C.parseStateJSON({...base, rule}).grid.population,1);
  const raw = JSON.stringify(base).replace("{", '{"generation":18446744073709551615,');
  const {grid,generation} = C.parseStateJSON(raw);
  assert.equal(generation, 18446744073709551615n);
  assert.match(C.encodeStateJSON(grid, generation), /"generation":18446744073709551615,/);
  assert.throws(() => C.parseStateJSON(raw.replace("18446744073709551615","18446744073709551616")));
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
