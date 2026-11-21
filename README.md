# Launch Signal — token-radar-01

A fitted token-launch radar: 198 pre-token protocols ranked by implied value,
each with a costed farm plan. Built for the make.fun bounty token-radar-01
("Build the best token launch radar", $1,325, deadline 2026-12-14 10:00 UTC).

> TODO for the coordinator before submit (P-42): add the three lines of LIVE
> make.fun badge (competition, rank, reward) at the top of this README once the
> entry is submitted, and set the GitHub repo About homepage to the bounty page
> with topic `makefun`. No rank exists yet, so no badge is faked here.

## The model (radar-2)

Implied value for a pre-token protocol:

    implied = exp(a + b · ln(TVL)) × growth × maturity × p_token

- `exp(a + b·ln TVL)`: log-log regression of market cap on TVL, fitted at run
  time on the 128 traded protocols in the sealed snapshot (market cap above
  zero). Full fit: a = 6.9646, b = 0.5223.
- `growth = 1 + clamp(change_7d, −60, 120)/100 × 0.5`.
- `maturity = 0.6 + min(age_days, 1095)/1095 × 0.4` (unknown age: 365 days).
- `p_token`: the category's traded share, shrunk toward the global rate 0.549.

Validation, measured at run time from the same snapshot and shown on the
dashboard: held-out median |log error| 1.635 vs 2.044 for a flat 0.25×TVL
baseline (hash split 70/30, n=39); walk-forward 1.102 vs 1.421 (n=48).
A flat multiple and a per-category median multiple were both tested and both
lost on the held-out split. The error is still large — a typical prediction is
off by a factor of about five — so this board ranks, it does not price.

## Coverage and farm plans

- Board: 198 rows — every pre-token protocol that passes the watchlist's own
  exclusion rule (not CEX/Bridge/Liquid Staking, not versioned, not
  wrapped/staked, not an exchange product). All 40 watchlist slugs covered,
  plus 158 early finds below the floor.
- 24 live-token anchors (top by market cap) are shown separately; they anchor
  the fit and are never ranked as launches.
- Every row carries a 7-step farm plan with deposit, gas, and timeline:
  deposit $250 / $150 / $100 by TVL, $6 setup gas, $2 weekly gas, hold
  30–60 days by age. Verdict: FARM if implied ≥ $10M (16 rows), THIN if
  ≥ $2M (127), SKIP below that (55).

## Run it

Node 22.18+ (the grader runs Node 22; this machine runs Node 24.22.1):

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>

Two runs write byte-identical output. `out/` holds `board.json`, `data.js`,
`dashboard/`, `screenshots/`, and `dossier.json` (built with the vendored
`vendor/makefun-board.ts`).

## Layout

    main.ts               entry runner (Node 22, standard library only)
    lib/model.ts          the fitted model, validation, farm plans
    vendor/makefun-board.ts   make.fun dossier library, from the kit, unchanged
    dashboard/            index.html, app.css, app.js — static, no network
    screenshots/          1-board.png, 2-detail.png, 3-filtered.png
    LICENSE               MIT

Screenshots on this machine were rendered with PIL from the real board data
(no browser is installed here). Re-render them in a real browser before
submit and replace the files.

## Honest limits

- The snapshot is frozen at 2026-11-14; nothing here updates.
- TVL is the only size signal, so a small protocol with a strong community can
  rank too low and a large quiet one too high.
- A protocol on this board *records no token* — that is not proof it has none.
- Implied value is this board's own claim, never a market price. Farming
  carries risk: only farm with funds you can lose.
