const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Catalog = require("../web/catalog.js");
const Core = require("../web/core.js");
const I = require("../web/i18n.js");

// Exercise the actual dialog handlers and load path with an isolated API fixture.
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const handlers = app.slice(
  app.indexOf("  const Catalog = window.LifeCatalog;"),
  app.indexOf("  function renderPatterns()"),
);
const demo = {
  name: "Test machine",
  note: "Initial state",
  preserveBoard: true,
  width: 112,
  height: 112,
  population: 3,
  rle: "#C LIFE width=112 height=112 origin_x=0 origin_y=0 wrap=0 generation=0\nx = 112, y = 112, rule = B3/S23\n10$10b3o!",
  demo: { generation: 120, observation: "The signal reached the output." },
};

function fixture({
  mode = "monitor",
  outcome = "complete",
  measuredCount = 0,
} = {}) {
  const elements = new Map(),
    calls = [],
    notices = [],
    cameraFrames = [];
  const state = {
    mode,
    busy: false,
    width: 700,
    height: 500,
    view: {},
    grid: { width: 200, height: 200 },
  };
  let generation = 0,
    pending = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, { replaceChildren() {} });
    return elements.get(id);
  }
  function status() {
    return {
      generation,
      pending_steps: pending,
      running: false,
      run_id: "imported-field",
    };
  }
  const context = {
    I,
    T: I.t,
    window: { LifeCatalog: Catalog },
    $: element,
    state,
    URLSearchParams,
    Option: function () {},
    safe: (fn) => fn,
    fmt: String,
    showDialog() {},
    closeDialog() {},
    updateBusy() {},
    progress() {},
    doneProgress() {},
    refreshNow() {},
    startPaste() {},
    viewChanged: () => cameraFrames.push({ ...state.view }),
    world: () => ({ width: 1000, height: 1000, wrap: true }),
    runWorker: async () => ({ width: 112, height: 112, grid: {} }),
    toast: (message) => notices.push(message),
    setTimeout: (resolve) => resolve(),
    async api(url, body) {
      calls.push({ url, body });
      if (url === "/import") {
        assert.equal(body.format, "rle");
        const parsed = Core.parseRLE(body.text);
        assert.equal(parsed.metadata.width, 112);
        assert.equal(parsed.metadata.wrap, 0);
        return status();
      }
      if (url === "/control") {
        assert.equal(body.action, "step");
        pending = body.steps;
        return status();
      }
      if (url === "/status") {
        generation = pending;
        pending = 0;
        const result = status();
        if (outcome === "replaced") result.run_id = "replacement-field";
        if (outcome === "clientReplaced")
          state.status = { run_id: "new-client-field" };
        if (outcome === "overshot") result.generation++;
        if (outcome === "cancelled") result.generation--;
        return result;
      }
      if (url.startsWith("/viewport?")) {
        const query = new URLSearchParams(url.split("?")[1]);
        assert.equal(query.get("run_id"), "imported-field");
        assert.equal(Number(query.get("generation")), generation);
        assert.equal(query.get("scale"), "1");
        return { ...status(), counts: [measuredCount] };
      }
      throw Error("Unexpected request " + url);
    },
  };
  vm.createContext(context);
  vm.runInContext(handlers, context);
  return {
    context,
    element,
    calls,
    notices,
    cameraFrames,
    submit: () =>
      element("patternDetailForm").onsubmit({ preventDefault() {} }),
  };
}

function select(f, pattern, compute = false) {
  f.context.openPatternDetail(pattern);
  f.element("detailCompute").checked = compute;
  f.element("detailCompute").onchange();
}

test("demo defaults to generation zero and describes the visible event", async () => {
  const f = fixture();
  f.context.openPatternDetail(demo);
  assert.equal(f.element("detailCompute").checked, false);
  assert.equal(
    f.element("detailComputeLabel").textContent,
    "Run to demonstration",
  );
  assert.match(f.element("detailReadout").textContent, /Generation 120/);
  assert.match(
    f.element("detailReadout").textContent,
    /The signal reached the output/,
  );
  await f.submit();
  assert.deepEqual(
    f.calls.map((call) => call.url),
    ["/import"],
  );
});

