#!/usr/bin/env python3
"""Build a single-file HTML reproduction of a Tableau Pulse metric detail view
from a Pulse REST API insight bundle (no iframe, no external resources).

Usage:  python build-prototype.py
Input:  detail-bundle.json   (same directory)
Output: pulse-html-prototype.html
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'detail-bundle.json')
OUT = os.path.join(HERE, 'pulse-html-prototype.html')


# --------------------------------------------------------------------------
# extraction helpers
# --------------------------------------------------------------------------

def num(v):
    """Pulse encodes numeric fields as strings, and missing values as the
    literal string "null". Normalize both to float | None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s == '' or s.lower() == 'null':
        return None
    try:
        return float(s)
    except ValueError:
        return None


def params_of(viz):
    return {p['name']: p['value'] for p in (viz.get('params') or [])}


def strip_tags(s):
    return re.sub(r'<[^>]*>', '', s or '')


def metric_name_from(markup):
    m = re.search(r'<span data-type="metric">([^<]*)</span>', markup or '')
    return m.group(1) if m else 'Metric'


def bar_values(viz):
    out = []
    for v in viz['data']['values']:
        out.append({
            'entityName': v.get('entityName'),
            'value': num(v.get('value')),
            'formattedValue': v.get('formattedValue'),
            'average': bool(v.get('average') or v.get('sum')),
        })
    return out


# --------------------------------------------------------------------------
# build payload
# --------------------------------------------------------------------------

