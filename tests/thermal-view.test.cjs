const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../web/core.js");
const Config = require("../web/config-editor.js");
const options = C.HEAT_DEFAULTS;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
function bin(period, count = 150, area = 1000) {
  return {
    count,
    area,
    knownLive: period ? count : 0,
    periodLog2Sum: period ? count * Math.log2(period) : 0,
    periodMax: period,
  };
}

test("empty regions remain exactly black, independent of heat coefficients", () => {
  assert.equal(C.thermalValue(bin(0, 0)), 0);
  assert.equal(C.thermalColor(0.95, 0), "#000000");
  assert.notEqual(C.thermalColor(0, 1), "#000000");
});

test("known periods monotonically warm on the fixed reference of 64", () => {
  let previous = -1;
  for (let period = 1; period <= 64; period++) {
    const value = C.thermalValue(bin(period, 1, 10000));
    assert.ok(value > previous);
    previous = value;
  }
  near(C.cycleActivityBase(1), options.heat_stable);
  near(C.cycleActivityBase(64), options.heat_cycle_max);
});

test("unknown activity is hotter than every certified cycle at equal density", () => {
  for (const density of [0.001, 0.05, 0.15, 0.5, 1]) {
    const count = density * 10000;
    const unknown = C.thermalValue(bin(0, count, 10000));
    for (let period = 1; period <= 64; period++)
      assert.ok(C.thermalValue(bin(period, count, 10000)) < unknown);
  }
});

test("density raises temperature for cyclic and unknown regions, then saturates", () => {
  for (const period of [0, 1, 2, 16, 64]) {
    const values = [1, 10, 100, 150, 500].map((count) =>
      C.thermalValue(bin(period, count, 1000)),
    );
    assert.ok(
      values[0] < values[1] && values[1] < values[2] && values[2] < values[3],
    );
    near(values[3], values[4]);
  }
});

test("unknown random fields at 15 percent use the fixed nearly red temperature", () => {
  const temperature = C.thermalValue(bin(0, 150, 1000));
  near(temperature, 0.95);
  const color = C.thermalColor(temperature);
  const [r, g, b] = color
    .slice(1)
    .match(/../g)
    .map((x) => parseInt(x, 16));
  assert.ok(r > 235 && g < 70 && b < 70);
  near(C.thermalValue(bin(0, 500, 1000)), temperature);
});

test("a sparse later state cools and known stable remnants cool further", () => {
  const initial = C.thermalValue(bin(0, 150, 1000));
  const sparse = C.thermalValue(bin(0, 1, 1000));
  const stable = C.thermalValue(bin(1, 1, 1000));
  assert.ok(initial > sparse && sparse > stable);
  near(stable, 0.082);
});

test("known periodic aggregates use live-population weights and a peak blend", () => {
  const data = {
    count: 100,
    area: 10000,
    knownLive: 100,
    periodLog2Sum: 150,
    periodMax: 8,
  };
  const mean =
    (50 * C.cycleActivityBase(1) + 50 * C.cycleActivityBase(8)) / 100;
  const peak = C.cycleActivityBase(8);
  near(
    C.thermalValue(data, { ...options, heat_density_gain: 0 }),
    0.75 * mean + 0.25 * peak,
  );
});

test("small unknown hot spots remain visible in an otherwise stable coarse bin", () => {
  const data = {
    count: 100,
    area: 10000,
    knownLive: 90,
    periodLog2Sum: 0,
    periodMax: 1,
  };
  const mean = 0.9 * options.heat_stable + 0.1 * options.heat_active;
  const average = C.thermalValue(data, {
    ...options,
    heat_density_gain: 0,
    heat_hotspot_mix: 0,
  });
  const blended = C.thermalValue(data, { ...options, heat_density_gain: 0 });
  const peak = C.thermalValue(data, {
    ...options,
    heat_density_gain: 0,
    heat_hotspot_mix: 1,
  });
  near(average, mean);
  near(blended, 0.75 * mean + 0.25 * options.heat_active);
  near(peak, options.heat_active);
  assert.ok(average < blended && blended < peak);
});

test("partial world-edge bins use their actual clipped area", () => {
  const clipped = C.thermalValue(bin(0, 5, 40));
  const untrimmed = C.thermalValue(bin(0, 5, 100));
  near(clipped, 0.9);
  near(untrimmed, 0.75);
  assert.ok(clipped > untrimmed);
});

test("period colors do not renormalize when the configured search limit changes", () => {
  const data = bin(8, 10, 1000);
  const a = C.thermalValue(data, { ...options, cycles_max_period: 16 });
  const b = C.thermalValue(data, { ...options, cycles_max_period: 64 });
  near(a, b);
  near(
    C.cycleActivityBase(8),
    options.heat_stable + (options.heat_cycle_max - options.heat_stable) / 2,
  );
});

test("viewport cache keys distinguish layer, world and metadata revision", () => {
  const data = {
    run_id: "world-a",
    generation: 128,
    metadata_revision: 1,
    layer: "life",
    x: 0,
    y: 0,
    width: 512,
    height: 512,
    scale: 4,
  };
  const keys = [
    data,
    { ...data, layer: "cycles" },
    { ...data, metadata_revision: 2 },
    { ...data, run_id: "world-b" },
    { ...data, generation: 129 },
  ].map(C.viewportCacheKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("cycle controls and heat coefficients are live changes in the visual configuration", () => {
  const initial = Config.normalizeConfig(),
    draft = Config.normalizeConfig(initial);
  draft.engine.cycles_start_generation = 512;
  draft.engine.cycles_max_period = 32;
  draft.display.heat_hotspot_mix = 0.5;
  assert.deepEqual(Config.validateConfig(draft), []);
  const plan = Config.buildChangePlan(initial, draft);
  assert.equal(plan.liveChanges.length, 3);
  assert.equal(plan.restartChanges.length, 0);
  assert.equal(plan.livePatch.engine.cycles_start_generation, 512);
});

test("configuration rejects ambiguous thermal ordering and density saturation", () => {
  const invalidCases = [
    { heat_cycle_max: 0.7 },
    { heat_density_gain: 0.4 },
    { heat_density_reference: 0 },
    { heat_hotspot_mix: 1.1 },
  ];
  for (const changes of invalidCases) {
    const config = Config.normalizeConfig();
    Object.assign(config.display, changes);
    assert.ok(
      Config.validateConfig(config).some((e) =>
        e.path.startsWith("display.heat_"),
      ),
    );
  }
});
