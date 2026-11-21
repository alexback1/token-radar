// Launch Signal's dashboard. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the board, filters, detail view and live anchors.
// No network: every byte shown is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var state = { q: '', cat: 'all', verdict: 'all', watch: false, sort: 'implied', sel: null };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // The page recomputes a row from its own factors, so the number on screen is
  // the same arithmetic board.json carries — code and data visibly agree.
  function impliedOf(row) {
    var m = row.model;
    return Math.max(1, Math.round(m.loglog_base_usd * m.growth_multiplier * m.maturity_multiplier * m.p_token));
  }

  var app = document.getElementById('app');
  app.setAttribute('aria-busy', 'false');

  document.getElementById('asof').textContent =
    'Snapshot ' + DATA.as_of + ' · DefiLlama · floor $' + (DATA.floor_usd / 1e6) + 'M · model ' +
    DATA.model_version + ' · log(mcap) = ' + DATA.validation.fit.a.toFixed(4) + ' + ' +
    DATA.validation.fit.b.toFixed(4) + ' · log(TVL), fitted on ' + DATA.validation.fit.n + ' traded comps';

  var v = DATA.validation;
  var kpis = [
    [DATA.scanned, 'protocols scanned'],
    [DATA.watchlist_size, 'on the watchlist'],
    [DATA.board_size, 'rows on the board'],
    [DATA.validation.fit.n, 'traded anchors fitted'],
    [v.splits.length ? v.splits[0].model_median_abs_log_err.toFixed(2) : 'n/a', 'held-out median |log err|'],
  ];
  document.getElementById('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><b>' + k[0] + '</b><span>' + k[1] + '</span></div>';
  }).join('');

  document.getElementById('integrity').innerHTML =
    '<b>How to read this board.</b> Implied value = exp(a + b·ln TVL) × growth × maturity × token odds, ' +
    'fitted on ' + v.fit.n + ' protocols whose token trades (market cap above zero). ' +
    v.fit.excluded_zero_mcap + ' traded protocols with a market cap of zero or less were left out of the fit. ' +
    'Held-out median |log error| ' + v.splits[0].model_median_abs_log_err + ' against a flat 0.25×TVL baseline of ' +
    v.splits[0].baseline_median_abs_log_err + '; walk-forward ' + v.splits[1].model_median_abs_log_err +
    ' against ' + v.splits[1].baseline_median_abs_log_err + '. A protocol here records no token — that is not proof it has none.';

  var cats = [];
  DATA.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();
  document.getElementById('cat').innerHTML = '<option value="all">All categories</option>' +
    cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.verdict !== 'all' && r.farm.verdict !== state.verdict) return false;
      if (state.cat !== 'all' && r.category !== state.cat) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    rows.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d || 0) - (a.change_7d || 0);
      if (key === 'age') return (b.age_days || 0) - (a.age_days || 0);
      return a.rank - b.rank;
    });
    return rows;
  }

  function renderRows() {
    var rows = filtered();
    document.getElementById('count').textContent = rows.length + ' of ' + DATA.rows.length + ' rows';
    document.getElementById('rows').innerHTML = rows.map(function (r) {
      var g = r.change_7d;
      var cls = g === null ? '' : (g >= 0 ? 'pos' : 'neg');
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (state.sel === r.slug ? 'sel' : '') + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b>' + (r.watchlist ? '<span class="tag watch">WATCHLIST</span>' : '') + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + cls + '">' + fmtPct(g) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num"><b>' + fmtUsd(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + (r.model.p_token * 100).toFixed(0) + '%</td>' +
        '<td><span class="tag v-' + r.farm.verdict + '">' + r.farm.verdict + '</span></td></tr>';
    }).join('');
  }

  function renderDetail() {
    var box = document.getElementById('detail');
    var r = null;
    DATA.rows.forEach(function (row) { if (row.slug === state.sel) r = row; });
    if (!r) { box.innerHTML = ''; return; }
    var m = r.model;
    var recomputed = impliedOf(r);
    var same = recomputed === r.implied_value_usd ? 'matches the board' : 'differs from the board';
    var factors = [
      ['Log-log base', fmtUsd(m.loglog_base_usd), 'exp(' + m.fit_a + ' + ' + m.fit_b + ' · ln TVL)', 0.7],
      ['Growth ×' + m.growth_multiplier.toFixed(2), fmtPct(r.change_7d) + ' in 7d', 'clamped −60% to +120%', 0.5],
      ['Maturity ×' + m.maturity_multiplier.toFixed(2), fmtAge(r.age_days), '0.6 + age/1095d × 0.4', 0.6],
      ['Token odds ×' + m.p_token.toFixed(2), (m.p_token * 100).toFixed(0) + '%', 'shrunk category rate', m.p_token],
    ];
    var comps = DATA.live.filter(function (l) { return l.category === r.category; }).slice(0, 3);
    var anchor = comps.length
      ? 'Traded anchors in ' + esc(r.category || 'this category') + ': ' + comps.map(function (l) {
          return esc(l.name) + ' (' + fmtUsd(l.mcap_usd) + ' mcap / ' + fmtUsd(l.tvl_usd) + ' TVL)';
        }).join('; ') + '.'
      : 'No traded anchor in this category — the global fit carries the row.';
    box.innerHTML =
      '<h2>#' + r.rank + ' · ' + esc(r.name) + ' <span class="tag v-' + r.farm.verdict + '">' + r.farm.verdict + '</span></h2>' +
      '<p class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + ' · TVL ' + fmtUsd(r.tvl_usd) +
      ' · implied value <b>' + fmtUsd(r.implied_value_usd) + '</b> (page recomputes ' + fmtUsd(recomputed) + ' — ' + same + '). ' +
      (r.watchlist ? 'On the watchlist. ' : 'Below the watchlist floor — an early find. ') + anchor + '</p>' +
      '<div class="factors">' + factors.map(function (f) {
        return '<div class="factor"><b>' + f[1] + '</b><span>' + f[0] + '</span><span>' + f[2] + '</span>' +
          '<div class="bar"><i style="width:' + Math.round(Math.min(1, Math.max(0, f[3])) * 100) + '%"></i></div></div>';
      }).join('') + '</div>' +
      '<h3>Farm plan — deposit $' + r.farm.deposit_usd + ', about $' + r.farm.total_fees_usd + ' of fees over ' +
      r.farm.hold_days + ' days</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
  }

  document.getElementById('live').innerHTML = DATA.live.map(function (l) {
    return '<tr><td><b>' + esc(l.name) + '</b></td><td>' + esc(l.category || '—') + '</td>' +
      '<td class="num">' + fmtUsd(l.tvl_usd) + '</td><td class="num">' + fmtUsd(l.mcap_usd) + '</td>' +
      '<td class="num">' + (l.mcap_usd / l.tvl_usd).toFixed(2) + '×</td></tr>';
  }).join('');

  document.getElementById('method').innerHTML =
    '<h2>Method and limits</h2>' +
    '<p><b>Fit.</b> <code>log(mcap) = a + b · log(TVL)</code> by least squares on ' + v.fit.n +
    ' traded protocols. Full fit: a = ' + v.fit.a.toFixed(4) + ', b = ' + v.fit.b.toFixed(4) +
    '. A flat 0.25×TVL multiple and a per-category median multiple were both tested and both lost ' +
    'on the held-out split, so neither was shipped.</p>' +
    '<p><b>Validation.</b> Held-out (hash split 70/30, n=' + v.splits[0].n_test + '): model ' +
    v.splits[0].model_median_abs_log_err + ' vs baseline ' + v.splits[0].baseline_median_abs_log_err +
    '. Walk-forward (n=' + v.splits[1].n_test + '): model ' + v.splits[1].model_median_abs_log_err +
    ' vs baseline ' + v.splits[1].baseline_median_abs_log_err + '. Median |log error| near 1.6 still ' +
    'means a typical prediction is off by a factor of about five — this board ranks, it does not price.</p>' +
    '<p><b>Verdict.</b> FARM if implied value is at least $10M, THIN if at least $2M, otherwise SKIP. ' +
    'The verdict is a triage rule on the board&rsquo;s own number, not a promise of an airdrop.</p>' +
    '<p><b>Limits.</b> The snapshot is frozen at ' + DATA.as_of + '; nothing here updates. ' +
    'TVL is the only size signal, so a protocol with small TVL and a strong community can rank ' +
    'too low, and a large quiet one too high. No name is ever special-cased.</p>';

  function bind(id, evt, fn) { document.getElementById(id).addEventListener(evt, fn); }
  bind('q', 'input', function (e) { state.q = e.target.value; renderRows(); });
  bind('cat', 'change', function (e) { state.cat = e.target.value; renderRows(); });
  bind('verdict', 'change', function (e) { state.verdict = e.target.value; renderRows(); });
  bind('watch', 'change', function (e) { state.watch = e.target.checked; renderRows(); });
  bind('sort', 'change', function (e) { state.sort = e.target.value; renderRows(); });
  document.getElementById('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    state.sel = tr.getAttribute('data-slug');
    renderRows();
    renderDetail();
    document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  renderRows();
})();