def build_payload():
    doc = json.load(open(SRC, encoding='utf-8'))
    result = doc['bundle_response']['result']
    groups = {g['type']: g for g in result['insight_groups']}

    ban = groups['ban']['insights'][0]['result']
    anchor = groups['anchor']['insights'][0]['result']
    followups = [i['result'] for i in groups['followup']['insights']]
    trend = next(r for r in followups if r['type'] == 'currenttrend')

    bf = ban['facts']

    # ---- BAN -------------------------------------------------------------
    ban_out = {
        'markup': ban['markup'],
        'question': ban['question'],
        'value': bf['target_period_value']['formatted'],
        'comparisonValue': bf['comparison_period_value']['formatted'],
        'direction': bf['difference']['direction'],
        'sentiment': bf.get('sentiment', 'neutral'),
        'absolute': bf['difference']['absolute']['formatted'],
        'relative': bf['difference']['relative']['formatted'],
        'targetLabel': bf['target_time_period']['label'],
        'targetRange': bf['target_time_period']['range'],
        'comparisonLabel': bf['comparison_time_period']['label'],
        'comparisonRange': bf['comparison_time_period']['range'],
        'granularity': bf['target_time_period']['granularity'],
        'bars': bar_values(ban['viz']),
    }

    # ---- trend (currenttrend, 82 points incl. 2 trend-line endpoints) -----
    tp = params_of(trend['viz'])
    tcf = trend['viz'].get('customFormatterMaps') or {}
    trend_points = []
    for p in trend['viz']['data']['values']:
        trend_points.append({
            'd': p['truncDate'],
            'v': num(p.get('rawValue')),
            'f': None if p.get('formattedRawValue') in (None, 'null') else p['formattedRawValue'],
            'dl': p.get('formattedTruncDate'),
            'proj': bool(p.get('isProjection')),
            'seg': p.get('segment'),
            'iso': int(p.get('showIsolatedPoint') or 0),
            'tip': p.get('tooltipMarkup'),
        })
    trend_out = {
        'markup': trend['markup'],
        'question': trend['question'],
        'points': trend_points,
        'yDomain': [num(x) for x in tp['yAxisDomain']],
        'yTicks': [num(x) for x in tp['yAxisLabelsDataValues']],
        'yLabels': tcf.get('yAxis', {}),
        'xTicks': tp['xAxisLabelsDataValues'],
        'xLabels': tcf.get('xAxis', {}),
        'colors': {
            'default': tp.get('colorDefault'),
            'projection': tp.get('colorProjection'),
            'desired': tp.get('colorDesiredTrend'),
            'undesired': tp.get('colorUndesiredTrend'),
            'grid': tp.get('xAxisGridColorDefault'),
            'gridActive': tp.get('xAxisGridColorActive'),
            'axisLabel': tp.get('axisLabelColor'),
            'hoverLine': tp.get('hoverVerticalLineColor'),
            'hoverDot': tp.get('hoverDotColor'),
        },
        'strokeDash': tp.get('lineStrokeDash'),
        'facts': {
            'trendDirection': trend['facts'].get('trend_direction'),
            'volatility': trend['facts'].get('volatility'),
            'start': trend['facts']['start_time_period']['range'],
            'end': trend['facts']['end_time_period']['range'],
            'grain': trend['facts'].get('time_grain'),
            'numPeriods': trend['facts'].get('num_periods'),
        },
    }

    # ---- anchor (unusualchange, expected-range band) ---------------------
    ap = params_of(anchor['viz'])
    acf = anchor['viz'].get('customFormatterMaps') or {}
    anchor_points = []
    for p in anchor['viz']['data']['values']:
        anchor_points.append({
            'd': p['truncDate'],
            'v': num(p.get('rawValue')),
            'f': None if p.get('formattedRawValue') in (None, 'null') else p['formattedRawValue'],
            'dl': p.get('formattedTruncDate'),
            'ci0': num(p.get('ci0')),
            'ci1': num(p.get('ci1')),
            'seg': p.get('segment'),
            'iso': int(p.get('showIsolatedPoint') or 0),
            'point': int(p.get('point') or 0),
            'tip': p.get('tooltipMarkup'),
        })
    legend = anchor['viz'].get('legend') or {}
    anchor_out = {
        'markup': anchor['markup'],
        'question': anchor['question'],
        'points': anchor_points,
        'yDomain': [num(x) for x in ap['yAxisDomain']],
        'yTicks': [num(x) for x in ap['yAxisLabelsDataValues']],
        'yLabels': acf.get('yAxis', {}),
        'xTicks': ap['xAxisLabelsDataValues'],
        'xLabels': acf.get('xAxis', {}),
        'activeDate': ap.get('activeLabelAndGridDate'),
        'colors': {
            'line': ap.get('lineColor'),
            'band': ap.get('normalRangeColor'),
            'currentCircle': ap.get('currentValueCircleColor1'),
            'currentText': ap.get('currentValueColor'),
            'grid': ap.get('xAxisGridColorDefault'),
            'gridActive': ap.get('xAxisGridColorActive'),
            'axisLabel': ap.get('axisLabelColor'),
        },
        'legend': [
            {'name': e.get('name'), 'label': e.get('label'), 'type': (e.get('mark') or {}).get('type')}
            for e in (legend.get('elements') or [])
        ],
        'legendNote': ' '.join(x.get('text', '') for x in (legend.get('explanations') or [])).strip(),
        'facts': {
            'unusual': anchor['facts'].get('unusual_change_type'),
            'value': (anchor['facts'].get('value') or {}).get('formatted'),
            'period': (anchor['facts'].get('last_complete_period') or {}).get('range'),
            'sentiment': anchor['facts'].get('sentiment'),
        },
    }

    # ---- breakdown (5 dimensions) ----------------------------------------
    breakdowns = []
    for ins in groups['breakdown']['insights']:
        r = ins['result']
        dims = r['facts'].get('dimensions') or []
        breakdowns.append({
            'dimension': dims[0]['label'] if dims else strip_tags(r['question']),
            'question': r['question'],
            'markup': r['markup'],
            'type': r['type'],
            'values': bar_values(r['viz']),
        })

    # ---- followups: a representative subset (highest score per type) -----
    wanted = ['top-drivers', 'riskmo', 'bottom-contributors', 'top-detractors']
    picked = []
    for t in wanted:
        cands = [r for r in followups if r['type'] == t]
        if not cands:
            continue
        best = max(cands, key=lambda r: r.get('score') or 0)
        picked.append({
            'type': best['type'],
            'question': best['question'],
            'markup': best['markup'],
            'score': round(best.get('score') or 0, 3),
            'values': bar_values(best['viz']),
        })
    picked.sort(key=lambda x: -x['score'])

    payload = {
        'meta': {
            'metricName': metric_name_from(ban['markup']),
            'targetRange': bf['target_time_period']['range'],
            'comparisonRange': bf['comparison_time_period']['range'],
            'granularity': bf['target_time_period']['granularity'],
            'insightCount': sum(len(g['insights']) for g in result['insight_groups']),
            'groupCounts': {g['type']: len(g['insights']) for g in result['insight_groups']},
            'followupTotal': len(followups),
        },
        'ban': ban_out,
        'trend': trend_out,
        'anchor': anchor_out,
        'breakdowns': breakdowns,
        'followups': picked,
        'palette': {
            'favorable': '#1EA562',
            'unfavorable': '#C6154A',
            'neutral': '#1678CC',
            'bar': '#5FB5FF',
            'barNegative': '#FA5F8D',
            'barAverage': '#C8CED8',
            'text': '#343A3F',
            'textStrong': '#040507',
        },
        # Deliberately hostile markup, used by the on-page sanitizer self-test.
        'sanitizerProbe': (
            '<span data-type="metric">Metric</span> '
            '<script>window.__pwned = true;</script>'
            '<img src="x" onerror="window.__pwned = true">'
            '<a href="javascript:void(0)" onclick="window.__pwned = true">link</a>'
            '<span data-type="entity" onmouseover="window.__pwned = true">Entity</span>'
        ),
    }
    return payload


# --------------------------------------------------------------------------
# HTML template
# --------------------------------------------------------------------------

TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse metric (HTML reproduction)</title>
<style>
:root{
  --font: 'SF Pro Text','SF Pro Display',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,'Helvetica Neue',sans-serif;
  --text:#343A3F; --strong:#040507; --muted:#6B7280;
  --line:#E5E8EB; --bg:#F5F7F9; --card:#FFFFFF;
  --blue:#1678CC; --green:#1EA562; --red:#C6154A;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
     font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:24px 16px 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
      padding:20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card h2{margin:0 0 4px;font-size:15px;font-weight:600;color:var(--strong);letter-spacing:.01em}
.card .sub{margin:0 0 16px;font-size:12px;color:var(--muted)}

/* header */
.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.hdr h1{margin:0;font-size:22px;font-weight:600;color:var(--strong);letter-spacing:-.01em}
.hdr .period{margin-top:4px;font-size:13px;color:var(--muted)}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;background:#EEF2F6;
       color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}

/* BAN */
.ban{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-top:14px}
.ban .value{font-size:44px;line-height:1.05;font-weight:600;color:var(--strong);letter-spacing:-.02em}
.delta{display:inline-flex;align-items:center;gap:6px;font-size:16px;font-weight:600;
       padding:5px 12px;border-radius:999px}
