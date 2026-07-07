"use strict";
// Rendering + UI. Depends on engine.js (window.CA).

(() => {
  // ---------------------------------------------------------------------------
  // Palettes
  // ---------------------------------------------------------------------------

  const PALETTES = [
    { id: "neon",   name: "Neon",      bg: "#070a12", colors: ["#00f5d4", "#00bbf9", "#9b5de5", "#f15bb5", "#fee440"] },
    { id: "ember",  name: "Ember",     bg: "#0c0503", colors: ["#fff3b0", "#ffd000", "#ff9e00", "#ff5400", "#9d0208"] },
    { id: "aurora", name: "Aurora",    bg: "#03070d", colors: ["#b9fbc0", "#98f5e1", "#8eecf5", "#90dbf4", "#a3c4f3", "#cfbaf0"] },
    { id: "ocean",  name: "Ocean",     bg: "#02090f", colors: ["#caf0f8", "#90e0ef", "#00b4d8", "#0077b6", "#023e8a"] },
    { id: "sakura", name: "Sakura",    bg: "#140811", colors: ["#ffe5ec", "#ffb3c6", "#ff8fab", "#fb6f92", "#c9184a"] },
    { id: "synth",  name: "Synthwave", bg: "#0d0221", colors: ["#f9f871", "#ff9e64", "#ff4d97", "#b967ff", "#01cdfe"] },
    { id: "paper",  name: "Paper",     bg: "#f2ecdf", colors: ["#211d16", "#5f5648", "#a2591f", "#265c4b", "#7a1f2b"] },
    { id: "mono",   name: "Mono",      bg: "#000000", colors: ["#ffffff", "#c8c8c8", "#8a8a8a", "#4d4d4d"] },
  ];

  // ---------------------------------------------------------------------------
  // Color helpers — Uint32 pixels are little-endian ABGR.
  // ---------------------------------------------------------------------------

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function pack(c) {
    return ((255 << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0;
  }
  function mix(a, b, t) {
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t),
    };
  }
  // Multi-stop gradient sample. t in [0,1]; cyclic wraps back to the start.
  function sample(colors, t, cyclic) {
    const n = colors.length;
    if (n === 1) return colors[0];
    let f = cyclic ? ((t % 1) + 1) % 1 * n : Math.min(Math.max(t, 0), 1) * (n - 1);
    const i = Math.min(Math.floor(f), cyclic ? n - 1 : n - 2);
    return mix(colors[i], colors[(i + 1) % n], f - i);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const S = {
    dim: 2,
    rule: CA.parse2D("B3/S23"),
    lastRule1: CA.parse1D("110"),
    palette: PALETTES[0],
    colorMode: "age", // 'state' | 'age' | 'flow'
    cell: 4,
    speed: 24,          // steps per second
    running: true,
    density2d: 0.28,
    density1d: 0.35,
    seedMode1d: "single",
    trail: 0.9,         // heat retained per step; 0 = off
    gen: 0,
  };

  // Grid + buffers (2D: W*H, 1D: W)
  let W = 0, H = 0;
  let grid, next, age, birth, heat, wrap;
  let cur1d, next1d, age1d;

  // Canvases
  const view = document.getElementById("view");
  const vctx = view.getContext("2d");
  let off, octx, scratch, sctx; // logical-resolution offscreen + scroll scratch (1D)
  let img, px32;                // full-frame ImageData for 2D
  let dirty = true;
  let pendingRows = [];         // 1D rows stepped since last frame

  // Color LUTs
  let bg32, stateLUT, ageLUT, flowLUT, trailLUT;

  function buildLUTs() {
    const P = S.palette;
    const bg = hexToRgb(P.bg);
    const cols = P.colors.map(hexToRgb);
    bg32 = pack(bg);

    const C = S.rule.states;
    stateLUT = new Uint32Array(Math.max(C, 2));
    stateLUT[0] = bg32;
    stateLUT[1] = pack(cols[0]);
    if (S.rule.dim === 1 && S.rule.family === "totalistic") {
      for (let v = 1; v < C; v++) stateLUT[v] = pack(cols[(v - 1) % cols.length]);
    } else {
      for (let v = 2; v < C; v++) {
        const t = (v - 1) / (C - 1);
        stateLUT[v] = pack(mix(sample(cols, Math.min(1, (v - 1) / Math.max(1, C - 2))), bg, 0.15 + 0.6 * t));
      }
    }

    ageLUT = new Uint32Array(64);
    for (let i = 0; i < 64; i++) ageLUT[i] = pack(sample(cols, i / 63));

    flowLUT = new Uint32Array(256);
    for (let i = 0; i < 256; i++) flowLUT[i] = pack(sample(cols, i / 256, true));

    trailLUT = new Uint32Array(256);
    for (let i = 0; i < 256; i++)
      trailLUT[i] = pack(mix(bg, cols[0], Math.pow(i / 255, 1.6) * 0.45));

    document.body.style.background = P.bg;
    document.documentElement.style.setProperty("--accent", P.colors[0]);
  }

  // ---------------------------------------------------------------------------
  // Sizing / (re)allocation
  // ---------------------------------------------------------------------------

  const MAX_CELLS = 700000; // perf guard for tiny cell sizes on huge screens

  function setup(reseed) {
    const vw = window.innerWidth, vh = window.innerHeight;
    let cell = S.cell;
    while ((Math.ceil(vw / cell) * Math.ceil(vh / cell)) > MAX_CELLS) cell++;
    W = Math.ceil(vw / cell);
    H = Math.ceil(vh / cell);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.width = Math.round(vw * dpr);
    view.height = Math.round(vh * dpr);
    view.style.width = vw + "px";
    view.style.height = vh + "px";
    vctx.imageSmoothingEnabled = false;
    S.drawScale = cell * dpr;

    off = document.createElement("canvas");
    off.width = W; off.height = H;
    octx = off.getContext("2d");
    scratch = document.createElement("canvas");
    scratch.width = W; scratch.height = H;
    sctx = scratch.getContext("2d");

    if (S.dim === 2) {
      img = octx.createImageData(W, H);
      px32 = new Uint32Array(img.data.buffer);
      grid = new Uint8Array(W * H);
      next = new Uint8Array(W * H);
      age = new Uint16Array(W * H);
      birth = new Uint16Array(W * H);
      heat = new Uint8Array(W * H);
      wrap = CA.wrapIndices(W);
      if (reseed) seed2D();
    } else {
      cur1d = new Uint8Array(W);
      next1d = new Uint8Array(W);
      age1d = new Uint16Array(W);
      pendingRows = [];
      octx.fillStyle = S.palette.bg;
      octx.fillRect(0, 0, W, H);
      if (reseed) seed1D();
    }
    S.gen = 0;
    dirty = true;
  }

  function seed2D() {
    grid.fill(0); age.fill(0); birth.fill(0); heat.fill(0);
    for (let i = 0; i < grid.length; i++)
      if (Math.random() < S.density2d) { grid[i] = 1; heat[i] = 255; }
    S.gen = 0;
    dirty = true;
  }

  function clear2D() {
    grid.fill(0); age.fill(0); birth.fill(0); heat.fill(0);
    dirty = true;
  }

  function seed1D() {
    cur1d = CA.seedRow(W, S.seedMode1d, S.density1d, S.rule.states);
    age1d.fill(0);
    octx.fillStyle = S.palette.bg;
    octx.fillRect(0, 0, W, H);
    pendingRows = [cur1d.slice()];
    S.gen = 0;
    dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Stepping
  // ---------------------------------------------------------------------------

  function stepOnce() {
    S.gen++;
    if (S.dim === 2) {
      CA.step2D(S.rule, grid, next, W, H, wrap.xm, wrap.xp);
      const old = grid; grid = next; next = old;
      const fadeK = S.trail > 0 ? Math.round(S.trail * 256) : 0;
      const g = S.gen & 0xffff;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === 1) {
          if (old[i] !== 1) { birth[i] = g; age[i] = 0; } else if (age[i] < 65535) age[i]++;
          heat[i] = 255;
        } else {
          age[i] = 0;
          if (heat[i]) heat[i] = (heat[i] * fadeK) >> 8;
        }
      }
      dirty = true;
    } else {
      CA.step1D(S.rule, cur1d, next1d);
      const old = cur1d; cur1d = next1d; next1d = old;
      for (let x = 0; x < W; x++) age1d[x] = cur1d[x] ? Math.min(age1d[x] + 1, 65535) : 0;
      pendingRows.push(cur1d.slice());
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render2D() {
    const mode = S.colorMode;
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (v === 0) {
        px32[i] = heat[i] > 5 ? trailLUT[heat[i]] : bg32;
      } else if (v === 1) {
        px32[i] =
          mode === "age" ? ageLUT[age[i] > 63 ? 63 : age[i]] :
          mode === "flow" ? flowLUT[birth[i] & 255] :
          stateLUT[1];
      } else {
        px32[i] = stateLUT[v];
      }
    }
    octx.putImageData(img, 0, 0);
  }

  function rowColor(x, v, gen) {
    if (v === 0) return bg32;
    if (S.colorMode === "flow" && v === 1) return flowLUT[gen & 255];
    if (S.colorMode === "age" && v === 1) {
      const a = age1d[x];
      return ageLUT[a > 63 ? 63 : a];
    }
    return stateLUT[v];
  }

  function flush1D() {
    const n = pendingRows.length;
    if (!n) return;
    if (n < H) {
      sctx.clearRect(0, 0, W, H);
      sctx.drawImage(off, 0, 0);
      octx.fillStyle = S.palette.bg;
      octx.fillRect(0, 0, W, H);
      octx.drawImage(scratch, 0, -n);
    } else {
      octx.fillStyle = S.palette.bg;
      octx.fillRect(0, 0, W, H);
    }
    const rows = Math.min(n, H);
    const block = octx.createImageData(W, rows);
    const p = new Uint32Array(block.data.buffer);
    const baseGen = S.gen - rows + 1;
    for (let r = 0; r < rows; r++) {
      const row = pendingRows[n - rows + r];
      for (let x = 0; x < W; x++) p[r * W + x] = rowColor(x, row[x], baseGen + r);
    }
    octx.putImageData(block, 0, H - rows);
    pendingRows = [];
    dirty = true;
  }

  function blit() {
    vctx.fillStyle = S.palette.bg;
    vctx.fillRect(0, 0, view.width, view.height);
    vctx.drawImage(off, 0, 0, W, H, 0, 0, W * S.drawScale, H * S.drawScale);
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  let acc = 0, lastT = 0, frames = 0, fpsT = 0, fps = 60;

  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min((t - lastT) / 1000, 0.25);
    lastT = t;
    frames++;
    if (t - fpsT > 1000) { fps = frames; frames = 0; fpsT = t; updateHud(); }

    if (S.running) {
      acc += dt * S.speed;
      let n = Math.floor(acc);
      if (n > 16) { n = 16; acc = 0; } else acc -= n;
      for (let i = 0; i < n; i++) stepOnce();
    }
    if (S.dim === 1) flush1D();
    if (dirty) {
      if (S.dim === 2) render2D();
      blit();
      dirty = false;
    }
  }

  // ---------------------------------------------------------------------------
  // HUD / toast
  // ---------------------------------------------------------------------------

  const hud = document.getElementById("hud");
  function updateHud() {
    hud.textContent = S.rule.canonical + " · gen " + S.gen.toLocaleString() + " · " + fps + " fps";
  }

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  // ---------------------------------------------------------------------------
  // URL hash (shareable settings)
  // ---------------------------------------------------------------------------

  function writeHash() {
    const p = new URLSearchParams({
      d: S.dim, r: S.rule.canonical, p: S.palette.id, m: S.colorMode,
      c: S.cell, v: Math.round(S.speed),
      n: Math.round((S.dim === 2 ? S.density2d : S.density1d) * 100),
      t: Math.round(S.trail * 100), s: S.seedMode1d,
    });
    history.replaceState(null, "", "#" + p.toString());
  }

  function readHash() {
    if (!location.hash) return;
    const p = new URLSearchParams(location.hash.slice(1));
    const d = Number(p.get("d"));
    if (d === 1 || d === 2) S.dim = d;
    const pal = PALETTES.find((x) => x.id === p.get("p"));
    if (pal) S.palette = pal;
    if (["state", "age", "flow"].includes(p.get("m"))) S.colorMode = p.get("m");
    const c = Number(p.get("c"));
    if ([2, 3, 4, 6, 8].includes(c)) S.cell = c;
    const v = Number(p.get("v"));
    if (v >= 1 && v <= 240) S.speed = v;
    const n = Number(p.get("n"));
    if (n >= 1 && n <= 90) { S.density2d = n / 100; S.density1d = n / 100; }
    const t = p.get("t") === null ? NaN : Number(p.get("t"));
    if (t >= 0 && t <= 97) S.trail = t / 100;
    if (["single", "random"].includes(p.get("s"))) S.seedMode1d = p.get("s");
    const r = p.get("r");
    if (r) {
      const parsed = CA.parseRule(r, S.dim);
      if (parsed.ok) S.rule = parsed;
    }
    if (S.dim === 1 && S.rule.dim !== 1) S.rule = CA.parse1D("110");
    if (S.dim === 2 && S.rule.dim !== 2) S.rule = CA.parse2D("B3/S23");
    if (S.dim === 1) S.lastRule1 = S.rule; else S.lastRule2 = S.rule;
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const famousSel = $("famous");
  const ruleInput = $("rule-input");
  const ruleError = $("rule-error");
  const ruleDesc = $("rule-desc");

  function famousList() {
    return S.dim === 1 ? CA.FAMOUS_1D : CA.FAMOUS_2D;
  }

  function fillFamous() {
    famousSel.innerHTML = "";
    for (const f of famousList()) {
      const o = document.createElement("option");
      o.value = f.s;
      o.textContent = f.name;
      famousSel.appendChild(o);
    }
    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = "custom…";
    famousSel.appendChild(custom);
    syncRuleUI();
  }

  function syncRuleUI() {
    ruleInput.value = S.rule.canonical;
    ruleError.textContent = "";
    const f = famousList().find(
      (x) => CA.parseRule(x.s, S.dim).canonical === S.rule.canonical
    );
    famousSel.value = f ? f.s : "";
    ruleDesc.textContent = f ? f.desc : S.rule.label;
    updateHud();
  }

  function applyRule(str, opts) {
    const parsed = CA.parseRule(str, S.dim);
    if (!parsed.ok) {
      ruleError.textContent = parsed.error;
      return false;
    }
    S.rule = parsed;
    if (S.dim === 1) S.lastRule1 = parsed;
    buildLUTs();
    if (S.dim === 2) {
      // Clamp cells that exceed the new rule's state count.
      for (let i = 0; i < grid.length; i++) if (grid[i] >= parsed.states) grid[i] = 1;
      // A near-empty grid gives a new rule nothing to chew on.
      if ((opts || {}).reseedIfSparse) {
        let alive = 0;
        for (let i = 0; i < grid.length; i++) if (grid[i]) alive++;
        if (alive / grid.length < 0.005) seed2D();
      }
    } else {
      for (let x = 0; x < W; x++) if (cur1d[x] >= parsed.states) cur1d[x] = 1;
      // Give a dead row a fresh start so the new rule visibly kicks in.
      let alive = 0;
      for (let x = 0; x < W; x++) if (cur1d[x]) alive++;
      if (alive === 0) cur1d = CA.seedRow(W, S.seedMode1d, S.density1d, parsed.states);
    }
    dirty = true;
    syncRuleUI();
    writeHash();
    return true;
  }

  function randomRule() {
    const r = CA.randomRule(S.dim, {
      seedMode: S.seedMode1d,
      density: S.dim === 2 ? S.density2d : S.density1d,
    });
    if (r && r.ok) {
      applyRule(r.canonical, { reseedIfSparse: true });
      toast("🎲 " + r.label);
    }
  }

  function setDim(d) {
    if (S.dim === d) return;
    if (S.dim === 1) S.lastRule1 = S.rule; else S.lastRule2 = S.rule;
    S.dim = d;
    S.rule = d === 1
      ? (S.lastRule1 || CA.parse1D("110"))
      : (S.lastRule2 || CA.parse2D("B3/S23"));
    document.body.classList.toggle("dim1", d === 1);
    $("mode-1d").classList.toggle("active", d === 1);
    $("mode-2d").classList.toggle("active", d === 2);
    buildLUTs();
    setup(true);
    fillFamous();
    syncControlsFromState();
    writeHash();
  }

  function setPalette(pal) {
    S.palette = pal;
    buildLUTs();
    if (S.dim === 1) {
      // keep drawn history; just repaint the display background
    }
    dirty = true;
    document.querySelectorAll(".swatch").forEach((b) =>
      b.classList.toggle("active", b.dataset.id === pal.id)
    );
    writeHash();
  }

  function fillPalettes() {
    const box = $("palettes");
    for (const pal of PALETTES) {
      const b = document.createElement("button");
      b.className = "swatch" + (pal.id === S.palette.id ? " active" : "");
      b.dataset.id = pal.id;
      b.title = pal.name;
      b.style.background =
        "linear-gradient(135deg," + pal.colors.join(",") + ")";
      b.addEventListener("click", () => setPalette(pal));
      box.appendChild(b);
    }
  }

  function setRunning(run) {
    S.running = run;
    $("play-icon").style.display = run ? "none" : "";
    $("pause-icon").style.display = run ? "" : "none";
  }

  function reseed() {
    if (S.dim === 2) seed2D(); else seed1D();
    writeHash();
  }

  // ---- wire up ----

  function bind() {
    $("mode-1d").addEventListener("click", () => setDim(1));
    $("mode-2d").addEventListener("click", () => setDim(2));

    famousSel.addEventListener("change", () => {
      if (famousSel.value) applyRule(famousSel.value, { reseedIfSparse: true });
    });
    $("rule-apply").addEventListener("click", () => applyRule(ruleInput.value, { reseedIfSparse: true }));
    ruleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyRule(ruleInput.value, { reseedIfSparse: true });
      e.stopPropagation();
    });
    $("rule-random").addEventListener("click", randomRule);

    for (const m of ["state", "age", "flow"]) {
      $("mode-" + m).addEventListener("click", () => {
        S.colorMode = m;
        document.querySelectorAll(".cmode").forEach((b) =>
          b.classList.toggle("active", b.id === "mode-" + m)
        );
        dirty = true;
        writeHash();
      });
    }

    $("cell-size").addEventListener("change", (e) => {
      S.cell = Number(e.target.value);
      setup(true);
      writeHash();
    });

    $("trail").addEventListener("input", (e) => {
      S.trail = Number(e.target.value) / 100;
      if (S.trail === 0 && heat) heat.fill(0);
      dirty = true;
      writeHash();
    });

    $("density").addEventListener("input", (e) => {
      const v = Number(e.target.value) / 100;
      if (S.dim === 2) S.density2d = v; else S.density1d = v;
      $("density-val").textContent = e.target.value + "%";
      writeHash();
    });

    $("seed-single").addEventListener("click", () => {
      S.seedMode1d = "single";
      document.body.classList.remove("seed-random");
      $("seed-single").classList.add("active");
      $("seed-random").classList.remove("active");
      seed1D();
      writeHash();
    });
    $("seed-random").addEventListener("click", () => {
      S.seedMode1d = "random";
      document.body.classList.add("seed-random");
      $("seed-random").classList.add("active");
      $("seed-single").classList.remove("active");
      seed1D();
      writeHash();
    });

    $("speed").addEventListener("input", (e) => {
      // log scale: 0..100 → 1..240 steps/s
      S.speed = Math.round(Math.pow(240, Number(e.target.value) / 100));
      $("speed-val").textContent = S.speed + "/s";
      writeHash();
    });

    $("btn-play").addEventListener("click", () => setRunning(!S.running));
    $("btn-step").addEventListener("click", () => { setRunning(false); stepOnce(); dirty = true; });
    $("btn-reseed").addEventListener("click", reseed);
    $("btn-dice").addEventListener("click", randomRule);
    $("btn-clear").addEventListener("click", () => { clear2D(); });

    $("copy-link").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        toast("link copied");
      } catch {
        toast("couldn't copy — grab the URL bar");
      }
    });

    $("panel-toggle").addEventListener("click", () =>
      document.body.classList.toggle("panel-open")
    );

    // syntax explainer modal
    const modal = $("syntax-modal");
    const openModal = () => { modal.hidden = false; };
    const closeModal = () => { modal.hidden = true; };
    $("syntax-help").addEventListener("click", openModal);
    $("syntax-close").addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    modal.querySelectorAll(".chips").forEach((group) => {
      const dim = Number(group.dataset.dim);
      group.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          setDim(dim);
          if (applyRule(chip.textContent, { reseedIfSparse: true })) {
            closeModal();
            setRunning(true);
            toast(S.rule.label);
          }
        });
      });
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeModal(); return; }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") { e.preventDefault(); setRunning(!S.running); }
      else if (e.key === "s") { setRunning(false); stepOnce(); dirty = true; }
      else if (e.key === "r") reseed();
      else if (e.key === "d") randomRule();
      else if (e.key === "c" && S.dim === 2) clear2D();
      else if (e.key === "h") document.body.classList.toggle("panel-open");
    });

    // Draw on the 2D grid / poke the 1D row.
    let drawing = false;
    const paint = (e) => {
      const x = Math.floor((e.clientX / window.innerWidth) * W);
      const y = Math.floor((e.clientY / window.innerHeight) * H);
      if (S.dim === 1) {
        if (x >= 0 && x < W) { cur1d[x] = cur1d[x] ? 0 : 1; }
        return;
      }
      const brush = Math.max(1, Math.round(5 / S.cell));
      const g = S.gen & 0xffff;
      for (let dy = -brush; dy <= brush; dy++) {
        for (let dx = -brush; dx <= brush; dx++) {
          if (dx * dx + dy * dy > brush * brush) continue;
          const cx = (x + dx + W) % W, cy = (y + dy + H) % H;
          const i = cy * W + cx;
          grid[i] = 1; heat[i] = 255; birth[i] = g; age[i] = 0;
        }
      }
      dirty = true;
    };
    view.addEventListener("pointerdown", (e) => { drawing = true; paint(e); });
    view.addEventListener("pointermove", (e) => { if (drawing) paint(e); });
    window.addEventListener("pointerup", () => { drawing = false; });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { setup(true); }, 250);
    });
  }

  // Little static diagrams inside the syntax modal. Built once at boot.
  function renderSyntaxDiagrams() {
    const cell = (cls) => {
      const c = document.createElement("span");
      c.className = "rd-cell" + (cls ? " " + cls : "");
      return c;
    };

    // Elementary: rule 110's full lookup table, one column per 3-cell pattern.
    const elem = $("diag-elem");
    if (elem) {
      const n = 110;
      for (let i = 7; i >= 0; i--) {
        const col = document.createElement("div");
        col.className = "rd-col";
        const pat = document.createElement("div");
        pat.className = "rd-row";
        for (const b of [4, 2, 1]) pat.appendChild(cell((i & b) ? "on" : ""));
        const res = document.createElement("div");
        res.className = "rd-row";
        res.appendChild(cell(((n >> i) & 1) ? "on" : ""));
        col.append(pat, res);
        elem.appendChild(col);
      }
    }

    // Totalistic: k3:912's answers, one column per neighborhood sum.
    const tot = $("diag-tot");
    if (tot) {
      const rule = CA.parse1D("k3:912");
      for (let s = 0; s <= 6; s++) {
        const col = document.createElement("div");
        col.className = "rd-col";
        const lbl = document.createElement("div");
        lbl.className = "rd-lbl";
        lbl.textContent = s;
        const res = document.createElement("div");
        res.className = "rd-row";
        res.appendChild(cell("s" + rule.lut[s]));
        col.append(lbl, res);
        tot.appendChild(col);
      }
    }

    // Moore neighborhood: a dead center cell with 3 live neighbors.
    const nb = $("diag-neigh");
    if (nb) {
      const live = new Set([0, 5, 7]);
      for (let i = 0; i < 9; i++)
        nb.appendChild(cell(i === 4 ? "center" : live.has(i) ? "on" : ""));
    }
  }

  function syncControlsFromState() {
    document.body.classList.toggle("dim1", S.dim === 1);
    document.body.classList.toggle("seed-random", S.seedMode1d === "random");
    $("mode-1d").classList.toggle("active", S.dim === 1);
    $("mode-2d").classList.toggle("active", S.dim === 2);
    document.querySelectorAll(".cmode").forEach((b) =>
      b.classList.toggle("active", b.id === "mode-" + S.colorMode)
    );
    $("seed-single").classList.toggle("active", S.seedMode1d === "single");
    $("seed-random").classList.toggle("active", S.seedMode1d === "random");
    $("cell-size").value = String(S.cell);
    $("trail").value = String(Math.round(S.trail * 100));
    const dens = Math.round((S.dim === 2 ? S.density2d : S.density1d) * 100);
    $("density").value = String(dens);
    $("density-val").textContent = dens + "%";
    $("speed").value = String(Math.round((Math.log(S.speed) / Math.log(240)) * 100));
    $("speed-val").textContent = S.speed + "/s";
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  readHash();
  if (S.dim === 1) document.body.classList.add("dim1");
  buildLUTs();
  setup(true);
  fillFamous();
  fillPalettes();
  renderSyntaxDiagrams();
  bind();
  syncControlsFromState();
  syncRuleUI();
  setRunning(true);
  updateHud();
  requestAnimationFrame((t) => { lastT = t; fpsT = t; requestAnimationFrame(frame); });
})();
