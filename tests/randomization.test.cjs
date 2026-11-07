const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const C = require("../web/core.js");

function scalar(seed, x, y) {
  const mask = (1n << 64n) - 1n;
  let n =
    ((BigInt(seed) ^ ((BigInt(y) << 32n) | BigInt(x))) + 0x9e3779b97f4a7c15n) &
    mask;
  n = ((n ^ (n >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
  n = ((n ^ (n >> 27n)) * 0x94d049bb133111ebn) & mask;
  n ^= n >> 31n;
  return Number(n >> 11n) / 9007199254740992;
}

test("shared golden vectors lock the coordinate recipe across languages", () => {
  const golden = require("./randomization-vectors.json");
  assert.equal(C.RANDOM_ALGORITHM, golden.algorithm);
  for (const [seed, x, y, hex, numerator] of golden.vectors) {
    assert.equal(Number(BigInt("0x" + hex) >> 11n), numerator);
    assert.equal(C.coordinateRandom(seed)(x, y) * 9007199254740992, numerator);
  }
});

test("coordinate SplitMix64 word-pairs exactly match independent BigInt arithmetic", () => {
  for (const seed of [
    "0",
    "1",
    "42",
    "4294967296",
    "9007199254740993",
    "18446744073709551615",
  ]) {
    const random = C.coordinateRandom(seed);
    for (const x of [
      0, 1, 31, 63, 64, 65535, 65536, 999999999, 2147483647, 2147483648,
      4294967295,
    ])
      for (const y of [0, 1, 127, 65535, 65536, 999999999, 4294967295])
        assert.equal(random(x, y), scalar(seed, x, y), `${seed}/${x}/${y}`);
    // Dense consecutive inputs exercise carries and unsigned high products.
    for (let i = 0; i < 20000; i++) {
      const x = (Math.imul(i, 2654435761) + 0xfedcba98) >>> 0;
      const y = (Math.imul(i, 2246822519) + 0x76543210) >>> 0;
      assert.equal(random(x, y), scalar(seed, x, y));
    }
  }
});

test("full uint64 seed parsing preserves all bits and rejects rounded numeric inputs", () => {
  assert.equal(C.randomSeed("18446744073709551615"), "18446744073709551615");
  assert.equal(C.randomSeed("00042"), "42");
  assert.equal(C.randomSeed(0), "0");
  for (const seed of [
    "18446744073709551616",
    "-1",
    "1.5",
    "1e3",
    "",
    true,
    NaN,
    Infinity,
    9007199254740992,
  ])
    assert.throws(() => C.randomSeed(seed));
  const a = C.coordinateRandom("42"),
    b = C.coordinateRandom("4294967338");
  assert.notEqual(a(0, 0), b(0, 0)); // Former seed>>>0 collision.
});

test("every integer density1..99 uses the exact native threshold", () => {
  const rect = { x: 871, y: 923, width: 67, height: 59 };
  for (const seed of ["0", "1", "42", "18446744073709551615"]) {
    const units = [];
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++)
        units.push(scalar(seed, x, y));
    for (let percent = 1; percent <= 99; percent++) {
      const grid = C.randomGrid(1024, 1024, rect, percent / 100, seed);
      let i = 0,
        population = 0;
      for (let y = rect.y; y < rect.y + rect.height; y++)
        for (let x = rect.x; x < rect.x + rect.width; x++) {
          const expected = Number(units[i++] < percent / 100);
          assert.equal(grid.get(x, y), expected);
          population += expected;
        }
      assert.equal(grid.population, population);
    }
  }
});

test("reordered rectangle partitions reproduce the same global-coordinate field", () => {
  const full = C.randomGrid(
    1000,
    900,
    { x: 59, y: 61, width: 133, height: 137 },
    0.37,
    "18446744073709551615",
  );
  const merged = new C.SparseGrid(1000, 900);
  merged.set(0, 0, 1);
  merged.set(999, 899, 1);
  for (const rect of [
    { x: 128, y: 127, width: 64, height: 71 },
    { x: 59, y: 127, width: 69, height: 71 },
    { x: 128, y: 61, width: 64, height: 66 },
    { x: 59, y: 61, width: 69, height: 66 },
  ]) {
    const chunk = C.randomGrid(1000, 900, rect, 0.37, "18446744073709551615");
    for (const [x, y] of chunk.cells()) merged.set(x, y, 1);
  }
  for (let y = 61; y < 198; y++)
    for (let x = 59; x < 192; x++)
      assert.equal(merged.get(x, y), full.get(x, y));
  assert.equal(merged.population, full.population + 2);
  assert.equal(merged.get(0, 0), 1);
  assert.equal(merged.get(999, 899), 1);
  let progress = [];
  C.randomGrid(1, 1, { x: 0, y: 0, width: 1, height: 1 }, 0.5, "0", (p) =>
    progress.push(p),
  );
  assert.equal(progress.at(-1), 1);
});

test("random rectangles and densities reject invalid worker input", () => {
  for (const rect of [
    { x: -1, y: 0, width: 2, height: 1 },
    { x: 0, y: 0, width: 11, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
  ])
    assert.throws(() => C.randomGrid(10, 10, rect, 0.5, "42"));
  for (const density of [0, 1, NaN, "0.5"])
    assert.throws(() =>
      C.randomGrid(10, 10, { x: 0, y: 0, width: 1, height: 1 }, density, "42"),
    );
});

function dialogFixture({
  mode = "monitor",
  width = 64,
  height = 64,
  connected = true,
  post,
} = {}) {
  const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  const source = app.slice(
    app.indexOf("  let randomServerPending ="),
    app.indexOf('  $("importButton").onclick'),
  );
  const elements = {
    from: { value: "1.1" },
    to: { value: "2.2" },
    density: { value: "37" },
    seed: { value: "18446744073709551615" },
  };
  const nodes = { randomForm: { elements }, randomDialog: { open: false } },
    calls = [],
    workers = [],
    modes = [];
  const state = {
    mode,
    connected,
    busy: false,
    grid: new C.SparseGrid(width, height),
    status: { width, height, wrap: false },
    selection: { x: 0, y: 0, width: 2, height: 2 },
  };
  state.grid.set(0, 0, 1);
  const node = (id) => (nodes[id] ||= {});
  const ctx = {
    C,
    I: require("../web/i18n.js"),
    T: require("../web/i18n.js").t,
    $: node,
    safe: (f) => f,
    world: () => (state.mode === "editor" ? state.grid : state.status),
    parseCoord: (s) => {
      const [x, y] = s.split(".").map(Number);
      return { x: x - 1, y: y - 1 };
    },
    fmt: String,
    showDialog: (id) => {
      node(id).open = true;
    },
    closeDialog: (n) => {
      n.open = false;
    },
    state,
    api: async (path, body) => {
      calls.push({ path, body });
      return post ? await post() : { width, height, wrap: false };
    },
    refreshNow: async () => {},
    toast: () => {},
    scheduleRender: () => {},
    updateBusy: () => {},
    setConnection: (v) => {
      state.connected = v;
    },
    setMode: (m) => {
      state.mode = m;
      modes.push(m);
    },
    runWorker: async (action, data) => {
      workers.push(action);
      return {
        grid: C.randomGrid(
          data.width,
          data.height,
          data.rect,
          data.density,
          data.seed,
        ),
      };
    },
    transactionStart() {},
    transactionEnd() {},
    rememberTile() {},
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  node("randomButton").onclick();
  return {
    state,
    nodes,
    calls,
    workers,
    modes,
    elements,
    ctx,
    submit: () =>
      node("randomForm").onsubmit({
        preventDefault() {},
        currentTarget: node("randomForm"),
      }),
  };
}

test("actual random form serializes the full uint64 decimal seed in a compact monitor request", async () => {
  const f = dialogFixture();
  await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/new");
  assert.equal(f.calls[0].body.random.seed, "18446744073709551615");
  assert.equal(
    JSON.parse(JSON.stringify(f.calls[0].body)).random.seed,
    "18446744073709551615",
  );
  assert.equal(f.workers.length, 0);
  f.elements.seed.value = "18446744073709551616";
  await assert.rejects(f.submit());
  assert.equal(f.calls.length, 1);
});

test("large editor fields route only to the server, even a tiny rectangle; successful POST precedes mode switch", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const f = dialogFixture({
    mode: "editor",
    width: 100000,
    height: 100000,
    post: () => wait,
  });
  const original = f.state.grid;
  assert.equal(f.nodes.randomSubmit.textContent, "Create a new server field");
  assert.match(f.nodes.randomRouteDetails.textContent, /replac/i);
  assert.match(
    f.nodes.randomCounts.textContent.replace(/\s/g, ""),
    /10,000,000,000cells/,
  );
  const pending = f.submit();
  assert.equal(f.state.mode, "editor");
  assert.equal(f.workers.length, 0);
  assert.equal(f.nodes.randomSubmit.disabled, true);
  await assert.rejects(f.submit(), /wait/i);
  assert.equal(f.calls.length, 1);
  const payload = JSON.parse(JSON.stringify(f.calls[0].body));
  assert.deepEqual(payload, {
    width: 100000,
    height: 100000,
    wrap: false,
    random: {
      density: 0.37,
      seed: "18446744073709551615",
      rect: { x: 0, y: 0, width: 2, height: 2 },
    },
  });
  assert(Buffer.byteLength(JSON.stringify(payload)) < 250);
  release({ width: 100000, height: 100000, wrap: false });
  await pending;
  assert.deepEqual(f.modes, ["monitor"]);
  assert.equal(f.state.grid, original);
  assert.equal(original.get(0, 0), 1);
});

test("large offline or rejected random request leaves editor unchanged, with no worker fallback", async () => {
  const f = dialogFixture({
    mode: "editor",
    width: 100000,
    height: 100000,
    connected: false,
  });
  assert.equal(f.nodes.randomSubmit.disabled, true);
  assert.match(f.nodes.randomRouteDetails.textContent, /config.toml/);
  await assert.rejects(f.submit(), /server/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.workers.length, 0);
  assert.equal(f.state.mode, "editor");
  const failed = dialogFixture({
    mode: "editor",
    width: 100000,
    height: 100000,
    post: async () => {
      throw Error("memory budget");
    },
  });
  const original = failed.state.grid;
  await assert.rejects(failed.submit(), /memory budget/);
  assert.equal(failed.nodes.randomDialog.open, true);
  assert.equal(failed.nodes.randomError.hidden, false);
  assert.equal(failed.state.grid, original);
  assert.equal(original.get(0, 0), 1);
  assert.equal(failed.state.busy, false);
  assert.equal(failed.workers.length, 0);
  assert.equal(failed.modes.length, 0);
});

test("field-size routing is exact at 4194304 and small editor remains offline", async () => {
  for (const [w, h, expected] of [
    [4194303, 1, "local"],
    [2048, 2048, "local"],
    [4194305, 1, "server"],
    [100000, 100000, "server"],
    [1e9, 1e9, "server"],
  ]) {
    assert.equal(C.randomRoute("editor", w, h), expected);
    assert.equal(C.randomRoute("monitor", w, h), "server");
    if (expected === "server")
      assert.throws(
        () =>
          C.randomGrid(w, h, { x: 0, y: 0, width: 1, height: 1 }, 0.15, "42"),
        /server/i,
      );
  }
  const f = dialogFixture({
    mode: "editor",
    width: 2048,
    height: 2048,
    connected: false,
  });
  assert.equal(f.nodes.randomSubmit.disabled, false);
  assert.match(f.nodes.randomSubmit.textContent, /browser/);
  await f.submit();
  assert.deepEqual(f.workers, ["random"]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.mode, "editor");
});

test("actual editor replacement preserves every cell outside a partial-tile rectangle", () => {
  const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  const source = app.slice(
    app.indexOf("  function replaceRegionFromGrid("),
    app.indexOf('  $("randomForm").onsubmit ='),
  );
  const target = new C.SparseGrid(200, 200),
    rect = { x: 61, y: 63, width: 70, height: 68 };
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++)
      if ((x * 7 + y * 11) % 13 === 0) target.set(x, y, 1);
  const before = new Set([...target.cells()].map((p) => p.join(",")));
  const incoming = C.randomGrid(200, 200, rect, 0.15, "18446744073709551615");
  const context = {
    state: { grid: target },
    transactionStart() {},
    transactionEnd() {},
    rememberTile() {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.replaceRegionFromGrid(incoming, rect);
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const inside = x >= 61 && x < 131 && y >= 63 && y < 131;
      assert.equal(
        target.get(x, y),
        inside ? incoming.get(x, y) : Number(before.has(`${x},${y}`)),
      );
    }
});
