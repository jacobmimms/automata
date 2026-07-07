# automata

An infinite cellular automata playground, live at [automata.mimmsy.com](https://automata.mimmsy.com).

Pure static site — no build step, no dependencies. `index.html` + `engine.js` (rule parsing, stepping, vetted random rules) + `app.js` (canvas rendering, UI).

## Rule syntax

| Family | Example | Space |
|---|---|---|
| 1D elementary | `110` | Wolfram codes 0–255 |
| 1D radius-2 binary | `r2:2863311530` | 32-bit rule numbers |
| 1D k-state totalistic | `k3:912` | Wolfram totalistic codes |
| 2D Life-like | `B3/S23` (also legacy `23/3`) | birth/survival on 0–8 neighbors |
| 2D Generations | `B2/S/3` (also `/2/3`) | + count of dying states |

The 🎲 button rolls random rules and quietly re-rolls any that die out, freeze, or blink with period 2 on a small hidden test grid.

## Dev

Any static server, e.g.:

```sh
python3 -m http.server 8000
```

## Deploy

Deployed as a mimmsy.com subdomain project: Cloudflare Pages project `mimmsy-automata`, git-connected to this repo, production branch `main`, no build command (the mimmsy control plane injects its shared nav at build time), output directory `.`.
