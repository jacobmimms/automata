"use strict";
// Cellular automata engine: rule parsing, stepping, random-rule generation.
// Pure logic, no DOM. Exposes window.CA.

const CA = (() => {
  // ---------------------------------------------------------------------------
  // Rule parsing
  //
  // 1D families:
  //   elementary   "110" / "rule 110" / "r110"        — Wolfram code, 0..255
  //   r2           "r2:2863311530" / "r2:0xaaaa5555"  — radius-2 binary, 32-bit
  //   totalistic   "k3:912"                           — k-state totalistic code
  //
  // 2D families:
  //   life         "B3/S23"  (also legacy S/B "23/3")
  //   generations  "B2/S/3"  (also legacy S/B/C "/2/3") — C total states
  // ---------------------------------------------------------------------------

  function err(msg) {
    return { ok: false, error: msg };
  }

  function parse1D(input) {
    const s = String(input).trim().toLowerCase().replace(/\s+/g, "");
    let m;

    if ((m = /^(?:rule|r)?(\d+)$/.exec(s))) {
      const n = Number(m[1]);
      if (n > 255)
        return err("Elementary rules are 0–255. Try r2:<n> or k3:<code> for bigger rule spaces.");
      const lut = new Uint8Array(8);
      for (let i = 0; i < 8; i++) lut[i] = (n >> i) & 1;
      return {
        ok: true, dim: 1, family: "elementary", states: 2, lut,
        canonical: String(n), label: "Rule " + n,
      };
    }

    if ((m = /^r2:(0x[0-9a-f]+|\d+)$/.exec(s))) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 0 || n > 0xffffffff)
        return err("r2 rules are 0–4294967295 (32 bits).");
      const lut = new Uint8Array(32);
      for (let i = 0; i < 32; i++) lut[i] = (n >>> i) & 1;
      return {
        ok: true, dim: 1, family: "r2", states: 2, lut,
        canonical: "r2:" + (n >>> 0), label: "r2 rule " + (n >>> 0),
      };
    }

    if ((m = /^k(\d):(\d+)$/.exec(s))) {
      const k = Number(m[1]);
      const code = Number(m[2]);
      if (k < 2 || k > 5) return err("k must be 2–5 states.");
      const nSums = 3 * (k - 1) + 1; // sum of 3 cells ranges 0..3(k-1)
      const max = Math.pow(k, nSums);
      if (code >= max)
        return err("Code too large for k" + k + " (max " + (max - 1) + ").");
      const lut = new Uint8Array(nSums);
      let c = code;
      for (let i = 0; i < nSums; i++) {
        lut[i] = c % k;
        c = Math.floor(c / k);
      }
      return {
        ok: true, dim: 1, family: "totalistic", states: k, lut,
        canonical: "k" + k + ":" + code, label: "k" + k + " code " + code,
      };
    }

    return err('Try a rule number ("110"), "r2:<n>", or "k3:<code>".');
  }

  function digitsToMask(str) {
    let mask = 0;
    for (const ch of str) mask |= 1 << Number(ch);
    return mask;
  }

  function maskToDigits(mask) {
    let out = "";
    for (let i = 0; i <= 8; i++) if ((mask >> i) & 1) out += i;
    return out;
  }

  function make2D(bMask, sMask, states) {
    const canonical =
      "B" + maskToDigits(bMask) + "/S" + maskToDigits(sMask) +
      (states > 2 ? "/" + states : "");
    return {
      ok: true, dim: 2,
      family: states > 2 ? "generations" : "life",
      states, bMask, sMask,
      canonical, label: canonical,
    };
  }

  function parse2D(input) {
    const s = String(input).trim().toLowerCase().replace(/\s+/g, "");
    let m;

    // B-first: B3/S23, B2/S/3, B2/S/C3
    if ((m = /^b([0-8]*)\/s([0-8]*)(?:\/c?(\d+))?$/.exec(s))) {
      const states = m[3] ? Number(m[3]) : 2;
      if (states < 2 || states > 24) return err("State count must be 2–24.");
      return make2D(digitsToMask(m[1]), digitsToMask(m[2]), states);
    }

    // legacy S/B or S/B/C: 23/3, /2/3, 345/2/4
    if ((m = /^([0-8]*)\/([0-8]*)(?:\/(\d+))?$/.exec(s))) {
      const states = m[3] ? Number(m[3]) : 2;
      if (states < 2 || states > 24) return err("State count must be 2–24.");
      return make2D(digitsToMask(m[2]), digitsToMask(m[1]), states);
    }

    return err('Try B/S notation like "B3/S23", or "B2/S/3" for multi-state rules.');
  }

  function parseRule(input, dim) {
    return dim === 1 ? parse1D(input) : parse2D(input);
  }

  // ---------------------------------------------------------------------------
  // Stepping
  // ---------------------------------------------------------------------------

  // 1D: src/dst are Uint8Array(W), wrap-around edges.
  function step1D(rule, src, dst) {
    const W = src.length;
    const lut = rule.lut;
    if (rule.family === "totalistic") {
      for (let x = 0; x < W; x++) {
        const l = src[(x - 1 + W) % W], c = src[x], r = src[(x + 1) % W];
        dst[x] = lut[l + c + r];
      }
    } else if (rule.family === "r2") {
      for (let x = 0; x < W; x++) {
        const i =
          (src[(x - 2 + W) % W] << 4) | (src[(x - 1 + W) % W] << 3) |
          (src[x] << 2) | (src[(x + 1) % W] << 1) | src[(x + 2) % W];
        dst[x] = lut[i];
      }
    } else {
      let l = src[W - 1], c = src[0];
      for (let x = 0; x < W; x++) {
        const r = src[(x + 1) % W];
        dst[x] = lut[(l << 2) | (c << 1) | r];
        l = c;
        c = r;
      }
    }
  }

  // 2D: Moore neighborhood, torus wrap. States: 0 dead, 1 alive, 2.. dying.
  // Only state 1 counts as a neighbor (matters for Generations rules).
  function step2D(rule, src, dst, W, H, xm, xp) {
    const bMask = rule.bMask, sMask = rule.sMask, C = rule.states;
    for (let y = 0; y < H; y++) {
      const y0 = y * W;
      const yu = ((y - 1 + H) % H) * W;
      const yd = ((y + 1) % H) * W;
      for (let x = 0; x < W; x++) {
        const l = xm[x], r = xp[x];
        const n =
          (src[yu + l] === 1 ? 1 : 0) + (src[yu + x] === 1 ? 1 : 0) + (src[yu + r] === 1 ? 1 : 0) +
          (src[y0 + l] === 1 ? 1 : 0) +                              (src[y0 + r] === 1 ? 1 : 0) +
          (src[yd + l] === 1 ? 1 : 0) + (src[yd + x] === 1 ? 1 : 0) + (src[yd + r] === 1 ? 1 : 0);
        const v = src[y0 + x];
        if (v === 0) {
          dst[y0 + x] = (bMask >> n) & 1;
        } else if (v === 1) {
          dst[y0 + x] = (sMask >> n) & 1 ? 1 : (C > 2 ? 2 : 0);
        } else {
          dst[y0 + x] = v + 1 < C ? v + 1 : 0;
        }
      }
    }
  }

  function wrapIndices(W) {
    const xm = new Uint32Array(W), xp = new Uint32Array(W);
    for (let x = 0; x < W; x++) {
      xm[x] = (x - 1 + W) % W;
      xp[x] = (x + 1) % W;
    }
    return { xm, xp };
  }

  // ---------------------------------------------------------------------------
  // Random rules, vetted for visual interest.
  //
  // A candidate is simulated briefly on a small hidden grid; rules that die
  // out, freeze, or settle into a short cycle get re-rolled.
  // ---------------------------------------------------------------------------

  function randInt(n) {
    return Math.floor(Math.random() * n);
  }

  function candidate1D() {
    const roll = Math.random();
    if (roll < 0.45) return parse1D(String(randInt(256)));
    if (roll < 0.8) {
      const k = Math.random() < 0.75 ? 3 : 4;
      const max = Math.pow(k, 3 * (k - 1) + 1);
      return parse1D("k" + k + ":" + randInt(max));
    }
    return parse1D("r2:" + randInt(0x100000000));
  }

  function candidate2D() {
    const pick = (from, to, p) => {
      let mask = 0;
      for (let i = from; i <= to; i++) if (Math.random() < p) mask |= 1 << i;
      return mask;
    };
    if (Math.random() < 0.7) {
      // life-like; skip B0/B1 (strobing / instant explosion)
      let b = pick(2, 8, 0.25);
      if (!b) b = 1 << (2 + randInt(3));
      const s = pick(0, 8, 0.33);
      return make2D(b, s, 2);
    }
    let b = pick(2, 8, 0.25);
    if (!b) b = 1 << 2;
    const s = pick(0, 8, 0.22); // sparse survival reads better with trails
    const states = 3 + randInt(5);
    return make2D(b, s, states);
  }

  function seedRow(W, mode, density, states) {
    const row = new Uint8Array(W);
    if (mode === "single") {
      row[W >> 1] = 1;
    } else {
      for (let x = 0; x < W; x++)
        if (Math.random() < density) row[x] = 1 + randInt(states - 1);
    }
    return row;
  }

  // Fraction of cells that differ.
  function diff(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d / a.length;
  }

  function density(a) {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== 0) n++;
    return n / a.length;
  }

  function interesting1D(rule, seedMode, seedDensity) {
    const W = 160, G = 110;
    let cur = seedRow(W, seedMode, seedDensity, rule.states);
    let prev = new Uint8Array(W);
    let prev2 = new Uint8Array(W);
    let activity = 0, activity2 = 0, samples = 0;
    for (let g = 0; g < G; g++) {
      prev2.set(prev);
      prev.set(cur);
      const next = new Uint8Array(W);
      step1D(rule, cur, next);
      cur = next;
      if (g >= G - 40) {
        activity += diff(cur, prev);
        activity2 += diff(cur, prev2);
        samples++;
      }
    }
    const d = density(cur);
    if (d < 0.02 || d > 0.98) return false;
    if (activity / samples < 0.04) return false;   // frozen
    if (activity2 / samples < 0.04) return false;  // period-2 blinker
    return true;
  }

  function interesting2D(rule, soupDensity) {
    const W = 96, H = 64, G = 70;
    const { xm, xp } = wrapIndices(W);
    let cur = new Uint8Array(W * H);
    let nxt = new Uint8Array(W * H);
    for (let i = 0; i < cur.length; i++)
      if (Math.random() < soupDensity) cur[i] = 1;
    const prev = new Uint8Array(W * H);
    const prev2 = new Uint8Array(W * H);
    let activity = 0, activity2 = 0, samples = 0;
    for (let g = 0; g < G; g++) {
      prev2.set(prev);
      prev.set(cur);
      step2D(rule, cur, nxt, W, H, xm, xp);
      const t = cur; cur = nxt; nxt = t;
      if (g >= G - 12) {
        activity += diff(cur, prev);
        activity2 += diff(cur, prev2);
        samples++;
      }
    }
    const d = density(cur);
    if (d < 0.006 || d > 0.85) return false;
    if (activity / samples < 0.004) return false;
    if (activity2 / samples < 0.004) return false;
    return true;
  }

  function randomRule(dim, opts) {
    const o = opts || {};
    let last = null;
    for (let i = 0; i < 40; i++) {
      const r = dim === 1 ? candidate1D() : candidate2D();
      if (!r.ok) continue;
      last = r;
      const good = dim === 1
        ? interesting1D(r, o.seedMode || "random", o.density ?? 0.35)
        : interesting2D(r, o.density ?? 0.3);
      if (good) return r;
    }
    return last; // nothing vetted in 40 tries — hand back the last roll
  }

  // ---------------------------------------------------------------------------
  // Famous rules
  // ---------------------------------------------------------------------------

  const FAMOUS_1D = [
    { s: "30",      name: "Rule 30",          desc: "Pure chaos — Wolfram's favorite; once a random number generator in Mathematica." },
    { s: "90",      name: "Rule 90",          desc: "Sierpiński triangles — each cell XORs its neighbors." },
    { s: "110",     name: "Rule 110",         desc: "Turing-complete — gliders drifting on a periodic background." },
    { s: "54",      name: "Rule 54",          desc: "Colliding particles and standing waves." },
    { s: "184",     name: "Rule 184",         desc: "Traffic flow — jams form and dissolve. Best from a random seed." },
    { s: "150",     name: "Rule 150",         desc: "Three-way XOR — a denser fractal weave." },
    { s: "62",      name: "Rule 62",          desc: "Interlocking triangle lattice." },
    { s: "73",      name: "Rule 73",          desc: "Walls with chaotic machinery inside." },
    { s: "45",      name: "Rule 45",          desc: "Slanted chaos — asymmetric and restless." },
    { s: "k3:912",  name: "Code 912 (3-state)",  desc: "Totalistic — braided three-color growth." },
    { s: "k3:1599", name: "Code 1599 (3-state)", desc: "Totalistic — class-4 gliders in three colors." },
    { s: "k3:777",  name: "Code 777 (3-state)",  desc: "Totalistic — slow amorphous blooms." },
  ];

  const FAMOUS_2D = [
    { s: "B3/S23",        name: "Conway's Life",      desc: "The classic — gliders, blinkers, and still lifes." },
    { s: "B36/S23",       name: "HighLife",           desc: "Life plus a natural self-replicator." },
    { s: "B2/S",          name: "Seeds",              desc: "Explosive — every living cell dies each tick." },
    { s: "B3678/S34678",  name: "Day & Night",        desc: "Symmetric between life and death — blobby continents." },
    { s: "B3/S012345678", name: "Life without Death", desc: "Nothing dies — ladders and lichen creep outward." },
    { s: "B3/S12345",     name: "Maze",               desc: "Grows corridors like a living labyrinth." },
    { s: "B35678/S5678",  name: "Diamoeba",           desc: "Chaotic amoebas with diamond skins." },
    { s: "B36/S125",      name: "2×2",           desc: "Evolves in 2×2 blocks — oddly mechanical." },
    { s: "B368/S245",     name: "Morley",             desc: "Slow puffers and elegant spaceships." },
    { s: "B1357/S1357",   name: "Replicator",         desc: "Every pattern copies itself. Try drawing." },
    { s: "B4678/S35678",  name: "Anneal",             desc: "Domains smooth out like cooling metal." },
    { s: "B2/S/3",        name: "Brian's Brain",      desc: "3-state — endless streaking spaceships." },
    { s: "B2/S345/4",     name: "Star Wars",          desc: "4-state — dogfights, beams, and construction." },
  ];

  return {
    parseRule, parse1D, parse2D,
    step1D, step2D, wrapIndices,
    randomRule, seedRow,
    FAMOUS_1D, FAMOUS_2D,
  };
})();