test("checked demo requests one ordinary step batch and observes its exact generation", async () => {
  const f = fixture();
  select(f, demo, true);
  await f.submit();
  assert.deepEqual(
    f.calls.map((call) => call.url),
    ["/import", "/control", "/status"],
  );
  assert.equal(f.calls[1].body.steps, 120);
  assert.equal(
    f.notices.at(-1),
    "Test machine · Generation 120. The signal reached the output.",
  );
});

test("demo bounds match the control API and require an authored finite board", async () => {
  for (const generation of [0, -1, 1.5, 10001, NaN, Infinity, "120"]) {
    const f = fixture();
    select(f, { ...demo, demo: { ...demo.demo, generation } }, true);
    assert.equal(f.element("detailCompute").disabled, true);
    await f.submit();
    assert.deepEqual(
      f.calls.map((call) => call.url),
      ["/import"],
    );
  }
  for (const generation of [1, 10000]) {
    const f = fixture();
    select(f, { ...demo, demo: { ...demo.demo, generation } }, true);
    await f.submit();
    assert.equal(f.calls[1].body.steps, generation);
  }
  const f = fixture();
  select(f, { ...demo, preserveBoard: false }, true);
  assert.equal(f.element("detailCompute").disabled, true);
});

test("a replacement field never reports the former machine demonstration", async () => {
  const f = fixture({ outcome: "replaced" });
  select(f, demo, true);
  await f.submit();
  assert(!f.notices.some((message) => message.includes(demo.demo.observation)));
});

test("completed demo frames its growth relative to the RLE origin", async () => {
  const framed = {
    ...demo,
    width: 20,
    height: 20,
    rle: demo.rle
      .replace("origin_x=0 origin_y=0", "origin_x=40 origin_y=50")
      .replace("x = 112, y = 112", "x = 20, y = 20"),
    demo: { ...demo.demo, view: { x: -10, y: -5, width: 80, height: 60 } },
  };
  const f = fixture();
  select(f, framed, true);
  await f.submit();
  assert.equal(f.cameraFrames.length, 2);
  const camera = f.cameraFrames.at(-1),
    canvas = f.context.state;
  assert.equal(camera.zoom, Math.min(20, 600 / 100, 400 / 80));
  assert.equal(camera.x + canvas.width / camera.zoom / 2, 40 - 10 + 80 / 2);
  assert.equal(camera.y + canvas.height / camera.zoom / 2, 50 - 5 + 60 / 2);
});

test("stale run or a newer client field prevents delayed camera movement", async () => {
  for (const outcome of ["replaced", "clientReplaced"]) {
    const f = fixture({ outcome });
    select(
      f,
      {
        ...demo,
        demo: { ...demo.demo, view: { x: 0, y: 0, width: 60, height: 60 } },
      },
      true,
    );
    await f.submit();
    assert.equal(f.cameraFrames.length, 1);
    assert(
      !f.notices.some((message) => message.includes(demo.demo.observation)),
    );
  }
});

for (const outcome of ["overshot", "cancelled"]) {
  test(`${outcome} steps never claim the target demonstration was observed`, async () => {
    const f = fixture({ outcome });
    select(f, demo, true);
    await assert.rejects(f.submit(), /Computation stopped/);
    assert(
      !f.notices.some((message) => message.includes(demo.demo.observation)),
    );
  });
}

test("offline editor prepares the machine for insertion without server computation", async () => {
  const f = fixture({ mode: "editor" });
  select(f, demo, true);
  assert.equal(f.element("detailComputeRow").hidden, true);
  await f.submit();
  assert.equal(f.calls.length, 0);
  assert.equal(f.context.state.clipboard.width, 112);
});

test("logic keeps its label and reads pinned actual cells even if expected data differs", async () => {
  const logic = {
    ...demo,
    inputs: [0, 1],
    verification: {
      kind: "logic",
      generation: 80,
      output_roi: { x: 20, y: 20, width: 3, height: 3 },
      expected_output: 1,
      expected_population: 5,
    },
  };
  const f = fixture({ measuredCount: 0 });
  select(f, logic, true);
  assert.equal(f.element("detailComputeLabel").textContent, "Run to readout");
  await f.submit();
  assert.equal(f.calls[1].body.steps, 80);
  assert(f.calls.at(-1).url.startsWith("/viewport?"));
  assert.match(
    f.notices.at(-1),
    /Live cells measured in the output window: 0\./,
  );
});