.delta .arrow{font-size:13px;line-height:1}
.delta.up{color:var(--green);background:rgba(30,165,98,.10)}
.delta.down{color:var(--red);background:rgba(198,21,74,.10)}
.delta.flat{color:var(--blue);background:rgba(22,120,204,.10)}
.ban .vs{font-size:13px;color:var(--muted)}

/* insight text */
.insight{margin:0 0 10px;font-size:14px;color:var(--text)}
.insight:last-child{margin-bottom:0}
.insight [data-type="metric"]{font-weight:600;color:var(--strong)}
.insight [data-type="insight-type-keyword"]{font-weight:600;color:var(--strong);
       background:linear-gradient(transparent 62%,#DCEBFA 62%)}
.insight [data-type="entity"]{font-weight:500;color:var(--blue)}
.insight [data-type="value"]{font-weight:600;color:var(--strong)}

/* charts */
.chart{position:relative}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.tip{position:absolute;pointer-events:none;opacity:0;transition:opacity .08s;
     background:rgba(4,5,7,.92);color:#fff;border-radius:6px;padding:6px 9px;
     font-size:12px;white-space:nowrap;transform:translate(-50%,-125%);z-index:5}
.tip [data-type="value"]{font-weight:600}
.tip [data-type="period"]{display:block;font-size:11px;opacity:.75}
.tip [data-type="actual-label"]{opacity:.75;margin-right:6px}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--muted)}
.legend .item{display:flex;align-items:center;gap:6px}
.legend .swatch{width:14px;height:10px;border-radius:2px;display:inline-block}
.legend .swatch.line{height:0;border-top:3px solid #058AFF;border-radius:0}
.note{margin-top:8px;font-size:11.5px;color:var(--muted);line-height:1.45}

/* tabs */
.tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:14px}
.tab{appearance:none;border:0;background:none;font:inherit;font-size:13px;color:var(--muted);
     padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;border-radius:6px 6px 0 0}
