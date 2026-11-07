/* Buildless browser client. Simulation remains authoritative on the backend. */
(() => {
  "use strict";
  const I = window.LifeI18n,
    T = I.t;
  I.bindDocument(document);
  const $ = (id) => document.getElementById(id),
    C = window.LifeCore,
    canvas = $("worldCanvas"),
    ctx = canvas.getContext("2d", { alpha: false });
  const settings = Object.assign(
    {
      levels: 32,
      bias: 0.12,
      gain: 2.5,
      upperGain: 1.8,
      cacheMB: 64,
      undoMB: 32,
      grid: true,
      ...C.HEAT_DEFAULTS,
    },
    readSettings(),
  );
  const state = {
    mode: "monitor",
    layer: "life",
    connected: false,
    grid: new C.SparseGrid(),
    status: null,
    view: { x: 0, y: 0, zoom: 1 },
    width: 1,
    height: 1,
    dpr: 1,
    tool: "draw",
    selection: null,
    clipboard: null,
    paste: null,
    drag: null,
    cursor: null,
    history: [],
    redo: [],
    historyBytes: 0,
    transaction: null,
    viewport: null,
    viewportKey: "",
    cache: new Map(),
    cacheBytes: 0,
    requesting: false,
    wantsRefresh: false,
    lastStatus: 0,
    generation: 0,
    backendConfig: null,
    busy: false,
    drawScheduled: false,
    space: false,
    initialFit: false,
    activeSettings: "display",
    worker: null,
    requestSerial: 0,
  };
  const thermalColors = Array.from({ length: 1024 }, (_, i) =>
    C.thermalColor(i / 1023),
  );
  let toastTimer, zoomTimer, pollTimer;
  let accessToken = "";
  try {
    accessToken = sessionStorage.getItem("life-access-token") || "";
  } catch {}
  let lastServerError = "";
  let editorStarted = false,
    serverDefaultsLoaded = false;
  const hasSavedDisplay = (() => {
    try {
      return !!localStorage.getItem("life-display-settings");
    } catch {
      return false;
    }
  })();
  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem("life-display-settings") || "{}");
    } catch {
      return {};
    }
  }
  function applyServerDisplay(display) {
    if (!display) return;
    const mapping = {
      gradient_levels: "levels",
      first_level_saturation: "gain",
      upper_level_saturation: "upperGain",
      tile_cache_mb: "cacheMB",
      ...Object.fromEntries(
        Object.keys(C.HEAT_DEFAULTS).map((key) => [key, key]),
      ),
    };
    for (const [from, to] of Object.entries(mapping))
      if (Number.isFinite(Number(display[from])))
        settings[to] = Number(display[from]);
    while (state.cacheBytes > settings.cacheMB * 1048576 && state.cache.size) {
      const first = state.cache.keys().next().value;
      state.cacheBytes -= state.cache.get(first).bytes;
      state.cache.delete(first);
    }
    updateStats();
    scheduleRender();
  }
  function loadServerDefaults() {
    if (serverDefaultsLoaded) return;
    serverDefaultsLoaded = true;
    if (!hasSavedDisplay)
      api("/config")
        .then((config) => applyServerDisplay(config.display))
        .catch(() => {
          serverDefaultsLoaded = false;
        });
  }
  function fmt(n) {
    return I.formatNumber(Number(n) || 0);
  }
  function decimal(value, digits) {
    return I.formatNumber(value, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }
  function toast(message, error = false) {
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => ($("toast").hidden = true),
      error ? 8500 : 4500,
    );
  }
  function progress(label, value) {
    $("loadProgress").hidden = false;
    $("loadIdle").hidden = true;
    $("loadProgress").setAttribute(
      "aria-valuenow",
      Math.round(Math.max(0, Math.min(1, value)) * 100),
    );
    $("loadText").textContent = label;
    $("loadBar").style.width =
      Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
  }
  function doneProgress() {
    if (!state.busy && !state.requesting) {
      $("loadProgress").hidden = true;
      $("loadIdle").hidden = false;
    }
  }
  function world() {
    return state.mode === "editor" ? state.grid : state.status || state.grid;
  }
  function currentPop() {
    return state.mode === "editor"
      ? state.grid.population
      : Number(state.status?.population || 0);
  }
  function setStatus(text) {
    $("statusText").textContent = text;
  }
  function showDialog(id) {
    const d = $(id);
    if (!d.open) d.showModal();
  }
  function closeDialog(d) {
    d.close();
  }
  document
    .querySelectorAll("[data-close]")
    .forEach((b) =>
      b.addEventListener("click", () => closeDialog(b.closest("dialog"))),
    );
  document.querySelectorAll("dialog").forEach((d) =>
    d.addEventListener("click", (e) => {
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          d.close();
      }
    }),
  );
  function authHeaders(extra = {}) {
    return accessToken
      ? { ...extra, Authorization: "Bearer " + accessToken }
      : extra;
  }
  async function api(path, body, method) {
    if (location.protocol === "file:")
      throw Error(
        T(
          "Offline mode. Open http://127.0.0.1:8765 to connect to the server.",
        ),
      );
    const r = await fetch("/api" + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: authHeaders(
        body === undefined ? {} : { "Content-Type": "application/json" },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      let detail;
      try {
        detail = (await r.json()).detail;
      } catch {}
      if (r.status === 401) {
        setStatus(T("Token required · Settings → Simulation / config"));
        throw Error(
          T(
            "The server requires a token. Enter LIFE_ACCESS_TOKEN in Settings → Simulation / config.",
          ),
        );
      }
      throw Error(
        typeof detail === "string"
          ? detail
          : JSON.stringify(detail) || T("Server error ") + r.status,
      );
    }
    return path === "/config"
      ? window.LifeConfig.parseConfigJSON(await r.text())
      : r.json();
  }
  function safe(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        toast(e.message || String(e), true);
        if ($("settingsDialog").open)
          showSettingsFeedback(e.message || String(e), true);
        setStatus(T("Operation failed"));
        doneProgress();
      }
    };
  }
  function setConnection(connected) {
    state.connected = connected;
    $("connection").classList.toggle("offline", !connected);
    $("connection").innerHTML =
      "<i></i>" + (connected ? T("Local server") : T("Offline mode"));
    $("sendButton").hidden = state.mode !== "editor" || !connected;
    $("monitorMode").title = connected
      ? T("Python server monitor")
      : T("Start the server to connect");
    $("checkpointButton").disabled = !connected || state.mode !== "monitor";
    if ($("randomDialog").open) updateRandomRoute();
  }
  function updateStats() {
    const w = world();
    $("generation").textContent = fmt(
      state.mode === "editor"
        ? 0
        : (state.viewport?.generation ?? state.status?.generation),
    );
    $("population").textContent = fmt(
      state.mode === "monitor"
        ? (state.viewport?.population ?? currentPop())
        : currentPop(),
    );
    $("dimensions").textContent = fmt(w.width) + " × " + fmt(w.height);
    $("boundaryLabel").textContent = w.wrap
      ? T("Torus · connected edges")
      : T("Dead beyond the edges");
    $("emptyOverlay").hidden = currentPop() > 0 || !!state.paste;
    $("engineLabel").textContent =
      state.mode === "editor" ? T("OFFLINE EDITOR") : "CPU · EXACT";
    $("engineLabel").title = state.status?.engine || "";
    const rate = Number(
      state.status?.generations_per_second || state.status?.gps || 0,
    );
    $("rate").innerHTML =
      (state.mode === "editor"
        ? "—"
        : decimal(rate, rate > 100 ? 0 : rate > 0 && rate < 1 ? 3 : 1)) +
      T(" <small>steps/s</small>");
    $("memoryInfo").textContent =
      T("Cache ") + decimal(state.cacheBytes / 1048576, 1) + T(" MB");
    $("memoryInfo").title =
      T("Process RAM: ") +
      decimal(Number(state.status?.resources?.rss_bytes || 0) / 1048576, 1) +
      T(" MB");
    $("undoButton").disabled = state.busy || !state.history.length;
    $("redoButton").disabled = state.busy || !state.redo.length;
    $("copyButton").disabled = state.busy || !state.selection;
    $("cutButton").disabled = state.busy || !state.selection;
    $("deleteButton").disabled = state.busy || !state.selection;
    $("pasteButton").disabled = state.busy || !state.clipboard;
    $("selectionInfo").textContent = state.selection
      ? fmt(state.selection.width) +
        " × " +
        fmt(state.selection.height) +
        T(" selected")
      : "";
  }
  function updateRun() {
    updateLayerToolbar();
    if ($("infoDialog").open) renderInfo();
    const s = state.status || {},
      running = !!s.running;
    $("runButton").innerHTML = running
      ? T("<span>Ⅱ</span> Pause")
      : T("<span>▶</span> Run");
    $("runLabel").textContent =
      state.mode === "editor"
        ? T("Editing")
        : running
          ? T("Running")
          : T("Paused");
    $("runLabel").classList.toggle(
      "running",
      running && state.mode === "monitor",
    );
    $("stepButton").disabled = !state.connected || running;
    $("runButton").disabled = !state.connected;
    const p =
      s.progress === null || s.progress === undefined
        ? null
        : Number(s.progress);
    $("stepPercent").textContent =
      p === null ? (running ? "…" : "—") : Math.round(p * 100) + "%";
    $("stepProgress").style.width =
      p === null ? "0%" : Math.round(p * 100) + "%";
    $("eta").textContent = !running
      ? T("Simulation paused")
      : Number.isFinite(s.eta_seconds) && s.eta_seconds !== null
        ? T("About ") + decimal(Number(s.eta_seconds), 1) + T(" s")
        : T("Computing · estimate after this step");
  }
  async function poll() {
    try {
      const s = await api("/status"),
        previous = state.status;
      if (
        previous &&
        (previous.run_id !== s.run_id ||
          previous.metadata_revision !== s.metadata_revision)
      ) {
        state.requestSerial++;
        state.cache.clear();
        state.cacheBytes = 0;
        state.viewport = null;
      }
      state.status = s;
      setConnection(true);
      loadServerDefaults();
      updateStats();
      updateRun();
      if (!state.initialFit) {
        state.initialFit = true;
        fitWorld();
      }
      if (
        state.mode === "monitor" &&
        (s.generation !== state.generation ||
          !state.viewport ||
          s.width !== previous?.width ||
          s.height !== previous?.height ||
          s.population !== previous?.population)
      ) {
        state.generation = s.generation;
        requestViewport();
      }
      const checkpoint = s.checkpoint || s.checkpoints;
      if (checkpoint) $("checkpointButton").title = JSON.stringify(checkpoint);
      if (s.error && s.error !== lastServerError) {
        lastServerError = s.error;
        toast(T("Simulation stopped: ") + s.error, true);
      }
      if (!s.error) lastServerError = "";
    } catch (e) {
      setConnection(false);
      if (!state.initialFit) {
        state.initialFit = true;
        setMode("editor");
        if (e.message.includes(T("token"))) toast(e.message, true);
        else showDialog("newDialog");
      }
      updateRun();
    } finally {
      pollTimer = setTimeout(poll, state.mode === "monitor" ? 600 : 2500);
    }
  }
  function refreshModeLabels() {
    const mode = state.mode;
    $("modeTitle").innerHTML =
      mode === "monitor"
        ? T("Watch<br>life evolve.")
        : T("Create<br>your own worlds.");
    $("modeDescription").innerHTML =
      mode === "monitor"
        ? T(
            "Large worlds. Simple rules.<br>Every generation computed exactly.",
          )
        : T(
            "From a single cell to a complete circuit.<br>Your space to experiment.",
          );
    $("controlHeading").textContent =
      mode === "monitor" ? T("CONTROLS") : T("TOOLS");
  }
  function setMode(mode) {
    if (mode === "monitor" && !state.connected) {
      toast(
        T(
          "Start the server and open http://127.0.0.1:8765. The editor works offline.",
        ),
        true,
      );
      return;
    }
    state.mode = mode;
    if (mode === "editor" && !editorStarted) {
      editorStarted = true;
      setTimeout(() => showDialog("newDialog"), 50);
    }
    state.selection = null;
    state.paste = null;
    state.drag = null;
    $("monitorMode").classList.toggle("active", mode === "monitor");
    $("editorMode").classList.toggle("active", mode === "editor");
    $("monitorControls").hidden = mode !== "monitor";
    $("editorControls").hidden = mode !== "editor";
    refreshModeLabels();
    setConnection(state.connected);
    updateStats();
    updateRun();
    fitWorld();
    setStatus(mode === "editor" ? T("Offline editor") : T("Monitor"));
    syncPaste();
  }
  function heatOptions() {
    return Object.fromEntries(
      Object.keys(C.HEAT_DEFAULTS).map((key) => [key, Number(settings[key])]),
    );
  }
  function updateLayerToolbar() {
    const monitor = state.mode === "monitor",
      heat = monitor && state.layer === "cycles",
      cycles = state.status?.cycles;
    $("heatLayerButton").hidden = !monitor;
    $("heatLayerButton").disabled = !state.connected || !cycles?.supported;
    $("heatLayerButton").title = cycles?.supported
      ? T("Qualitative activity from verified cycles and density")
      : T("Requires a server with cycle guards");
    $("lifeLayerButton").classList.toggle("active", !heat);
    $("heatLayerButton").classList.toggle("active", heat);
    $("lifeLayerButton").setAttribute("aria-pressed", String(!heat));
    $("heatLayerButton").setAttribute("aria-pressed", String(heat));
    $("thermalLegend").hidden = !heat;
    $("canvasLegend").hidden = heat;
    canvas.setAttribute(
      "aria-label",
      heat
        ? T(
            "Heatmap: empty is black, short verified cycles are cold, active and dense areas are warm",
          )
        : T("Field: dead cells are black, live cells are white"),
    );
    let explanation = monitor
      ? T("Black is dead · white is alive")
      : T("Editor · exact cells, density shades");
    if (heat) {
      explanation = T("Qualitative activity · not Shannon entropy");
      if (!cycles?.enabled)
        explanation += T(" · detection off, periods unknown");
      else if (
        Number(state.status?.generation) < Number(cycles.start_generation)
      )
        explanation += T(" · detection starts at step ") + fmt(cycles.start_generation);
    }
    $("layerExplanation").textContent = explanation;
    $("layerExplanation").title = explanation;
  }
  function setLayer(layer) {
    if (state.mode !== "monitor" || layer === state.layer) return;
    if (layer === "cycles" && !state.status?.cycles?.supported) {
      toast(T("This server does not yet support cycle guards."), true);
      return;
    }
    state.layer = layer;
    state.requestSerial++;
    state.viewport = null;
    updateLayerToolbar();
    scheduleRender();
    requestViewport();
  }
  $("lifeLayerButton").onclick = () => setLayer("life");
  $("heatLayerButton").onclick = () => setLayer("cycles");
  $("heatInfoButton").onclick = () => {
    renderInfo();
    showDialog("infoDialog");
  };
  function resize() {
    const rect = $("canvasWrap").getBoundingClientRect(),
      centerX = state.view.x + state.width / (2 * state.view.zoom),
      centerY = state.view.y + state.height / (2 * state.view.zoom);
    state.width = Math.max(1, rect.width);
    state.height = Math.max(1, rect.height);
    state.dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    if (!state.initialFit) fitWorld();
    else {
      state.view.x = centerX - state.width / (2 * state.view.zoom);
      state.view.y = centerY - state.height / (2 * state.view.zoom);
    }
    scheduleRender();
    if (state.mode === "monitor") requestViewport();
  }
  new ResizeObserver(resize).observe($("canvasWrap"));
  function fitWorld() {
    const w = world();
    state.view.zoom = Math.max(
      0.0000001,
      Math.min(
        32,
        Math.min((state.width - 70) / w.width, (state.height - 70) / w.height),
      ),
    );
    state.view.x = (w.width - state.width / state.view.zoom) / 2;
    state.view.y = (w.height - state.height / state.view.zoom) / 2;
    viewChanged();
  }
  function fitBounds() {
    const b = state.grid.bounds();
    if (!b.width) return fitWorld();
    state.view.zoom = Math.min(
      20,
      Math.min((state.width - 110) / b.width, (state.height - 100) / b.height),
    );
    state.view.x = b.x + (b.width - state.width / state.view.zoom) / 2;
    state.view.y = b.y + (b.height - state.height / state.view.zoom) / 2;
    viewChanged();
  }
  function zoomAt(factor, px = state.width / 2, py = state.height / 2) {
    const v = state.view,
      wx = v.x + px / v.zoom,
      wy = v.y + py / v.zoom;
    v.zoom = Math.max(0.0000001, Math.min(64, v.zoom * factor));
    v.x = wx - px / v.zoom;
    v.y = wy - py / v.zoom;
    viewChanged();
  }
  function viewChanged() {
    scheduleRender();
    if (state.mode === "monitor") {
      progress(T("Preparing zoom"), 0.15);
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(requestViewport, 110);
    }
  }
  function pixelCell(px, py) {
    return {
      x: Math.floor(state.view.x + px / state.view.zoom),
      y: Math.floor(state.view.y + py / state.view.zoom),
    };
  }
  function eventCell(e) {
    const r = canvas.getBoundingClientRect();
    return pixelCell(e.clientX - r.left, e.clientY - r.top);
  }
  function viewportSpec() {
    const w = world(),
      v = state.view;
    let scale =
      2 ** Math.max(0, Math.ceil(Math.log2(1 / Math.max(v.zoom, 0.0000001))));
    let x, y, right, bottom;
    do {
      x = Math.max(0, Math.floor(v.x / scale) * scale);
      y = Math.max(0, Math.floor(v.y / scale) * scale);
      right = Math.min(
        w.width,
        Math.ceil((v.x + state.width / v.zoom) / scale) * scale,
      );
      bottom = Math.min(
        w.height,
        Math.ceil((v.y + state.height / v.zoom) / scale) * scale,
      );
      if (
        Math.ceil(Math.max(0, right - x) / scale) *
          Math.ceil(Math.max(0, bottom - y) / scale) <=
        (state.mode === "monitor" && state.layer === "cycles"
          ? 350000
          : 1500000)
      )
        break;
      scale *= 2;
    } while (scale <= 2 ** 31);
    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
      scale,
    };
  }
  async function requestViewport() {
    if (state.mode !== "monitor" || !state.connected) return;
    if (state.requesting) {
      state.wantsRefresh = true;
      return;
    }
    const requestedLayer = state.layer;
    let spec = viewportSpec();
    if (!spec.width || !spec.height) {
      state.viewport = null;
      doneProgress();
      scheduleRender();
      return;
    }
    for (const entry of state.cache.values()) {
      const d = entry.data;
      if (
        d.run_id === state.status?.run_id &&
        d.generation === state.status?.generation &&
        (d.layer ?? "life") === requestedLayer &&
        (d.metadata_revision ?? 0) === (state.status?.metadata_revision ?? 0) &&
        d.scale === spec.scale &&
        d.x <= spec.x &&
        d.y <= spec.y &&
        d.x + d.width >= spec.x + spec.width &&
        d.y + d.height >= spec.y + spec.height
      ) {
        state.viewport = d;
        doneProgress();
        scheduleRender();
        updateStats();
        return;
      }
    }
    const marginX = Math.ceil((spec.width / spec.scale) * 0.1) * spec.scale,
      marginY = Math.ceil((spec.height / spec.scale) * 0.1) * spec.scale;
    const expanded = {
      x: Math.max(0, spec.x - marginX),
      y: Math.max(0, spec.y - marginY),
      scale: spec.scale,
    };
    expanded.width =
      Math.min(world().width, spec.x + spec.width + marginX) - expanded.x;
    expanded.height =
      Math.min(world().height, spec.y + spec.height + marginY) - expanded.y;
    if (
      Math.ceil(expanded.width / spec.scale) *
        Math.ceil(expanded.height / spec.scale) <=
      (requestedLayer === "cycles" ? 524288 : 2097152)
    )
      spec = expanded;
    state.requesting = true;
    state.wantsRefresh = false;
    const serial = ++state.requestSerial;
    progress(T("Loading visible area"), 0.25);
    try {
      const q = new URLSearchParams(spec);
      q.set("layer", requestedLayer);
      if (
        requestedLayer === "cycles" &&
        state.status?.metadata_revision !== undefined
      )
        q.set("metadata_revision", state.status.metadata_revision);
      if (state.status?.run_id) q.set("run_id", state.status.run_id);
      const result = await api("/viewport?" + q);
      if (
        serial !== state.requestSerial ||
        result.run_id !== state.status?.run_id ||
        requestedLayer !== state.layer ||
        (result.metadata_revision ?? 0) !==
          (state.status?.metadata_revision ?? 0)
      )
        return;
      if (
        requestedLayer === "cycles" &&
        (!result.cycles ||
          result.cycles.known_live?.length !== result.counts.length ||
          result.cycles.period_log2_sum?.length !== result.counts.length ||
          result.cycles.period_max?.length !== result.counts.length)
      )
        throw Object.assign(new Error(T("The server returned incomplete cycle metadata.")), { code: "CYCLE_METADATA_UNAVAILABLE" });
      result.layer = result.layer || requestedLayer;
      state.viewport = result;
      state.viewportKey = C.viewportCacheKey(result);
      const bytes = result.counts.length * (result.cycles ? 32 : 8);
      if (state.cache.has(state.viewportKey))
        state.cacheBytes -= state.cache.get(state.viewportKey).bytes;
      state.cache.set(state.viewportKey, { data: result, bytes });
      state.cacheBytes += bytes;
      while (
        state.cacheBytes > settings.cacheMB * 1048576 &&
        state.cache.size > 0
      ) {
        const first = state.cache.keys().next().value;
        state.cacheBytes -= state.cache.get(first).bytes;
        state.cache.delete(first);
      }
      progress(T("Field ready"), 1);
      scheduleRender();
      updateStats();
    } catch (e) {
      if (state.connected) setStatus(e.message);
      if (
        requestedLayer === "cycles" &&
        state.layer === "cycles" &&
        (e.code === "CYCLE_METADATA_UNAVAILABLE" || /not support|unsupported/i.test(e.message))
      ) {
        state.layer = "life";
        state.viewport = null;
        updateLayerToolbar();
        state.wantsRefresh = true;
        toast(T("Heatmap unavailable: ") + e.message, true);
      }
    } finally {
      state.requesting = false;
      setTimeout(doneProgress, 100);
      if (state.wantsRefresh) setTimeout(requestViewport, 50);
    }
  }
  function scheduleRender() {
    if (state.drawScheduled) return;
    state.drawScheduled = true;
    requestAnimationFrame(() => {
      state.drawScheduled = false;
      render();
    });
  }
  function render() {
    const { width: sw, height: sh, dpr, view: v } = state;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#080d10";
    ctx.fillRect(0, 0, sw, sh);
    const w = world(),
      wx = -v.x * v.zoom,
      wy = -v.y * v.zoom;
    ctx.fillStyle = "#000";
    ctx.fillRect(wx, wy, w.width * v.zoom, w.height * v.zoom);
    ctx.save();
    ctx.beginPath();
    ctx.rect(wx, wy, w.width * v.zoom, w.height * v.zoom);
    ctx.clip();
    let data;
    if (state.mode === "editor") {
      const spec = viewportSpec();
      if (spec.width && spec.height)
        data = C.aggregate(state.grid, spec, spec.scale);
    } else data = state.viewport;
    if (data) {
      const size = data.scale * v.zoom,
        gain = data.scale <= 64 ? settings.gain : settings.upperGain,
        thermal =
          state.mode === "monitor" &&
          state.layer === "cycles" &&
          data.layer === "cycles" &&
          !!data.cycles,
        thermalSettings = heatOptions();
      for (let r = 0; r < data.rows; r++) {
        const py = (data.y + r * data.scale - v.y) * v.zoom;
        if (py + size < 0 || py > sh) continue;
        for (let c = 0; c < data.columns; c++) {
          const n = data.counts[r * data.columns + c];
          if (!n) continue;
          const px = (data.x + c * data.scale - v.x) * v.zoom;
          if (px + size < 0 || px > sw) continue;
          const ax = Math.min(data.scale, w.width - (data.x + c * data.scale)),
            ay = Math.min(data.scale, w.height - (data.y + r * data.scale));
          if (thermal) {
            const index = r * data.columns + c;
            const value = C.thermalValue(
              {
                count: n,
                area: ax * ay,
                knownLive: data.cycles.known_live[index],
                periodLog2Sum: data.cycles.period_log2_sum[index],
                periodMax: data.cycles.period_max[index],
              },
              thermalSettings,
            );
            ctx.fillStyle = thermalColors[Math.round(value * 1023)];
          } else {
            const shade =
              data.scale === 1
                ? 255
                : Math.round(
                    C.shade(n, ax * ay, settings.levels, settings.bias, gain),
                  );
            ctx.fillStyle = "rgb(" + shade + "," + shade + "," + shade + ")";
          }
          ctx.fillRect(
            Math.floor(px),
            Math.floor(py),
            Math.max(1, Math.ceil(size)),
            Math.max(1, Math.ceil(size)),
          );
        }
      }
    }
    if (settings.grid && v.zoom >= 8) {
      ctx.strokeStyle = "#20312e";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      let x0 = Math.max(0, Math.floor(v.x)),
        x1 = Math.min(w.width, Math.ceil(v.x + sw / v.zoom)),
        y0 = Math.max(0, Math.floor(v.y)),
        y1 = Math.min(w.height, Math.ceil(v.y + sh / v.zoom));
      for (let x = x0; x <= x1; x++) {
        const px = (x - v.x) * v.zoom;
        ctx.moveTo(px, Math.max(0, wy));
        ctx.lineTo(px, Math.min(sh, wy + w.height * v.zoom));
      }
      for (let y = y0; y <= y1; y++) {
        const py = (y - v.y) * v.zoom;
        ctx.moveTo(Math.max(0, wx), py);
        ctx.lineTo(Math.min(sw, wx + w.width * v.zoom), py);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = "#2c433c";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(wx) + 0.5,
      Math.round(wy) + 0.5,
      w.width * v.zoom,
      w.height * v.zoom,
    );
    if (state.selection)
      drawRect(state.selection, "#85cdd3", "rgba(117,197,205,.08)");
    if (
      state.drag?.startCell &&
      ["rect", "line", "select"].includes(state.drag.tool) &&
      state.cursor
    ) {
      const r = normalizedRect(state.drag.startCell, state.cursor);
      if (state.drag.tool === "line") {
        ctx.strokeStyle = "#b8eb7e";
        ctx.lineWidth = Math.max(1, v.zoom);
        ctx.beginPath();
        ctx.moveTo(
          (state.drag.startCell.x + 0.5 - v.x) * v.zoom,
          (state.drag.startCell.y + 0.5 - v.y) * v.zoom,
        );
        ctx.lineTo(
          (state.cursor.x + 0.5 - v.x) * v.zoom,
          (state.cursor.y + 0.5 - v.y) * v.zoom,
        );
        ctx.stroke();
      } else drawRect(r, "#b8eb7e", "rgba(184,235,126,.07)");
    }
    if (state.paste && state.cursor) {
      ctx.fillStyle = "#b8eb7e";
      const p = state.paste;
      if (!p.previewGrid) {
        p.previewGrid = new C.SparseGrid(p.width, p.height);
        for (const [x, y] of p.cells) p.previewGrid.set(x, y, 1);
      }
      const scale =
          2 **
          Math.max(0, Math.ceil(Math.log2(1 / Math.max(v.zoom, 0.0000001)))),
        px0 = Math.max(0, Math.floor((v.x - state.cursor.x) / scale) * scale),
        py0 = Math.max(0, Math.floor((v.y - state.cursor.y) / scale) * scale),
        pw = Math.max(
          0,
          Math.min(
            p.width,
            Math.ceil((v.x + sw / v.zoom - state.cursor.x) / scale) * scale,
          ) - px0,
        ),
        ph = Math.max(
          0,
          Math.min(
            p.height,
            Math.ceil((v.y + sh / v.zoom - state.cursor.y) / scale) * scale,
          ) - py0,
        );
      if (pw && ph) {
        const preview = C.aggregate(
          p.previewGrid,
          { x: px0, y: py0, width: pw, height: ph },
          scale,
        );
        for (let r = 0; r < preview.rows; r++)
          for (let c = 0; c < preview.columns; c++)
            if (preview.counts[r * preview.columns + c])
              ctx.fillRect(
                (state.cursor.x + px0 + c * scale - v.x) * v.zoom,
                (state.cursor.y + py0 + r * scale - v.y) * v.zoom,
                Math.max(1, scale * v.zoom),
                Math.max(1, scale * v.zoom),
              );
      }
      drawRect(
        {
          x: state.cursor.x,
          y: state.cursor.y,
          width: p.width,
          height: p.height,
        },
        "#b8eb7e",
        "rgba(184,235,126,.04)",
      );
    }
    $("zoomValue").textContent =
      v.zoom >= 0.1
        ? Math.round(v.zoom * 100) + "%"
        : (v.zoom * 100).toPrecision(2) + "%";
    $("viewOrigin").textContent =
      Math.max(1, Math.floor(v.x) + 1) + "." + Math.max(1, Math.floor(v.y) + 1);
    const lod = data?.scale || 1;
    $("lodLabel").textContent =
      lod === 1 ? T("Cells") : lod + " × " + lod + T(" / block");
    canvas.style.cursor =
      state.space || state.tool === "pan"
        ? "grab"
        : state.mode === "editor"
          ? "crosshair"
          : "grab";
  }
  function drawRect(r, stroke, fill) {
    const v = state.view,
      x = (r.x - v.x) * v.zoom,
      y = (r.y - v.y) * v.zoom;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, r.width * v.zoom, r.height * v.zoom);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, r.width * v.zoom, r.height * v.zoom);
    ctx.setLineDash([]);
  }
  function normalizedRect(a, b) {
    const w = world(),
      x = Math.max(0, Math.min(a.x, b.x)),
      y = Math.max(0, Math.min(a.y, b.y)),
      right = Math.min(w.width - 1, Math.max(a.x, b.x)),
      bottom = Math.min(w.height - 1, Math.max(a.y, b.y));
    return {
      x,
      y,
      width: Math.max(0, right - x + 1),
      height: Math.max(0, bottom - y + 1),
    };
  }
  function transactionStart() {
    state.transaction = new Map();
  }
  function rememberTile(x, y) {
    if (!state.transaction) return;
    const key = Math.floor(x / 64) + "," + Math.floor(y / 64);
    if (!state.transaction.has(key)) {
      const t = state.grid.tiles.get(key);
      state.transaction.set(key, t ? new Uint32Array(t.bits) : null);
    }
  }
  function editCell(x, y, v) {
    if (!state.grid.inside(x, y)) return;
    rememberTile(x, y);
    state.grid.set(x, y, v);
  }
  function transactionEnd() {
    if (!state.transaction) return;
    const entries = [];
    for (const [k, before] of state.transaction) {
      const t = state.grid.tiles.get(k),
        after = t ? new Uint32Array(t.bits) : null;
      if (
        (!before && !after) ||
        (before && after && before.every((v, i) => v === after[i]))
      )
        continue;
      entries.push({ key: k, before, after });
    }
    state.transaction = null;
    if (entries.length) {
      const bytes = entries.reduce(
        (n, e) => n + (e.before ? 512 : 0) + (e.after ? 512 : 0) + 80,
        0,
      );
      state.redo = [];
      if (bytes > settings.undoMB * 1048576) {
        state.history = [];
        state.historyBytes = 0;
        toast(
          T(
            "Operation complete. It exceeds the history budget, so undo is unavailable.",
          ),
        );
      } else {
        state.history.push({ entries, bytes });
        state.historyBytes += bytes;
        while (
          state.historyBytes > settings.undoMB * 1048576 &&
          state.history.length > 1
        )
          state.historyBytes -= state.history.shift().bytes;
      }
    }
    updateStats();
    scheduleRender();
  }
  function undo(redo = false) {
    if (state.mode !== "editor" || state.busy) return;
    const source = redo ? state.redo : state.history,
      target = redo ? state.history : state.redo,
      change = source.pop();
    if (!change) return;
    for (const e of change.entries)
      state.grid.setTile(e.key, redo ? e.after : e.before);
    target.push(change);
    if (!redo) state.historyBytes -= change.bytes;
    else state.historyBytes += change.bytes;
    updateStats();
    scheduleRender();
  }
  function line(a, b, value) {
    if (Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) > 2000000)
      throw Error(T("A line cannot exceed 2 million cells per operation."));
    let x = a.x,
      y = a.y,
      dx = Math.abs(b.x - x),
      sx = x < b.x ? 1 : -1,
      dy = -Math.abs(b.y - y),
      sy = y < b.y ? 1 : -1,
      err = dx + dy,
      steps = 0;
    while (true) {
      editCell(x, y, value);
      if (x === b.x && y === b.y) break;
      const e = 2 * err;
      if (e >= dy) {
        err += dy;
        x += sx;
      }
      if (e <= dx) {
        err += dx;
        y += sy;
      }
      if (++steps > 2000000)
        throw Error(T("The line is too large for one editor operation."));
    }
  }
  canvas.addEventListener(
    "pointerdown",
    safe((e) => {
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      const p = eventCell(e);
      state.cursor = p;
      if (state.busy) return;
      if (
        state.mode === "monitor" ||
        state.space ||
        state.tool === "pan" ||
        e.button === 1
      ) {
        state.drag = {
          tool: "pan",
          px: e.clientX,
          py: e.clientY,
          x: state.view.x,
          y: state.view.y,
        };
        return;
      }
      if (state.paste && e.button === 0) {
        placePaste(p);
        return;
      }
      const tool = e.button === 2 ? "erase" : state.tool;
      state.drag = { tool, startCell: p, last: p };
      if (tool === "draw" || tool === "erase") {
        transactionStart();
        editCell(p.x, p.y, tool === "draw" ? 1 : 0);
        scheduleRender();
      }
    }),
  );
  canvas.addEventListener(
    "pointermove",
    safe((e) => {
      const p = eventCell(e);
      state.cursor = p;
      $("cursorPosition").textContent =
        T("Cursor ") + (p.x + 1) + "." + (p.y + 1);
      const d = state.drag;
      if (d?.tool === "pan") {
        state.view.x = d.x - (e.clientX - d.px) / state.view.zoom;
        state.view.y = d.y - (e.clientY - d.py) / state.view.zoom;
        viewChanged();
      } else if (d && (d.tool === "draw" || d.tool === "erase")) {
        line(d.last, p, d.tool === "draw" ? 1 : 0);
        d.last = p;
        scheduleRender();
      } else if (d || state.paste) scheduleRender();
    }),
  );
  function pointerEnd() {
    const d = state.drag;
    if (!d) return;
    try {
      if (d.tool === "select" && state.cursor) {
        const r = normalizedRect(d.startCell, state.cursor);
        state.selection = r.width && r.height ? r : null;
      } else if ((d.tool === "rect" || d.tool === "line") && state.cursor) {
        transactionStart();
        if (d.tool === "line") line(d.startCell, state.cursor, 1);
        else {
          const r = normalizedRect(d.startCell, state.cursor);
          if (r.width && r.height) {
            line({ x: r.x, y: r.y }, { x: r.x + r.width - 1, y: r.y }, 1);
            line(
              { x: r.x, y: r.y + r.height - 1 },
              { x: r.x + r.width - 1, y: r.y + r.height - 1 },
              1,
            );
            line({ x: r.x, y: r.y }, { x: r.x, y: r.y + r.height - 1 }, 1);
            line(
              { x: r.x + r.width - 1, y: r.y },
              { x: r.x + r.width - 1, y: r.y + r.height - 1 },
              1,
            );
          }
        }
      }
      transactionEnd();
    } catch (e) {
      transactionEnd();
      toast(e.message, true);
    }
    state.drag = null;
    updateStats();
    scheduleRender();
  }
  canvas.addEventListener("pointerup", pointerEnd);
  canvas.addEventListener("pointercancel", pointerEnd);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(
        Math.exp(-e.deltaY * 0.0017),
        e.clientX - r.left,
        e.clientY - r.top,
      );
    },
    { passive: false },
  );
  function selectTool(tool) {
    if (state.mode !== "editor") return;
    state.tool = tool;
    state.paste = null;
    syncPaste();
    document
      .querySelectorAll("[data-tool]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    refreshToolHint();
    scheduleRender();
  }
  function refreshToolHint() {
    const hints = {
      draw: T("Draw with the left mouse button. Right-click erases."),
      erase: T("Erase cells. Hold Space and drag to pan."),
      pan: T("Drag to pan. Scroll to zoom."),
      select: T("Drag a rectangular selection. Ctrl+C copies it."),
      line: T("Draw a precise cell line between two points."),
      rect: T("Draw a rectangle outline."),
    };
    $("toolHint").textContent = hints[state.tool];
    scheduleRender();
  }
  function clearSelection() {
    if (state.busy || !state.selection || state.mode !== "editor") return;
    replaceRegionFromGrid(
      new C.SparseGrid(state.grid.width, state.grid.height),
      state.selection,
    );
  }
  function copySelection(cut = false) {
    if (state.busy) return;
    if (!state.selection) return toast(T("Select an area first."));
    const r = state.selection,
      cells = [];
    for (const [x, y] of state.grid.cells(r)) {
      if (cells.length >= 2000000)
        return toast(
          T("The editor clipboard is limited to 2 million live cells. Reduce the selection."),
          true,
        );
      cells.push([x - r.x, y - r.y]);
    }
    state.clipboard = { width: r.width, height: r.height, cells };
    if (cut) clearSelection();
    updateStats();
    toast(
      T("Copied ") +
        fmt(state.clipboard.cells.length) +
        T(" live cells."),
    );
  }
  function startPaste() {
    if (state.busy) return;
    if (!state.clipboard)
      return toast(T("The clipboard is empty. Copy an area or choose a pattern."));
    state.paste = state.clipboard.previewGrid
      ? {
          width: state.clipboard.width,
          height: state.clipboard.height,
          previewGrid: state.clipboard.previewGrid,
        }
      : {
          width: state.clipboard.width,
          height: state.clipboard.height,
          cells: state.clipboard.cells.map((c) => c.slice()),
        };
    if (!state.cursor)
      state.cursor = pixelCell(state.width / 2, state.height / 2);
    syncPaste();
    scheduleRender();
  }
  function syncPaste() {
    $("pasteBar").hidden = !state.paste;
    $("emptyOverlay").hidden = currentPop() > 0 || !!state.paste;
  }
  function placePaste(pos) {
    const p = state.paste;
    if (!p) return;
    if (
      pos.x < 0 ||
      pos.y < 0 ||
      pos.x + p.width > state.grid.width ||
      pos.y + p.height > state.grid.height
    )
      return toast(
        T(
          "The entire pattern must fit inside the field. Change its position or the field size.",
        ),
        true,
      );
    transactionStart();
    for (const [x, y] of p.cells || p.previewGrid.cells())
      editCell(pos.x + x, pos.y + y, 1);
    transactionEnd();
    state.selection = { x: pos.x, y: pos.y, width: p.width, height: p.height };
    state.paste = null;
    syncPaste();
    updateStats();
    setStatus(T("Pattern pasted"));
  }
  function transformSelection(kind) {
    if (state.busy) return;
    if (state.paste) {
      if (!state.paste.cells && state.paste.previewGrid) {
        const p = state.paste,
          rotate = kind === "rotate";
        const grid = new C.SparseGrid(
          rotate ? p.height : p.width,
          rotate ? p.width : p.height,
        );
        for (const [x, y] of p.previewGrid.cells()) {
          if (rotate) grid.set(p.height - 1 - y, x, 1);
          else grid.set(p.width - 1 - x, y, 1);
        }
        state.paste = {
          width: grid.width,
          height: grid.height,
          previewGrid: grid,
        };
        scheduleRender();
        return;
      }
      state.paste = C.transform(
        state.paste.cells,
        state.paste.width,
        state.paste.height,
        kind,
      );
      scheduleRender();
      return;
    }
    if (!state.selection)
      return toast(T("Select an area or prepare a paste."));
    const r = state.selection,
      cells = [];
    for (const [x, y] of state.grid.cells(r)) {
      if (cells.length >= 2000000)
        return toast(
          T("Transformations are limited to 2 million live cells per operation."),
          true,
        );
      cells.push([x - r.x, y - r.y]);
    }
    const p = C.transform(cells, r.width, r.height, kind);
    if (r.x + p.width > state.grid.width || r.y + p.height > state.grid.height)
      return toast(T("The rotated area extends beyond the field."), true);
    transactionStart();
    for (const [x, y] of Array.from(state.grid.cells(r))) editCell(x, y, 0);
    for (const [x, y] of p.cells) editCell(r.x + x, r.y + y, 1);
    state.selection = { x: r.x, y: r.y, width: p.width, height: p.height };
    transactionEnd();
  }
  function resetEditor(grid) {
    if (state.busy) throw Error(T("Wait for field processing to finish."));
    state.grid = grid;
    state.selection = null;
    state.paste = null;
    state.history = [];
    state.redo = [];
    state.historyBytes = 0;
    state.transaction = null;
    syncPaste();
    updateStats();
    scheduleRender();
  }
  function expandEditor(width, height) {
    new C.SparseGrid(width, height);
    state.grid.width = width;
    state.grid.height = height;
    updateStats();
    toast(T("Field expanded to fit the pattern. Existing cells preserved."));
  }
  function parseCoord(text) {
    const m = String(text)
      .trim()
      .match(/^(\d+)\.(\d+)$/);
    if (!m)
      throw Error(
        T("Enter coordinates as column.row, for example 1666.1888."),
      );
    return { x: Number(m[1]) - 1, y: Number(m[2]) - 1 };
  }
  async function runWorker(action, data) {
    if (
      action === "random" &&
      C.randomRoute("editor", data.width, data.height) === "server"
    )
      throw Error(T("Large fields can only be randomized on the server."));
    if (state.busy) throw Error(T("Wait for the current operation to finish."));
    state.busy = true;
    updateBusy();
    progress(
      action === "random"
        ? T("Filling area")
        : T("Reading initial state"),
      0.05,
    );
    if (state.worker) state.worker.terminate();
    const source =
      I.workerSource() +
      "const C=(" +
      createLifeCore.toString() +
      ')();self.onmessage=function(e){try{const {action,data}=e.data;let result;if(action==="random"){result={grid:C.randomGrid(data.width,data.height,data.rect,data.density,data.seed,p=>self.postMessage({progress:p}))};}else if(action==="json"){result=C.parseStateJSON(data.text);}else{result=C.parseRLE(data.text);}const packed=result.grid.packed();self.postMessage({done:true,grid:packed,metadata:result.metadata,width:result.width,height:result.height},packed.tiles.map(t=>t[1]));}catch(e){self.postMessage({error:e.message});}}';
    const url = URL.createObjectURL(
      new Blob([source], { type: "application/javascript" }),
    );
    try {
      return await new Promise((resolve, reject) => {
        const worker = new Worker(url);
        state.worker = worker;
        worker.onmessage = (e) => {
          if (e.data.progress !== undefined)
            progress(T("Filling area"), e.data.progress);
          if (e.data.error) reject(Error(e.data.error));
          if (e.data.done)
            resolve({ ...e.data, grid: C.SparseGrid.unpack(e.data.grid) });
        };
        worker.onerror = (e) =>
          reject(Error(e.message || T("Background worker error.")));
        worker.postMessage({ action, data });
      });
    } finally {
      URL.revokeObjectURL(url);
      state.worker?.terminate();
      state.worker = null;
      state.busy = false;
      updateBusy();
      doneProgress();
    }
  }
  function updateBusy() {
    for (const id of [
      "newButton",
      "randomButton",
      "patternsButton",
      "emptyPatterns",
      "importButton",
      "exportButton",
      "sendButton",
      "editorMode",
      "monitorMode",
      "copyButton",
      "cutButton",
      "pasteButton",
      "rotateButton",
      "flipButton",
      "deleteButton",
      "undoButton",
      "redoButton",
    ])
      $(id).disabled = state.busy;
    if (!state.busy) updateStats();
  }
  function download(text, name, type = "text/plain") {
    const a = document.createElement("a"),
      url = URL.createObjectURL(new Blob([text], { type }));
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function importText(text, format) {
    if (state.mode === "monitor") {
      await api("/import", { text, format });
      await refreshNow();
      fitWorld();
      toast(T("Initial state loaded into the simulation."));
      return;
    }
    const parsed = await runWorker(format === "json" ? "json" : "rle", {
      text,
    });
    if (format === "json") {
      resetEditor(parsed.grid);
      fitWorld();
    } else {
      const m = parsed.metadata || {};
      if (m.width && m.height) {
        const grid = new C.SparseGrid(m.width, m.height, !!m.wrap),
          ox = m.origin_x || 0,
          oy = m.origin_y || 0;
        for (const [x, y] of parsed.grid.cells()) {
          if (!grid.inside(x + ox, y + oy))
            throw Error(T("The RLE position extends beyond the field."));
          grid.set(x + ox, y + oy, 1);
        }
        resetEditor(grid);
        fitBounds();
      } else {
        state.clipboard = {
          width: parsed.width,
          height: parsed.height,
          cells: Array.from(parsed.grid.cells()),
        };
        if (
          parsed.width > state.grid.width ||
          parsed.height > state.grid.height
        ) {
          expandEditor(
            Math.max(state.grid.width, parsed.width + 64),
            Math.max(state.grid.height, parsed.height + 64),
          );
          fitWorld();
        }
        startPaste();
      }
    }
    toast(
      format === "json"
        ? T("Field imported.")
        : T("RLE loaded. ") +
            (state.paste
              ? T("Choose where to paste.")
              : T("Field restored.")),
    );
  }
  async function refreshNow() {
    state.requestSerial++;
    state.status = await api("/status");
    state.generation = state.status.generation;
    state.viewport = null;
    state.cache.clear();
    state.cacheBytes = 0;
    updateStats();
    updateRun();
    await requestViewport();
  }
  $("monitorMode").onclick = () => setMode("monitor");
  $("editorMode").onclick = () => setMode("editor");
  $("newButton").onclick = () => showDialog("newDialog");
  $("emptyPatterns").onclick = $("patternsButton").onclick = () => {
    renderPatterns();
    showDialog("patternsDialog");
  };
  $("helpButton").onclick = () => showDialog("helpDialog");
  $("fitButton").onclick = $("fitIcon").onclick = fitWorld;
  $("zoomIn").onclick = () => zoomAt(1.5);
  $("zoomOut").onclick = () => zoomAt(1 / 1.5);
  $("runButton").onclick = safe(async () => {
    await api("/control", { action: state.status?.running ? "pause" : "run" });
    await refreshNow();
  });
  $("stepButton").onclick = safe(async () => {
    await api("/control", { action: "step", steps: 1 });
    await refreshNow();
  });
  $("speed").oninput = () => {
    const n = Number($("speed").value);
    $("speedValue").textContent =
      n === 10
        ? T("Maximum")
        : fmt([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000][n]) + T(" steps/s");
  };
  $("speed").onchange = safe(async () => {
    const n = Number($("speed").value),
      rate = n === 10 ? 0 : [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000][n];
    await api("/control", { action: "speed", generations_per_second: rate });
  });
  document
    .querySelectorAll("[data-tool]")
    .forEach((b) => (b.onclick = () => selectTool(b.dataset.tool)));
  $("undoButton").onclick = () => undo();
  $("redoButton").onclick = () => undo(true);
  $("copyButton").onclick = () => copySelection();
  $("cutButton").onclick = () => copySelection(true);
  $("pasteButton").onclick = startPaste;
  $("pasteCenter").onclick = () => {
    if (state.mode !== "editor" || state.busy || !state.paste) return;
    placePaste({
      x: Math.floor((state.grid.width - state.paste.width) / 2),
      y: Math.floor((state.grid.height - state.paste.height) / 2),
    });
  };
  $("deleteButton").onclick = clearSelection;
  $("rotateButton").onclick = $("pasteRotate").onclick = () =>
    transformSelection("rotate");
  $("flipButton").onclick = $("pasteFlip").onclick = () =>
    transformSelection("flip");
  $("cancelPaste").onclick = () => {
    state.paste = null;
    syncPaste();
    scheduleRender();
  };
  $("newForm").onsubmit = safe(async (e) => {
    e.preventDefault();
    const f = e.currentTarget,
      w = Number(f.elements.width.value),
      h = Number(f.elements.height.value),
      wrap = f.elements.wrap.checked;
    if (state.mode === "monitor") {
      await api("/new", { width: w, height: h, wrap });
      await refreshNow();
    } else resetEditor(new C.SparseGrid(w, h, wrap));
    closeDialog($("newDialog"));
    fitWorld();
    setStatus(T("New field created"));
  });
  $("gotoForm").onsubmit = safe((e) => {
    e.preventDefault();
    const p = parseCoord($("gotoInput").value),
      w = world();
    if (p.x < 0 || p.y < 0 || p.x >= w.width || p.y >= w.height)
      throw Error(T("Coordinates are outside the field."));
    state.view.zoom = Math.max(state.view.zoom, 8);
    state.view.x = p.x + 0.5 - state.width / state.view.zoom / 2;
    state.view.y = p.y + 0.5 - state.height / state.view.zoom / 2;
    viewChanged();
  });
  let randomServerPending = false;
  function randomRectangle(f, w) {
    const a = parseCoord(f.elements.from.value),
      b = parseCoord(f.elements.to.value);
    if (
      a.x < 0 ||
      a.y < 0 ||
      b.x < a.x ||
      b.y < a.y ||
      b.x >= w.width ||
      b.y >= w.height
    )
      throw Error(
        T("Check the rectangle: its coordinates must lie inside the field."),
      );
    return { x: a.x, y: a.y, width: b.x - a.x + 1, height: b.y - a.y + 1 };
  }
  function updateRandomRoute() {
    const w = world(),
      f = $("randomForm"),
      server = C.randomRoute(state.mode, w.width, w.height) === "server";
    let rect = null;
    try {
      rect = randomRectangle(f, w);
    } catch {}
    const count = (w, h) => (BigInt(w) * BigInt(h)).toLocaleString(I.locale());
    $("randomCounts").textContent =
      T("Field: ") +
      fmt(w.width) +
      " × " +
      fmt(w.height) +
      " (" +
      count(w.width, w.height) +
      T(" cells). Area: ") +
      (rect
        ? fmt(rect.width) +
          " × " +
          fmt(rect.height) +
          " (" +
          count(rect.width, rect.height) +
          T(" cells).")
        : T("check the coordinates."));
    $("randomRouteDetails").textContent = !server
      ? T(
          "In the browser: only the selected editor area will be replaced. The rest of your drawing is preserved.",
        )
      : (state.mode === "editor"
          ? T(
              "Fields larger than 4,194,304 cells are randomized on the server. Your editor drawing is preserved. ",
            )
          : T("Server computation. ")) +
        T(
          "A new server field will replace the current one; cells outside the selected area will be dead.",
        ) +
        (!state.connected
          ? T(
              " Start the server and open http://127.0.0.1:8765, or export a startup config.toml in Settings.",
            )
          : "");
    $("randomSubmit").textContent = randomServerPending
      ? T("Creating on server…")
      : server
        ? T("Create a new server field")
        : T("Fill area in browser");
    $("randomSubmit").disabled =
      randomServerPending || !rect || (server && !state.connected);
    for (const name of ["from", "to", "density", "seed"])
      f.elements[name].disabled = randomServerPending;
    $("randomFull").disabled = randomServerPending;
  }
  $("randomForm").oninput = () => {
    $("randomError").hidden = true;
    updateRandomRoute();
  };
  $("randomButton").onclick = () => {
    const w = world(),
      r = state.selection || { x: 0, y: 0, width: w.width, height: w.height },
      f = $("randomForm");
    f.elements.from.value = r.x + 1 + "." + (r.y + 1);
    f.elements.to.value = r.x + r.width + "." + (r.y + r.height);
    $("randomError").hidden = true;
    updateRandomRoute();
    showDialog("randomDialog");
  };
  $("randomFull").onclick = () => {
    const w = world(),
      f = $("randomForm");
    f.elements.from.value = "1.1";
    f.elements.to.value = w.width + "." + w.height;
    updateRandomRoute();
  };
  function replaceRegionFromGrid(source, rect) {
    const keys = new Set();
    for (const [k, t] of state.grid.tiles)
      if (
        t.x * 64 < rect.x + rect.width &&
        t.y * 64 < rect.y + rect.height &&
        t.x * 64 + 64 > rect.x &&
        t.y * 64 + 64 > rect.y
      )
        keys.add(k);
    for (const k of source.tiles.keys()) keys.add(k);
    transactionStart();
    for (const k of keys) {
      const [tx, ty] = k.split(",").map(Number),
        ox = tx * 64,
        oy = ty * 64;
      rememberTile(ox, oy);
      if (
        ox >= rect.x &&
        oy >= rect.y &&
        ox + 64 <= rect.x + rect.width &&
        oy + 64 <= rect.y + rect.height
      ) {
        state.grid.setTile(k, source.tiles.get(k)?.bits || null);
      } else {
        const bits = new Uint32Array(state.grid.tiles.get(k)?.bits || 128),
          incoming = source.tiles.get(k)?.bits;
        for (
          let y = Math.max(0, rect.y - oy);
          y < Math.min(64, rect.y + rect.height - oy);
          y++
        )
          for (
            let x = Math.max(0, rect.x - ox);
            x < Math.min(64, rect.x + rect.width - ox);
            x++
          ) {
            const i = y * 64 + x,
              m = 1 << (i & 31);
            if (incoming && incoming[i >>> 5] & m) bits[i >>> 5] |= m;
            else bits[i >>> 5] &= ~m;
          }
        state.grid.setTile(k, bits);
      }
    }
    transactionEnd();
  }
  $("randomForm").onsubmit = safe(async (e) => {
    e.preventDefault();
    const f = e.currentTarget,
      w = world(),
      rect = randomRectangle(f, w),
      density = Number(f.elements.density.value) / 100,
      seed = C.randomSeed(f.elements.seed.value);
    if (!Number.isFinite(density) || density < 0.01 || density > 0.99)
      throw Error(T("Density must be 1–99%."));
    if (randomServerPending || state.busy)
      throw Error(T("Wait for the current operation to finish."));
    if (C.randomRoute(state.mode, w.width, w.height) === "server") {
      if (!state.connected)
        throw Error(
          T(
            "For this field, start the server and open http://127.0.0.1:8765, or download a startup config.toml.",
          ),
        );
      randomServerPending = true;
      state.busy = true;
      updateBusy();
      updateRandomRoute();
      $("randomError").hidden = true;
      try {
        const result = await api("/new", {
          width: w.width,
          height: w.height,
          wrap: w.wrap,
          random: { density, seed, rect },
        });
        // Change views only after the server commits the new authoritative field.
        state.status = result;
        setConnection(true);
        closeDialog($("randomDialog"));
        if (state.mode === "editor") setMode("monitor");
        await refreshNow();
        toast(
          T(
            "New server state created. Cells outside the rectangle are dead.",
          ),
        );
      } catch (error) {
        $("randomError").textContent = error.message;
        $("randomError").hidden = false;
        throw error;
      } finally {
        randomServerPending = false;
        state.busy = false;
        updateBusy();
        if ($("randomDialog").open) updateRandomRoute();
      }
    } else {
      closeDialog($("randomDialog"));
      const result = await runWorker("random", {
        width: w.width,
        height: w.height,
        rect,
        density,
        seed,
      });
      replaceRegionFromGrid(result.grid, rect);
      toast(T("Area filled. Live cells: ") + fmt(result.grid.population));
    }
    scheduleRender();
  });
  $("importButton").onclick = () => $("fileInput").click();
  $("fileInput").onchange = safe(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 256 * 1048576)
      throw Error(
        T("The file exceeds 256 MB. Use the server's initial.path setting."),
      );
    const text = await file.text();
    e.target.value = "";
    await importText(
      text,
      file.name.toLowerCase().endsWith(".json") ? "json" : "rle",
    );
  });
  $("exportButton").onclick = () => showDialog("exportDialog");
  $("exportForm").onsubmit = safe(async (e) => {
    e.preventDefault();
    const format = e.currentTarget.elements.format.value;
    closeDialog($("exportDialog"));
    if (state.mode === "monitor") {
      const r = await fetch("/api/export?format=" + format, {
        headers: authHeaders(),
      });
      if (!r.ok) {
        let message = T("Could not export the state.");
        try {
          message = (await r.json()).detail || message;
        } catch {}
        throw Error(message);
      }
      download(
        await r.text(),
        "life-g" + state.generation + "." + format,
        format === "json" ? "application/json" : "text/plain",
      );
    } else {
      if (state.grid.population > 2000000)
        throw Error(
          T(
            "Editor text exports are limited to 2 million live cells. For larger states, use server randomization and checkpoints.",
          ),
        );
      download(
        format === "json"
          ? C.encodeStateJSON(state.grid)
          : C.encodeRLE(state.grid),
        "life-initial." + format,
        format === "json" ? "application/json" : "text/plain",
      );
    }
    toast(T("File ready."));
  });
  $("sendButton").onclick = safe(async () => {
    if (state.grid.population > 2000000)
      throw Error(
        T(
          "Initial-state transfers are limited to 2 million live cells. Create larger random fields on the server.",
        ),
      );
    await api("/import", {
      text: C.encodeStateJSON(state.grid),
      format: "json",
    });
    await refreshNow();
    setMode("monitor");
    toast(T("Field transferred. You can start the simulation."));
  });
  $("checkpointButton").onclick = safe(async () => {
    setStatus(T("Saving state…"));
    const result = await api("/checkpoint", {});
    toast(result.message || T("Checkpoint saved."));
    setStatus(T("State saved"));
  });
  const Catalog = window.LifeCatalog;
  let detailPattern = null;
  function selectedPatternCase() {
    return I.pattern(
      Catalog.caseOf(detailPattern, Number($("detailVariant").value || 0)),
    );
  }
  function hasLogicReadout(p) {
    return (
      p.preserveBoard &&
      Array.isArray(p.inputs) &&
      p.verification?.kind === "logic" &&
      Number.isSafeInteger(p.verification.generation) &&
      p.verification.generation > 0 &&
      p.verification.generation <= 10000 &&
      p.verification.output_roi
    );
  }
  function hasDeviceDemo(p) {
    return (
      p.preserveBoard &&
      Number.isSafeInteger(p.demo?.generation) &&
      p.demo.generation > 0 &&
      p.demo.generation <= 10000 &&
      typeof p.demo.observation === "string" &&
      p.demo.observation.trim().length > 0
    );
  }
  function patternTargetGeneration(p) {
    if (hasLogicReadout(p)) return p.verification.generation;
    return hasDeviceDemo(p) ? p.demo.generation : null;
  }
  function updatePatternDetail() {
    const p = selectedPatternCase();
    $("detailSize").textContent =
      T`${fmt(p.width)} × ${fmt(p.height)} cells · ${fmt(p.population)} initially alive.`;
    const logic = hasLogicReadout(p);
    const generation = patternTargetGeneration(p);
    const readout =
      Catalog.readoutDescription(p.verification) ||
      (hasDeviceDemo(p)
        ? T`Generation ${generation}. ${p.demo.observation}`
        : "");
    $("detailReadout").hidden = !readout;
    $("detailReadout").textContent = readout;
    const detail = I.pattern(detailPattern);
    $("detailName").textContent = detail.name;
    $("detailType").textContent = detail.type;
    $("detailNote").textContent = detail.description || detail.note;
    $("detailLoad").textContent =
      state.mode === "editor"
        ? T("Prepare to paste")
        : T("Load into monitor");
    const editor = state.mode === "editor";
    const canCompute = !editor && generation !== null;
    $("detailComputeRow").hidden = !canCompute;
    $("detailCompute").disabled = !canCompute;
    $("detailComputeLabel").textContent = logic
      ? T("Run to readout")
      : T("Run to demonstration");
    $("detailActionHint").textContent = editor
      ? T("Choose a place on the field to paste the pattern.")
      : T(
          "This circuit replaces the monitor's current field and opens paused at generation 0.",
        );
    if (canCompute && $("detailCompute").checked) {
      $("detailActionHint").textContent = logic
        ? T`This circuit replaces the monitor's field. The engine will run B3/S23 to generation ${generation} and count live cells in the output window.`
        : T`This circuit replaces the monitor's field. The engine will run B3/S23 to generation ${generation} and pause for viewing.`;
    }
  }
  function openPatternDetail(p) {
    detailPattern = p;
    $("detailName").textContent = p.name;
    $("detailType").textContent = p.type;
    $("detailVariantLabel").hidden = !p.variants;
    $("detailVariant").replaceChildren(
      ...(p.variants || []).map((v, i) => new Option(v.label, String(i))),
    );
    if (p.variants) $("detailVariant").value = String(p.defaultVariant || 0);
    $("detailLoad").textContent =
      state.mode === "editor"
        ? T("Prepare to paste")
        : T("Load into monitor");
    $("detailCompute").checked = false;
    updatePatternDetail();
    closeDialog($("patternsDialog"));
    showDialog("patternDetailDialog");
  }
  $("detailVariant").onchange = updatePatternDetail;
  $("detailCompute").onchange = updatePatternDetail;
  $("detailBack").onclick = () => {
    closeDialog($("patternDetailDialog"));
    showDialog("patternsDialog");
  };
  $("patternDetailForm").onsubmit = safe(async (e) => {
    e.preventDefault();
    const p = selectedPatternCase();
    closeDialog($("patternDetailDialog"));
    await loadLibraryPattern(
      p,
      $("detailCompute").checked && !$("detailCompute").disabled,
    );
  });
  function fitPatternRegion({ x, y, width, height }) {
    state.view.zoom = Math.min(
      20,
      Math.min(
        (state.width - 100) / (width + 20),
        (state.height - 100) / (height + 20),
      ),
    );
    state.view.x = x + width / 2 - state.width / state.view.zoom / 2;
    state.view.y = y + height / 2 - state.height / state.view.zoom / 2;
    viewChanged();
  }
  async function readPatternOutput(p, status, placement) {
    const generation = patternTargetGeneration(p);
    const runId = status.run_id;
    while (state.mode === "monitor" && status.run_id === runId) {
      if (status.generation === generation) {
        if (state.status?.run_id && state.status.run_id !== runId) return;
        if (!hasLogicReadout(p)) {
          if (p.demo.view) {
            fitPatternRegion({
              ...p.demo.view,
              x: placement.x + p.demo.view.x,
              y: placement.y + p.demo.view.y,
            });
          }
          toast(T`${p.name} · Generation ${generation}. ${p.demo.observation}`);
          return;
        }
        const query = new URLSearchParams({
          ...p.verification.output_roi,
          scale: 1,
          generation,
          run_id: runId,
        });
        const snapshot = await api("/viewport?" + query);
        if (snapshot.run_id !== runId || snapshot.generation !== generation)
          throw Error(T("The output window changed before it could be read."));
        if (state.mode !== "monitor") return;
        const count = snapshot.counts.reduce((sum, cell) => sum + cell, 0);
        toast(
          T`${p.name} · Step ${generation}. Live cells measured in the output window: ${count}.`,
        );
        return;
      }
      if (status.error) throw Error(status.error);
      if (
        status.generation > generation ||
        (!status.running && !status.pending_steps)
      )
        throw Error(T("Computation stopped before the target generation."));
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (state.mode !== "monitor") return;
      status = await api("/status");
    }
  }
  async function loadLibraryPattern(p, compute = false) {
    if (state.busy) throw Error(T("Wait for the current operation to finish."));
    const mode = state.mode;
    const targetGeneration = patternTargetGeneration(p);
    const rle = await Catalog.getRLE(p);
    if (mode !== state.mode) return;
    let computation = null;
    let placement = null;
    if (mode === "monitor") {
      placement = Catalog.monitorPlacement(p, rle, world());
      state.busy = true;
      updateBusy();
      progress(T("Loading circuit onto server"), 0.15);
      try {
        // Send compact RLE directly; large devices never become million-entry
        // coordinate arrays in the browser's monitor or JSON request body.
        const loaded = await api("/import", {
          format: "rle",
          text: placement.text,
        });
        if (compute && targetGeneration !== null && state.mode === "monitor") {
          if (
            !loaded.run_id ||
            loaded.generation !== 0 ||
            loaded.running ||
            loaded.pending_steps
          )
            throw Error(T("Computation requires the initial circuit to be paused."));
          computation = await api("/control", {
            action: "step",
            steps: targetGeneration,
          });
          if (computation.run_id !== loaded.run_id)
            throw Error(T("The monitor's field changed before computation."));
        }
        await refreshNow();
      } finally {
        state.busy = false;
        updateBusy();
        doneProgress();
      }
      if (state.mode !== "monitor") return;
      fitPatternRegion(placement);
    } else {
      const result = await runWorker("rle", { text: rle });
      if (state.mode !== "editor") return;
      state.clipboard = {
        width: result.width,
        height: result.height,
        previewGrid: result.grid,
      };
      if (
        result.width > state.grid.width ||
        result.height > state.grid.height
      ) {
        expandEditor(
          Math.max(state.grid.width, result.width + 128),
          Math.max(state.grid.height, result.height + 128),
        );
        fitWorld();
      }
      startPaste();
    }
    if (computation) {
      toast(T`Computing to generation ${targetGeneration}…`);
      await readPatternOutput(p, computation, placement);
    } else {
      toast(p.name + " · " + p.note);
    }
  }
  function renderPatterns() {
    const q = $("patternSearch").value.trim().toLocaleLowerCase(I.locale()),
      list = $("patternList"),
      category = $("patternCategory").value;
    const categories = [...new Set(window.LIFE_PATTERNS.map((p) => p.type))];
    {
      $("patternCategory").replaceChildren(new Option(T("All categories"), ""));
      for (const type of categories)
        $("patternCategory").append(new Option(I.category(type), type));
      $("patternCategory").value = category;
    }
    const patterns = window.LIFE_PATTERNS.filter(
      (p) => (!category || p.type === category) && I.searchText(p).includes(q),
    );
    $("patternCount").textContent =
      T("Showing ") +
      patterns.length +
      T(" of ") +
      window.LIFE_PATTERNS.length +
      T(" patterns");
    $("clearPatternSearch").disabled = !q && !category;
    list.replaceChildren();
    if (!patterns.length) {
      const empty = document.createElement("p");
      empty.className = "no-patterns";
      empty.textContent = T(
        "No matches. Try another name or category.",
      );
      list.append(empty);
    }
    for (const original of patterns) {
      const p = I.pattern(original);
      const b = document.createElement("button");
      b.className = "pattern-card";
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 128;
      const text = document.createElement("div"),
        strong = document.createElement("strong"),
        note = document.createElement("small"),
        tag = document.createElement("span");
      strong.textContent = p.name;
      note.textContent = p.note;
      tag.textContent = p.type;
      tag.className = "tag";
      text.append(strong, note, tag);
      b.append(c, text);
      list.append(b);
      const cc = c.getContext("2d");
      cc.fillStyle = "#080e11";
      cc.fillRect(0, 0, 128, 128);
      if (p.asset === "clock") {
        cc.strokeStyle = "#91bca1";
        cc.lineWidth = 3;
        cc.strokeRect(19, 39, 90, 49);
        cc.fillStyle = "#badc9a";
        cc.font = "22px monospace";
        cc.fillText("12:00", 28, 71);
      } else if (p.preview) {
        const { width, height, levels } = p.preview;
        const z = 112 / Math.max(width, height),
          ox = (128 - width * z) / 2,
          oy = (128 - height * z) / 2;
        for (let i = 0; i < levels.length; i++) {
          const n = parseInt(levels[i], 16);
          if (!n) continue;
          cc.fillStyle = `rgb(${60 + 11 * n},${72 + 11 * n},${70 + 10 * n})`;
          cc.fillRect(
            ox + (i % width) * z,
            oy + Math.floor(i / width) * z,
            Math.ceil(z),
            Math.ceil(z),
          );
        }
      } else
        try {
          const data = C.parseRLE(p.rle),
            z = Math.min(11, 108 / Math.max(data.width, data.height)),
            ox = (128 - data.width * z) / 2,
            oy = (128 - data.height * z) / 2;
          cc.fillStyle = "#d5e7d0";
          for (const [x, y] of data.grid.cells())
            cc.fillRect(
              ox + x * z,
              oy + y * z,
              Math.max(1, z - 0.8),
              Math.max(1, z - 0.8),
            );
        } catch {}
      b.onclick = safe(async () => {
        if (p.variants || (p.asset && p.asset !== "clock")) {
          openPatternDetail(original);
          return;
        }
        closeDialog($("patternsDialog"));
        await loadLibraryPattern(p);
      });
    }
  }
  $("patternSearch").oninput = renderPatterns;
  $("patternCategory").onchange = renderPatterns;
  $("clearPatternSearch").onclick = () => {
    $("patternSearch").value = "";
    $("patternCategory").value = "";
    renderPatterns();
    $("patternSearch").focus();
  };

  function renderInfo() {
    const w = world(),
      status = state.connected ? state.status : null,
      stats = status?.tiles || {},
      effective = status?.effective_engine || {},
      cycles = status?.cycles;
    const scale =
      state.mode === "monitor"
        ? state.viewport?.scale || viewportSpec().scale
        : viewportSpec().scale;
    const currentLevel = Math.max(0, Math.round(Math.log2(scale))),
      aggregateLevels = Math.min(
        30,
        Math.max(0, Math.ceil(Math.log2(Math.max(w.width, w.height)))),
      );
    const number = (value) =>
      value === undefined || value === null ? "—" : fmt(value);
    const bytes = (value) =>
      value === undefined || value === null
        ? "—"
        : decimal(Number(value) / 1048576, 1) + T(" MiB");
    const tile = effective.tile_size ?? stats.tile_size;
    const root = $("infoContent");
    root.replaceChildren();
    const overview = document.createElement("div");
    overview.className = "layer-overview";
    for (const [value, title, note] of [
      [
        "1",
        T("Computation layer"),
        T(
          "The engine processes clusters of a single size. This version has one computational layer.",
        ),
      ],
      [
        String(aggregateLevels),
        T("Overview detail levels"),
        aggregateLevels
          ? T("Blocks from 2 × 2 to ") +
            number(2 ** aggregateLevels) +
            " × " +
            number(2 ** aggregateLevels) +
            T(". Level 0 shows exact cells.")
          : T("A one-cell field needs only level 0: the exact state."),
      ],
    ]) {
      const card = document.createElement("article"),
        strong = document.createElement("strong"),
        heading = document.createElement("h3"),
        p = document.createElement("p");
      strong.textContent = value;
      heading.textContent = title;
      p.textContent = note;
      card.append(strong, heading, p);
      overview.append(card);
    }
    root.append(overview);
    const detail = document.createElement("p");
    detail.className = "info-detail";
    detail.textContent =
      T("Current display level: ") +
      currentLevel +
      (currentLevel
        ? T(" · one block = ") +
          number(scale) +
          " × " +
          number(scale) +
          T(" cells.")
        : T(" · one cell = one exact state.")) +
      T(" Overview colors do not affect the rules of Life.");
    root.append(detail);
    const rows = [
      [
        T("Computation cluster"),
        tile ? number(tile) + " × " + number(tile) : T("Server disconnected"),
      ],
      [T("Offline editor tile"), T("64 × 64 cells")],
      [T("Effective CPU threads"), number(effective.threads ?? stats.threads)],
      [
        T("Native engine memory budget"),
        bytes(effective.memory_bytes ?? stats.memory_budget_bytes),
      ],
      [T("Server process memory (RSS)"), bytes(status?.resources?.rss_bytes)],
      [T("Nonempty clusters"), number(stats.nonempty_tiles)],
      [T("Candidates on last step"), number(stats.candidate_tiles)],
      [T("Computed on last step"), number(stats.computed_tiles)],
      [T("Cached results reused"), number(stats.cache_hits)],
      [T("Empty clusters skipped"), number(stats.skipped_empty_tiles)],
      [T("Unchanged on last step"), number(stats.unchanged_tiles)],
      [T("Cache history: repeats after 2 steps"), number(stats.period2_tiles)],
      [T("Cache history: longer repeats"), number(stats.higher_period_tiles)],
      [T("Cache history: longest repeat"), number(stats.max_observed_period)],
      [T("Registered cycle guards"), number(cycles?.watched_clusters)],
      [
        T("Stored phases replayed on last step"),
        number(cycles?.last_replays),
      ],
      [
        T("Returned to computation on last step"),
        number(cycles?.last_wakes),
      ],
      [
        T("Candidates stored for detection"),
        number(cycles?.candidate_captures),
      ],
      [T("Candidate checks"), number(cycles?.probes)],
      [T("Cycle detection memory"), bytes(cycles?.bytes)],
      [T("Effective detection budget"), bytes(cycles?.budget_bytes)],
      [T("Start detection at generation"), number(cycles?.start_generation)],
      [T("Maximum search period"), number(cycles?.max_period)],
      [
        T("Interval between new checks"),
        cycles?.detection_interval === undefined
          ? "—"
          : number(cycles.detection_interval) + T(" steps"),
      ],
    ];
    const table = document.createElement("dl");
    table.className = "info-stats";
    for (const [label, value] of rows) {
      const dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      table.append(dt, dd);
    }
    root.append(table);
    const cycleNote = document.createElement("p");
    cycleNote.className = "info-detail";
    cycleNote.textContent = !cycles?.supported
      ? T("The connected engine does not support cycle guards.")
      : !cycles.enabled
        ? T(
            "Cycle detection is disabled. The heatmap marks unverified periods as unknown.",
          )
        : Number(status.generation) < Number(cycles.start_generation)
          ? T("Delayed detection: until generation ") +
            number(cycles.start_generation) +
            T(" remaining: ") +
            number(cycles.start_generation - status.generation) +
            T(
              " steps. Red currently indicates an unknown period, not proven chaotic behavior.",
            )
          : T(
              "Before replaying a stored phase, the guard checks the exact cluster state and the outer row of cells. A mismatch resumes ordinary B3/S23 computation.",
            );
    root.append(cycleNote);
    const heatNote = document.createElement("p");
    heatNote.className = "dialog-copy";
    heatNote.textContent = T(
      "The heatmap shows qualitative activity rather than Shannon entropy. A currently verified period of 1 is cold; longer verified cycles are warmer on a fixed log₂(period) / 6 scale up to period 64. Without valid verification, a region is hotter. Density raises the temperature of both cyclic and unknown regions; empty areas are always black. Zoomed-out views blend the live-cell-weighted mean with the maximum to preserve small hot spots. The scale is fixed across frames.",
    );
    root.append(heatNote);
    const note = document.createElement("p");
    note.className = "dialog-copy";
    note.textContent = status
      ? T("Server statistics: last completed generation ") +
        number(status.generation) +
        T(
          ". Cache history counters describe past observations, not the number of current guards. An unchanged step does not imply permanent freezing: changes in neighboring cells can reactivate the cluster.",
        )
      : T(
          "The server is disconnected, so its actual resources and statistics are unavailable. Display levels are calculated for the current editor field.",
        );
    root.append(note);
  }
  $("infoButton").onclick = () => {
    renderInfo();
    showDialog("infoDialog");
  };

  let configEditor = null,
    configHasServer = false;
  function ensureConfigEditor() {
    if (!configEditor)
      configEditor = window.LifeConfig.createEditor($("configEditor"), {
        onChange: updateConfigSummary,
      });
    return configEditor;
  }
  function showSettingsFeedback(message, error = false) {
    const target = $("settingsFeedback");
    target.hidden = !message;
    target.classList.toggle("error", error);
    target.setAttribute("role", error ? "alert" : "status");
    if (target.textContent !== message) target.textContent = message;
  }
  function updateConfigSummary(message = "") {
    if (!configEditor) return;
    const target = $("configSummary");
    target.replaceChildren();
    if (message) {
      const p = document.createElement("p");
      p.textContent = message;
      target.append(p);
    }
    try {
      const plan = configEditor.plan(),
        summary = document.createElement("p");
      summary.textContent = plan.changes.length
        ? T("Without restart: ") +
          plan.liveChanges.length +
          T(". On next startup: ") +
          plan.restartChanges.length +
          "."
        : T("All fields match the loaded configuration.");
      target.append(summary);
      if (state.activeSettings === "backend")
        showSettingsFeedback(
          message ||
            (plan.changes.length
              ? summary.textContent +
                (plan.restartChanges.length
                  ? T(" Download config.toml for startup changes.")
                  : "")
              : T("No changes to apply.")),
        );
      if (plan.restartChanges.length) {
        const pending = document.createElement("p");
        pending.className = "restart-pending";
        pending.textContent =
          T("Require config.toml and a restart: ") +
          plan.restartChanges.map((c) => c.label).join(", ") +
          T(
            ". These values will stay in the draft after other changes are applied.",
          );
        target.append(pending);
      }
      if (!state.connected) {
        const p = document.createElement("p");
        p.textContent = T(
          "Offline mode: prepare and download the configuration. Applying it to a server is unavailable.",
        );
        target.append(p);
      }
    } catch {
      const p = document.createElement("p");
      p.textContent = T(
        "Some values are incomplete or invalid. Check the fields before applying.",
      );
      target.append(p);
      if (state.activeSettings === "backend")
        showSettingsFeedback(p.textContent, true);
    }
  }
  async function fetchServerConfig(reset = false) {
    ensureConfigEditor();
    let changed = false;
    try {
      changed = configEditor.plan().changes.length > 0;
    } catch {
      changed = true;
    }
    const config = await api("/config");
    state.backendConfig = config;
    if (reset || !changed) configEditor.load(config);
    else configEditor.rebase(config);
    configHasServer = true;
    updateConfigSummary(
      reset ? T("Draft replaced with the current server settings.") : "",
    );
  }
  function settingsTab(name) {
    state.activeSettings = name;
    document
      .querySelectorAll("[data-settings-tab]")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.settingsTab === name),
      );
    $("displaySettings").hidden = name !== "display";
    $("backendSettings").hidden = name !== "backend";
    $("settingsDownloadShortcut").hidden = name !== "backend";
    if (name === "backend") updateConfigSummary();
    else showSettingsFeedback("");
    $("applySettingsButton").textContent =
      name === "backend"
        ? T("Apply without restart")
        : T("Save display settings");
  }
  $("settingsButton").onclick = safe(async () => {
    const f = $("settingsForm");
    for (const key of [
      "levels",
      "bias",
      "gain",
      "upperGain",
      "cacheMB",
      "undoMB",
      ...Object.keys(C.HEAT_DEFAULTS),
    ])
      f.elements[key].value = settings[key];
    f.elements.grid.checked = settings.grid;
    ensureConfigEditor();
    $("accessToken").value = accessToken;
    settingsTab(state.activeSettings);
    if (state.activeSettings === "backend") updateConfigSummary();
    showDialog("settingsDialog");
    if (state.connected && !configHasServer) await fetchServerConfig();
  });
  document
    .querySelectorAll("[data-settings-tab]")
    .forEach((b) => (b.onclick = () => settingsTab(b.dataset.settingsTab)));
  $("connectToken").onclick = safe(async () => {
    accessToken = $("accessToken").value.trim();
    try {
      if (accessToken) sessionStorage.setItem("life-access-token", accessToken);
      else sessionStorage.removeItem("life-access-token");
    } catch {}
    state.status = await api("/status");
    setConnection(true);
    await fetchServerConfig();
    toast(T("Server access confirmed."));
  });
  $("reloadConfig").onclick = safe(async () => {
    if (state.connected) await fetchServerConfig(true);
    else {
      ensureConfigEditor().load(window.LifeConfig.DEFAULTS);
      updateConfigSummary(
        T("Defaults restored for offline configuration."),
      );
    }
  });
  $("settingsDownloadShortcut").onclick = () => $("downloadConfig").click();
  $("downloadConfig").onclick = safe(() => {
    const { config, errors } = ensureConfigEditor().validate({ focus: true });
    if (errors.length) {
      updateConfigSummary(
        T("Correct the highlighted fields to export a valid startup file."),
      );
      throw Error(errors[0].message);
    }
    download(
      window.LifeConfig.toTOML(config),
      "config.toml",
      "application/toml",
    );
    updateConfigSummary(
      T(
        "Full config.toml downloaded. The config does not contain live cells: save the state separately. Start the server with this file to apply startup settings.",
      ),
    );
  });
  $("settingsForm").onsubmit = safe(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (state.activeSettings === "backend") {
      if (!state.connected)
        throw Error(
          T(
            "Server disconnected. Download config.toml for the next startup.",
          ),
        );
      const editor = ensureConfigEditor(),
        { config, errors } = editor.validate({ focus: false }),
        baseline = editor.baseline;
      const blocking = errors.filter(
        (error) =>
          !(
            error.path === "initial.rectangle" &&
            JSON.stringify(config.initial.rectangle) ===
              JSON.stringify(baseline.initial.rectangle) &&
            config.grid.width === baseline.grid.width &&
            config.grid.height === baseline.grid.height
          ),
      );
      if (blocking.length) {
        editor.validate({ focus: true });
        updateConfigSummary(T("Not applied: correct the highlighted values."));
        throw Error(blocking[0].message);
      }
      const plan = editor.plan();
      if (!plan.liveChanges.length) {
        updateConfigSummary(
          plan.restartChanges.length
            ? T(
                "These changes apply only at startup. Download the full config.toml; the draft has been preserved.",
              )
            : T("No changes to apply."),
        );
        return;
      }
      const result = await api("/config", plan.livePatch, "PUT");
      state.backendConfig = result;
      editor.rebase(result);
      if (
        plan.liveChanges.some((change) =>
          change.path.startsWith("engine.cycles_"),
        )
      ) {
        state.requestSerial++;
        state.viewport = null;
        state.cache.clear();
        state.cacheBytes = 0;
        state.status = await api("/status");
        updateRun();
        updateStats();
        if (state.mode === "monitor") requestViewport();
      }
      if (
        plan.liveChanges.some((change) => change.path.startsWith("display."))
      ) {
        applyServerDisplay(result.display);
        try {
          localStorage.setItem(
            "life-display-settings",
            JSON.stringify(settings),
          );
        } catch {}
      }
      updateConfigSummary(
        T("Applied without restart: ") +
          plan.liveChanges.length +
          ". " +
          (plan.restartChanges.length
            ? T(
                "Startup changes remain in the draft — download config.toml.",
              )
            : T("Also download config.toml to persist these settings.")) +
          (errors.length
            ? T(
                " Before exporting, correct the randomization area that exceeds the current field.",
              )
            : ""),
      );
      toast(T("Current server settings updated."));
    } else {
      const ranges = {
        levels: [2, 256, true],
        bias: [0, 1],
        gain: [0, 1000],
        upperGain: [0, 1000],
        cacheMB: [1, 1024, true],
        undoMB: [1, 256, true],
        ...Object.fromEntries(
          Object.keys(C.HEAT_DEFAULTS).map((key) => [key, [0, 1]]),
        ),
      };
      const displayDraft = {};
      for (const [key, [min, max, integer]] of Object.entries(ranges)) {
        const input = f.elements[key],
          value = Number(input.value);
        if (
          !input.value.trim() ||
          !Number.isFinite(value) ||
          value < min ||
          value > max ||
          (integer && !Number.isInteger(value))
        ) {
          input.focus();
          throw Error(
            T("Check the value of “") +
              input.closest("label").childNodes[0].textContent.trim() +
              "».",
          );
        }
        displayDraft[key] = value;
      }
      const heatConfig = window.LifeConfig.normalizeConfig();
      for (const key of Object.keys(C.HEAT_DEFAULTS))
        heatConfig.display[key] = displayDraft[key];
      const heatErrors = window.LifeConfig.validateConfig(heatConfig).filter(
        (error) => error.path.startsWith("display.heat_"),
      );
      if (heatErrors.length) {
        const name = heatErrors[0].path.slice(8);
        f.elements[name]?.focus();
        throw Error(heatErrors[0].message);
      }
      displayDraft.grid = f.elements.grid.checked;
      Object.assign(settings, displayDraft);
      try {
        localStorage.setItem("life-display-settings", JSON.stringify(settings));
      } catch {}
      scheduleRender();
      toast(T("Display settings saved."));
      closeDialog($("settingsDialog"));
    }
  });
  document.addEventListener(
    "keydown",
    safe((e) => {
      if (
        e.target.matches("input,textarea,select") ||
        document.querySelector("dialog[open]")
      )
        return;
      const k = e.key.toLowerCase(),
        ctrl = e.ctrlKey || e.metaKey;
      if (e.code === "Space") {
        e.preventDefault();
        state.space = true;
        scheduleRender();
        return;
      }
      if (k === "escape") {
        state.paste = null;
        state.selection = null;
        syncPaste();
        updateStats();
        scheduleRender();
        return;
      }
      if (k === "f") {
        e.preventDefault();
        fitWorld();
        return;
      }
      if (state.mode !== "editor" || state.busy) return;
      if (ctrl) {
        if (["z", "y", "c", "x", "v"].includes(k)) e.preventDefault();
        if (k === "z") undo(e.shiftKey);
        if (k === "y") undo(true);
        if (k === "c") copySelection();
        if (k === "x") copySelection(true);
        if (k === "v") startPaste();
        return;
      }
      const tools = {
        b: "draw",
        e: "erase",
        h: "pan",
        s: "select",
        l: "line",
        r: "rect",
      };
      if (tools[k]) selectTool(tools[k]);
      if (k === "delete" || k === "backspace") {
        e.preventDefault();
        clearSelection();
      }
    }),
  );
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      state.space = false;
      scheduleRender();
    }
  });
  window.addEventListener("blur", () => {
    state.space = false;
    pointerEnd();
  });
  // Native clipboard RLE is imported only when there is no internal clipboard.
  document.addEventListener(
    "paste",
    safe(async (e) => {
      if (
        state.mode !== "editor" ||
        e.target.matches("input,textarea") ||
        state.clipboard
      )
        return;
      const text = e.clipboardData?.getData("text/plain");
      if (text && /^\s*(#|x\s*=)/.test(text)) {
        e.preventDefault();
        await importText(text, "rle");
      }
    }),
  );
  window.LifeApp = {
    state,
    settings,
    render,
    fitWorld,
    importText,
    setMode,
    requestViewport,
    renderInfo,
    setLayer,
    ensureConfigEditor,
  };
  function refreshLanguage() {
    refreshModeLabels();
    setConnection(state.connected);
    updateStats();
    updateRun();
    refreshToolHint();
    renderPatterns();
    if (detailPattern) updatePatternDetail();
    configEditor?.refreshLocale();
    if (configEditor) updateConfigSummary();
    $("applySettingsButton").textContent =
      state.activeSettings === "backend"
        ? T("Apply without restart")
        : T("Save display settings");
    if ($("randomDialog").open) updateRandomRoute();
    const speedIndex = Number($("speed").value);
    $("speedValue").textContent =
      speedIndex === 10
        ? T("Maximum")
        : fmt([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000][speedIndex]) +
          T(" steps/s");
    if (state.cursor)
      $("cursorPosition").textContent =
        T("Cursor ") + (state.cursor.x + 1) + "." + (state.cursor.y + 1);
    setStatus(
      state.mode === "editor" ? T("Offline editor") : T("Monitor"),
    );
    scheduleRender();
  }
  $("languageSelect").addEventListener("change", (event) =>
    I.setLanguage(event.target.value),
  );
  window.addEventListener("life:languagechange", refreshLanguage);
  refreshModeLabels();
  resize();
  updateStats();
  updateRun();
  if (location.protocol === "file:") {
    setConnection(false);
    state.initialFit = true;
    setMode("editor");
    setTimeout(() => showDialog("newDialog"), 150);
  } else poll();
})();