.tab:hover{color:var(--strong);background:#F5F7F9}
.tab[aria-selected="true"]{color:var(--strong);font-weight:600;border-bottom-color:#058AFF}

/* accordion */
.acc{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:8px}
.acc:last-child{margin-bottom:0}
.acc>button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;
   appearance:none;border:0;background:#FBFCFD;font:inherit;text-align:left;padding:11px 14px;cursor:pointer;color:var(--strong)}
.acc>button:hover{background:#F2F5F8}
.acc>button .q{font-size:13.5px;font-weight:500}
.acc>button .chev{color:var(--muted);font-size:12px;transition:transform .15s}
.acc[open-state="1"]>button .chev{transform:rotate(90deg)}
.acc .body{padding:14px;border-top:1px solid var(--line);display:none}
.acc[open-state="1"] .body{display:block}
.acc .kind{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}

/* footer */
.foot{font-size:11.5px;color:var(--muted);line-height:1.6}
.foot code{background:#EEF2F6;padding:1px 5px;border-radius:4px;font-size:11px}
.ok{color:var(--green);font-weight:600}
.bad{color:var(--red);font-weight:600}
.probe{margin-top:6px;padding:8px 10px;background:#F5F7F9;border-radius:6px;font-size:12px}
@media (max-width:560px){
  .ban .value{font-size:34px}
  .wrap{padding:16px 10px 48px}
  .card{padding:16px}
}
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <div class="hdr">
      <div>
        <h1 id="metric-name">&nbsp;</h1>
        <div class="period" id="metric-period"></div>
      </div>
      <span class="badge" id="metric-badge"></span>
    </div>
    <div class="ban">
      <div class="value" id="ban-value"></div>
      <div id="ban-delta"></div>
      <div class="vs" id="ban-vs"></div>
    </div>
    <div style="margin-top:18px" class="chart" id="ban-bars"></div>
  </div>

  <div class="card">
    <h2>Insights</h2>
    <p class="sub" id="insight-sub"></p>
    <p class="insight" id="insight-ban"></p>
    <p class="insight" id="insight-anchor"></p>
  </div>

  <div class="card">
    <h2 id="trend-title">What is the trend?</h2>
    <p class="sub" id="trend-sub"></p>
    <div class="chart" id="trend-chart"><div class="tip" id="trend-tip"></div></div>
    <div class="legend" id="trend-legend"></div>
    <p class="note" id="trend-note"></p>
  </div>

  <div class="card">
    <h2 id="anchor-title">Is this change unexpected?</h2>
    <p class="sub" id="anchor-sub"></p>
    <div class="chart" id="anchor-chart"><div class="tip" id="anchor-tip"></div></div>
    <div class="legend" id="anchor-legend"></div>
    <p class="note" id="anchor-note"></p>
  </div>

  <div class="card">
    <h2>Breakdown</h2>
    <p class="sub">Top contributors by dimension for the current period.</p>
    <div class="tabs" id="bd-tabs" role="tablist"></div>
    <p class="insight" id="bd-markup"></p>
    <div class="chart" id="bd-chart"></div>
  </div>

  <div class="card">
    <h2>Related questions</h2>
    <p class="sub" id="fu-sub"></p>
    <div id="fu-list"></div>
  </div>

  <div class="card foot">
    <div><strong>Reproduction notes.</strong> Rendered entirely from one Pulse
      <code>insight bundle</code> (detail) response. No iframe, no network requests,
      no external fonts or scripts; every chart is hand-drawn SVG.</div>
    <div style="margin-top:6px">Bundle contents: <span id="foot-counts"></span></div>
    <div class="probe">Sanitizer self-test: <span id="probe-result"></span>
      <div style="margin-top:6px">rendered output &rarr; <span class="insight" id="probe-out"></span></div>
    </div>
  </div>

</div>

<script type="application/json" id="pulse-data">__PULSE_DATA__</script>
<script>
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('pulse-data').textContent);
  var NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------- utils
  function svgEl(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function svgText(parent, x, y, s, attrs) {
    var t = svgEl('text', Object.assign({ x: x, y: y }, attrs || {}), parent);
    t.textContent = s;
    return t;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function ms(iso) { return Date.parse(iso); }

  // ------------------------------------------------------------ sanitizer
  // Bundle markup is server-generated HTML. It is still untrusted input, so it
  // is parsed inert (<template>) and rebuilt from a tag/attribute allowlist.
  var ALLOWED_TAGS = { SPAN: 1, B: 1, STRONG: 1, EM: 1, I: 1, BR: 1 };
  var ALLOWED_TYPES = {
    metric: 1, 'insight-type-keyword': 1, entity: 1, value: 1,
    period: 1, 'actual-label': 1, 'actual-value': 1
  };
  // Unwrapping keeps an element's text; for these the text is code, so the
  // whole subtree is discarded instead.
  var DROP_SUBTREE = {
    SCRIPT: 1, STYLE: 1, TEMPLATE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
    NOSCRIPT: 1, SVG: 1, MATH: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1
  };
  function sanitizeMarkup(html) {
    var frag = document.createDocumentFragment();
    if (!html) return frag;
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html);            // inert: no script exec, no image fetch
    (function walk(src, dst) {
      for (var n = src.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {              // text
          dst.appendChild(document.createTextNode(n.nodeValue));
        } else if (n.nodeType === 1) {       // element
          if (DROP_SUBTREE[n.tagName]) {
            continue;                        // drop element AND its contents
          } else if (ALLOWED_TAGS[n.tagName]) {
            var out = document.createElement(n.tagName.toLowerCase());
            var t = n.getAttribute('data-type');
            if (t && ALLOWED_TYPES[t]) out.setAttribute('data-type', t);
            walk(n, out);                    // all other attributes dropped
            dst.appendChild(out);
          } else {
            walk(n, dst);                    // unwrap: keep text, drop element
          }
        }
      }
    })(tpl.content, frag);
    return frag;
  }
  function setMarkup(node, html) { clear(node); node.appendChild(sanitizeMarkup(html)); }

  // ------------------------------------------------------------- responsive
  var charts = [];
  function register(container, draw) {
    var entry = { container: container, draw: draw };
    charts.push(entry);
    entry.render = function () {
      var w = container.clientWidth || 700;
      var tip = container.querySelector('.tip');
      clear(container);
      if (tip) container.appendChild(tip);
      draw(container, w);
    };
    entry.render();
  }
  var raf = null;
  window.addEventListener('resize', function () {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () { charts.forEach(function (c) { c.render(); }); });
  });

  // -------------------------------------------------------------- header
  var meta = DATA.meta, ban = DATA.ban, P = DATA.palette;
  document.getElementById('metric-name').textContent = meta.metricName;
  document.getElementById('metric-period').textContent =
    ban.targetRange + '  ·  vs ' + ban.comparisonRange;
  document.getElementById('metric-badge').textContent = meta.granularity + ' to date';
  document.getElementById('ban-value').textContent = ban.value;
  document.getElementById('ban-vs').textContent =
    'vs ' + ban.comparisonValue + ' (' + ban.comparisonLabel + ')';

  var dirClass = ban.direction === 'up' ? 'up' : ban.direction === 'down' ? 'down' : 'flat';
  var arrow = ban.direction === 'up' ? '▲' : ban.direction === 'down' ? '▼' : '●';
  // Pulse colors the delta by *sentiment*, not by direction: a fall can be good.
  var sentClass = ban.sentiment === 'favorable' ? 'up'
                : ban.sentiment === 'unfavorable' ? 'down' : 'flat';
  var delta = document.getElementById('ban-delta');
  delta.className = 'delta ' + sentClass;
  delta.setAttribute('data-direction', dirClass);
  var a = document.createElement('span'); a.className = 'arrow'; a.textContent = arrow;
  delta.appendChild(a);
  delta.appendChild(document.createTextNode(ban.relative + '  (' + ban.absolute + ')'));

  document.getElementById('insight-sub').textContent =
    meta.insightCount + ' insights in the bundle · ban / anchor / breakdown / followup';
  setMarkup(document.getElementById('insight-ban'), ban.markup);
  setMarkup(document.getElementById('insight-anchor'), DATA.anchor.markup);

  document.getElementById('foot-counts').textContent =
    Object.keys(meta.groupCounts).map(function (k) {
      return k + ' × ' + meta.groupCounts[k];
    }).join(', ') + ' (' + meta.insightCount + ' total)';

  // --------------------------------------------------------- bar charts
  // Handles positive-only and diverging (driver) series alike.
  function drawBars(container, w, values, opts) {
    opts = opts || {};
    var rowH = opts.rowH || 30, gap = 8, labelW = Math.min(120, Math.max(76, w * 0.22));
    var valueW = 118, padR = 4;
    var h = values.length * rowH + gap;
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h,
      role: 'img', 'aria-label': opts.label || 'bar chart'
    }, container);

    var x0 = labelW, x1 = w - valueW - padR;
    var lo = 0, hi = 0;
    values.forEach(function (d) { if (d.value < lo) lo = d.value; if (d.value > hi) hi = d.value; });
    if (hi === lo) hi = lo + 1;
    var span = hi - lo;
    var zero = x0 + (0 - lo) / span * (x1 - x0);

    values.forEach(function (d, i) {
      var y = i * rowH + 2, bh = rowH - 12;
      var xv = x0 + (d.value - lo) / span * (x1 - x0);
      var bx = Math.min(zero, xv), bw = Math.max(2, Math.abs(xv - zero));
      var fill = d.average ? P.barAverage : (d.value < 0 ? P.barNegative : P.bar);

      var g = svgEl('g', {}, svg);
      var tt = svgEl('title', {}, g);
      tt.textContent = d.entityName + ' — ' + d.formattedValue;

      svgEl('rect', {
        x: bx, y: y, width: bw, height: bh, rx: 4, ry: 4, fill: fill,
        stroke: d.average ? '#6B7280' : 'none', 'stroke-width': d.average ? 0.5 : 0
      }, g);

      // Poor man's ellipsis: SVG has no text-overflow, so clip by an estimated
      // advance width (~0.56em for this stack at 12.5px).
      var maxChars = Math.max(6, Math.floor((labelW - 14) / 6.6));
      var name = d.entityName || '';
      svgText(g, labelW - 10, y + bh / 2 + 4,
        name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name,
        { 'text-anchor': 'end', 'font-size': 12.5, fill: P.text });

      // "$1.8K (-2.8%)" -> base in neutral ink, delta tinted by sign.
      var fv = d.formattedValue || '';
      var m = fv.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      var base = m ? m[1] : fv, extra = m ? m[2] : null;
      var tx = svgEl('text', {
        x: Math.max(xv, zero) + 8, y: y + bh / 2 + 4, 'font-size': 12.5,
        'font-weight': 500, fill: P.textStrong
      }, g);
      var ts1 = svgEl('tspan', {}, tx); ts1.textContent = base;
      if (extra !== null) {
        var color = extra.indexOf('+') === 0 ? P.favorable
                  : extra.indexOf('-') === 0 && extra.length > 1 ? P.unfavorable : P.neutral;
        var ts2 = svgEl('tspan', { fill: color, dx: 5 }, tx);
        ts2.textContent = '(' + extra + ')';
      }
    });
  }

  // -------------------------------------------------------- BAN 2-bar viz
  register(document.getElementById('ban-bars'), function (c, w) {
    drawBars(c, w, ban.bars, { label: 'current vs prior period', rowH: 34 });
  });

  // ------------------------------------------------------- trend line viz
  var T = DATA.trend;
  document.getElementById('trend-title').textContent = T.question;
  document.getElementById('trend-sub').textContent =
    T.facts.grain + ' grain · ' + T.points.filter(function (p) { return !p.proj; }).length +
    ' points · trend ' + T.facts.trendDirection + ', volatility ' + T.facts.volatility;

  register(document.getElementById('trend-chart'), function (c, w) {
    var h = 260, m = { t: 18, r: 20, b: 30, l: 58 };
    var pts = T.points.slice().sort(function (a, b) { return ms(a.d) - ms(b.d); });
    var real = pts.filter(function (p) { return !p.proj; });
    var proj = pts.filter(function (p) { return p.proj; });
    var t0 = ms(pts[0].d), t1 = ms(pts[pts.length - 1].d);
    var y0 = T.yDomain[0], y1 = T.yDomain[1];
    var X = function (t) { return m.l + (t - t0) / (t1 - t0) * (w - m.l - m.r); };
    var Y = function (v) { return m.t + (y1 - v) / (y1 - y0) * (h - m.t - m.b); };

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h,
      role: 'img', 'aria-label': 'time series of ' + meta.metricName
    }, c);

    // y gridlines + labels
    T.yTicks.forEach(function (v) {
      svgEl('line', { x1: m.l, x2: w - m.r, y1: Y(v), y2: Y(v), stroke: '#E9EDF1', 'stroke-width': 1 }, svg);
      var key = v.toFixed(4);
      svgText(svg, m.l - 10, Y(v) + 4, T.yLabels[key] || String(v), {
        'text-anchor': 'end', 'font-size': 12, fill: T.colors.axisLabel
      });
    });
    // x gridlines + labels
    T.xTicks.forEach(function (iso) {
      var x = X(ms(iso));
      svgEl('line', { x1: x, x2: x, y1: m.t, y2: h - m.b, stroke: T.colors.grid, 'stroke-width': 1, 'stroke-opacity': .5 }, svg);
      svgText(svg, x, h - m.b + 18, T.xLabels[iso] || iso.slice(0, 10), {
        'text-anchor': x < w / 2 ? 'start' : 'end', 'font-size': 12, fill: T.colors.axisLabel
      });
    });

    // main line, broken at nulls (Vega-Lite drops null y, so gaps are real)
    var run = [], runs = [];
    real.forEach(function (p) {
      if (p.v === null) { if (run.length) runs.push(run); run = []; }
      else run.push(p);
    });
    if (run.length) runs.push(run);
    runs.forEach(function (r) {
      if (r.length === 1) {
        svgEl('circle', { cx: X(ms(r[0].d)), cy: Y(r[0].v), r: 3, fill: T.colors['default'] }, svg);
        return;
      }
      var dstr = r.map(function (p, i) { return (i ? 'L' : 'M') + X(ms(p.d)).toFixed(2) + ' ' + Y(p.v).toFixed(2); }).join(' ');
      svgEl('path', {
        d: dstr, fill: 'none', stroke: T.colors['default'], 'stroke-width': 2.5,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }, svg);
    });

    // dots, only when they will not merge into a blob
    var stepPx = (w - m.l - m.r) / Math.max(1, real.length);
    if (stepPx >= 6) {
      real.forEach(function (p) {
        if (p.v === null) return;
        svgEl('circle', {
          cx: X(ms(p.d)), cy: Y(p.v), r: 2.6, fill: T.colors['default'],
          stroke: '#fff', 'stroke-width': 1.2
        }, svg);
      });
    }

    // trend/projection line (isProjection === true endpoints), dashed
    if (proj.length >= 2) {
      var pd = proj.map(function (p, i) { return (i ? 'L' : 'M') + X(ms(p.d)).toFixed(2) + ' ' + Y(p.v).toFixed(2); }).join(' ');
      svgEl('path', {
        d: pd, fill: 'none', stroke: T.colors.projection, 'stroke-width': 2.5,
        'stroke-dasharray': (T.strokeDash || [6, 3]).join(' '), 'stroke-linecap': 'round'
      }, svg);
      proj.forEach(function (p) {
        svgEl('circle', { cx: X(ms(p.d)), cy: Y(p.v), r: 3.2, fill: T.colors.projection, stroke: '#fff', 'stroke-width': 1.5 }, svg);
      });
    }

    // axis baseline
    svgEl('line', { x1: m.l, x2: w - m.r, y1: h - m.b, y2: h - m.b, stroke: '#C8CED8', 'stroke-width': 1 }, svg);

    // hover: rule + dot + tooltip (tooltipMarkup comes straight from the bundle)
    var hoverable = real.filter(function (p) { return p.v !== null; });
    var rule = svgEl('line', { x1: 0, x2: 0, y1: m.t, y2: h - m.b, stroke: T.colors.hoverLine, 'stroke-opacity': .3, 'stroke-width': 1, opacity: 0 }, svg);
    var dot = svgEl('circle', { r: 5, fill: T.colors.hoverDot, opacity: 0 }, svg);
    var tip = document.getElementById('trend-tip');
    var hit = svgEl('rect', { x: m.l, y: m.t, width: Math.max(1, w - m.l - m.r), height: h - m.t - m.b, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', function (ev) {
      var box = c.getBoundingClientRect();
      var scale = w / box.width;
      var mx = (ev.clientX - box.left) * scale;
      var best = null, bd = Infinity;
      hoverable.forEach(function (p) {
        var d = Math.abs(X(ms(p.d)) - mx);
        if (d < bd) { bd = d; best = p; }
      });
      if (!best) return;
      var px = X(ms(best.d)), py = Y(best.v);
      rule.setAttribute('x1', px); rule.setAttribute('x2', px); rule.setAttribute('opacity', 1);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', 1);
      setMarkup(tip, best.tip || (best.f + ' on ' + best.dl));
      tip.style.opacity = 1;
      var half = tip.offsetWidth / 2 + 4;
      tip.style.left = Math.min(box.width - half, Math.max(half, px / scale)) + 'px';
      tip.style.top = Math.max(28, py / scale) + 'px';
    });
    hit.addEventListener('mouseleave', function () {
      rule.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.style.opacity = 0;
    });
  });

  (function () {
    var withCi = DATA.anchor.points.filter(function (p) { return p.ci0 !== null; }).length;
    document.getElementById('trend-note').textContent =
      'Gaps are days the bundle returns as null. The dashed line is the bundle’s own ' +
      'trend series (isProjection = true), not a forecast. The expected-range band is not ' +
      'overlaid here: the anchor insight carries ci0/ci1 for only ' + withCi +
      ' rows, all inside the current month, so it is drawn on its own axis below.';
    var lg = document.getElementById('trend-legend');
    [['Actual', T.colors['default'], 'line'], ['Trend line', T.colors.projection, 'dash']].forEach(function (e) {
      var it = document.createElement('span'); it.className = 'item';
      var sw = document.createElement('span'); sw.className = 'swatch';
      sw.style.cssText = e[2] === 'dash'
        ? 'height:0;border-top:3px dashed ' + e[1] + ';border-radius:0'
        : 'height:0;border-top:3px solid ' + e[1] + ';border-radius:0';
      it.appendChild(sw);
      it.appendChild(document.createTextNode(e[0]));
      lg.appendChild(it);
    });
  })();

  // ------------------------------------------- anchor / expected range viz
  var A = DATA.anchor;
  document.getElementById('anchor-title').textContent = A.question;
  document.getElementById('anchor-sub').textContent =
    A.facts.period + ' · ' + A.facts.value + ' · ' + A.facts.unusual;

  register(document.getElementById('anchor-chart'), function (c, w) {
    var h = 220, m = { t: 18, r: 62, b: 30, l: 62 };
    var pts = A.points.slice().sort(function (a, b) { return ms(a.d) - ms(b.d); });
    var t0 = ms(pts[0].d), t1 = ms(pts[pts.length - 1].d);
    var y0 = A.yDomain[0], y1 = A.yDomain[1];
    var X = function (t) { return m.l + (t - t0) / (t1 - t0) * (w - m.l - m.r); };
    var Y = function (v) { return m.t + (y1 - v) / (y1 - y0) * (h - m.t - m.b); };

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h,
      role: 'img', 'aria-label': 'expected range for ' + meta.metricName
    }, c);

    // y gridlines + labels
    A.yTicks.forEach(function (v) {
      svgEl('line', { x1: m.l, x2: w - m.r, y1: Y(v), y2: Y(v), stroke: '#E9EDF1' }, svg);
      svgText(svg, m.l - 10, Y(v) + 4, A.yLabels[v.toFixed(4)] || String(v), {
        'text-anchor': 'end', 'font-size': 12, fill: A.colors.axisLabel
      });
    });

    // expected-range band, from ci0/ci1. Only the days with a computed CI carry
    // one; the single-day gap between them is bridged rather than split.
    var ci = [];
    var seen = {};
    pts.forEach(function (p) {
      if (p.ci0 === null || p.ci1 === null) return;
      if (seen[p.d]) return;
      seen[p.d] = 1; ci.push(p);
    });
    if (ci.length >= 2) {
      var top = ci.map(function (p, i) { return (i ? 'L' : 'M') + X(ms(p.d)).toFixed(2) + ' ' + Y(p.ci1).toFixed(2); }).join(' ');
      var bot = ci.slice().reverse().map(function (p) { return 'L' + X(ms(p.d)).toFixed(2) + ' ' + Y(p.ci0).toFixed(2); }).join(' ');
      svgEl('path', { d: top + ' ' + bot + ' Z', fill: A.colors.band, stroke: 'none' }, svg);
      // stroke only the upper/lower boundaries, not the vertical end caps
      [top, 'M' + bot.slice(1)].forEach(function (d) {
        svgEl('path', {
          d: d, fill: 'none', stroke: A.colors.line,
          'stroke-width': 0.5, 'stroke-opacity': .7
        }, svg);
      });
    }

    // line segments (Pulse groups by `segment`; a run needs >= 2 real points)
    var bySeg = {};
    pts.forEach(function (p) { (bySeg[p.seg] = bySeg[p.seg] || []).push(p); });
    Object.keys(bySeg).forEach(function (k) {
      var run = [], runs = [];
      bySeg[k].forEach(function (p) {
        if (p.v === null) { if (run.length > 1) runs.push(run); run = []; } else run.push(p);
      });
      if (run.length > 1) runs.push(run);
      runs.forEach(function (r) {
        var d = r.map(function (p, i) { return (i ? 'L' : 'M') + X(ms(p.d)) + ' ' + Y(p.v); }).join(' ');
        svgEl('path', { d: d, fill: 'none', stroke: A.colors.line, 'stroke-width': 3, 'stroke-linecap': 'round' }, svg);
      });
    });

    // x gridlines + labels (the "active" date is emphasized, as in Pulse).
    // Ticks can sit a day apart; drop labels that would collide, keeping the
    // active one.
    var ticks = A.xTicks.slice().sort(function (p, q) { return ms(p) - ms(q); });
    var kept = [];
    ticks.forEach(function (iso) {
      var x = X(ms(iso)), active = iso === A.activeDate;
      svgEl('line', {
        x1: x, x2: x, y1: m.t, y2: h - m.b,
        stroke: active ? A.colors.gridActive : A.colors.grid,
        'stroke-width': 1, 'stroke-opacity': active ? .55 : .4
      }, svg);
      var collide = kept.some(function (k) { return Math.abs(k.x - x) < 46; });
      if (collide && !active) return;
      if (collide && active) {
        kept.forEach(function (k) { if (Math.abs(k.x - x) < 46) k.node.remove(); });
        kept = kept.filter(function (k) { return Math.abs(k.x - x) >= 46; });
      }
      var node = svgText(svg, x, h - m.b + 18, A.xLabels[iso] || iso.slice(0, 10), {
        'text-anchor': 'middle', 'font-size': 12,
        'font-weight': active ? 600 : 400, fill: A.colors.axisLabel
      });
      kept.push({ x: x, node: node });
    });

    // isolated points + current value marker
    var drawn = {};
    pts.forEach(function (p) {
      if (p.v === null || drawn[p.d]) return;
      if (p.iso) {
        drawn[p.d] = 1;
        svgEl('circle', { cx: X(ms(p.d)), cy: Y(p.v), r: 5, fill: '#fff', stroke: A.colors.line, 'stroke-width': 3 }, svg);
      }
    });
    var current = null;
    pts.forEach(function (p) { if (p.v !== null && p.point) current = p; });
    if (current) {
      var cx = X(ms(current.d)), cy = Y(current.v);
      svgEl('circle', { cx: cx, cy: cy, r: 6, fill: A.colors.currentCircle, stroke: '#fff', 'stroke-width': 3 }, svg);
      svgText(svg, cx + 12, cy + 4, current.f, {
        'font-size': 13, 'font-weight': 600, fill: A.colors.currentText
      });
    }

    svgEl('line', { x1: m.l, x2: w - m.r, y1: h - m.b, y2: h - m.b, stroke: '#C8CED8' }, svg);
  });

  (function () {
    var lg = document.getElementById('anchor-legend');
    A.legend.forEach(function (e) {
      var it = document.createElement('span'); it.className = 'item';
      var sw = document.createElement('span'); sw.className = 'swatch';
      if (e.type === 'line') sw.style.cssText = 'height:0;border-top:3px solid ' + A.colors.line + ';border-radius:0';
      else sw.style.cssText = 'background:' + A.colors.band + ';border:1px solid ' + A.colors.line;
      it.appendChild(sw);
      it.appendChild(document.createTextNode(e.label));
      lg.appendChild(it);
    });
    document.getElementById('anchor-note').textContent = A.legendNote;
  })();

  // ---------------------------------------------------------- breakdowns
  var tabs = document.getElementById('bd-tabs');
  var bdMarkup = document.getElementById('bd-markup');
  var bdChart = document.getElementById('bd-chart');
  var bdIndex = 0, bdEntry = null;

  function selectBd(i) {
    bdIndex = i;
    Array.prototype.forEach.call(tabs.children, function (b, j) {
      b.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
    setMarkup(bdMarkup, DATA.breakdowns[i].markup);
    bdEntry.render();
  }
  DATA.breakdowns.forEach(function (b, i) {
    var btn = document.createElement('button');
    btn.className = 'tab'; btn.type = 'button'; btn.setAttribute('role', 'tab');
    btn.textContent = b.dimension;
    btn.addEventListener('click', function () { selectBd(i); });
    tabs.appendChild(btn);
  });
  register(bdChart, function (c, w) {
    var b = DATA.breakdowns[bdIndex];
    drawBars(c, w, b.values, { label: b.question });
  });
  bdEntry = charts[charts.length - 1];
  selectBd(0);

  // ----------------------------------------------------------- followups
  var fuList = document.getElementById('fu-list');
  document.getElementById('fu-sub').textContent =
    'Showing ' + DATA.followups.length + ' of ' + meta.followupTotal +
    ' follow-up insights returned by the bundle.';

  DATA.followups.forEach(function (f, i) {
    var acc = document.createElement('div');
    acc.className = 'acc';
    acc.setAttribute('open-state', i === 0 ? '1' : '0');

    var btn = document.createElement('button');
    btn.type = 'button';
    var q = document.createElement('span'); q.className = 'q'; q.textContent = f.question;
    var right = document.createElement('span');
    var kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = f.type;
    var chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '›';
    right.appendChild(kind); right.appendChild(document.createTextNode(' ')); right.appendChild(chev);
    btn.appendChild(q); btn.appendChild(right);

    var body = document.createElement('div'); body.className = 'body';
    var p = document.createElement('p'); p.className = 'insight';
    setMarkup(p, f.markup);
    var ch = document.createElement('div'); ch.className = 'chart';
    ch.style.marginTop = '10px';
    body.appendChild(p); body.appendChild(ch);

    btn.addEventListener('click', function () {
      var open = acc.getAttribute('open-state') === '1';
      acc.setAttribute('open-state', open ? '0' : '1');
      if (!open) entry.render();
    });

    acc.appendChild(btn); acc.appendChild(body);
    fuList.appendChild(acc);
    register(ch, function (c, w) { drawBars(c, w, f.values, { label: f.question }); });
    var entry = charts[charts.length - 1];
  });

  // ------------------------------------------------- sanitizer self-test
  (function () {
    window.__pwned = false;
    var out = document.getElementById('probe-out');
    setMarkup(out, DATA.sanitizerProbe);
    var html = out.innerHTML;
    var clean = !window.__pwned
      && html.indexOf('<script') === -1
      && html.indexOf('__pwned') === -1
      && html.indexOf('onerror') === -1
      && html.indexOf('onclick') === -1
      && html.indexOf('onmouseover') === -1
      && html.indexOf('<img') === -1
      && html.indexOf('<a ') === -1
      && html.indexOf('Metric') !== -1
      && html.indexOf('Entity') !== -1;
    var res = document.getElementById('probe-result');
    res.textContent = clean
      ? 'PASSED — script subtree dropped; img/anchor/event handlers stripped; allowlisted spans kept'
      : 'FAILED';
    res.className = clean ? 'ok' : 'bad';
  })();
})();
</script>
</body>
</html>
"""


def main():
    payload = build_payload()
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    # `<` only ever appears inside JSON string literals here, so escaping it
    # keeps the JSON valid while making `</script>` impossible to emit.
    safe = raw.replace('<', '\\u003c')
    html = TEMPLATE.replace('__PULSE_DATA__', safe)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)

    print('wrote %s' % OUT)
    print('  html bytes   : %d (%.1f KB)' % (len(html.encode('utf-8')), len(html.encode('utf-8')) / 1024))
    print('  payload bytes: %d (%.1f KB)' % (len(safe.encode('utf-8')), len(safe.encode('utf-8')) / 1024))
    print('  source bundle: %d bytes' % os.path.getsize(SRC))
    for k in ('ban', 'trend', 'anchor', 'breakdowns', 'followups'):
        sub = json.dumps(payload[k], ensure_ascii=False, separators=(',', ':'))
        print('    %-11s %6d bytes' % (k, len(sub.encode('utf-8'))))


if __name__ == '__main__':
    main()
