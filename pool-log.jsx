import { useState, useEffect, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, ReferenceArea
} from 'recharts';
import {
  Plus, Trash2, ChevronDown, ChevronUp, AlertCircle, CheckCircle2, X, Pencil,
  Droplets, Sparkles, RefreshCw, ArrowRight, Beaker, Camera, Download, Upload
} from 'lucide-react';

/* ---------- Brand palette ----------
   Deep Stone   stone-900  #1c1917  headings, primary text
   Pool Teal    teal-700   #0f766e  primary actions, brand accent, "trusted/adjusted" tag
   Leaf Green   emerald-*  #047857  in-range / ok / trusted calibration
   Sun Gold     amber-*    #b45309  low / caution / noisy calibration
   Coral Red    red-*      #991b1b  high / alert / inconsistent calibration
   Tide Orange  orange-*   #c2410c  calibration gone stale, needs re-verifying
   Sand         stone-50   #fafaf9  app background, neutral surfaces
   White        white      #ffffff  cards
   Every status/trust color in the UI maps to one of these six accents —
   no ad hoc hues outside this set.
------------------------------------ */

/* ---------- Constants ---------- */

const PARAMS = {
  fc:  { label: 'Free Chlorine',     short: 'FC',  unit: 'ppm', step: 0.1, decimals: 1, scale: [0, 8]   },
  tc:  { label: 'Total Chlorine',    short: 'TC',  unit: 'ppm', step: 0.1, decimals: 1, scale: [0, 8]   },
  ph:  { label: 'pH',                short: 'pH',  unit: '',    step: 0.1, decimals: 1, scale: [6, 9]   },
  ta:  { label: 'Total Alkalinity',  short: 'TA',  unit: 'ppm', step: 1,   decimals: 0, scale: [0, 200] },
  ch:  { label: 'Calcium Hardness',  short: 'CH',  unit: 'ppm', step: 10,  decimals: 0, scale: [0, 700] },
  cya: { label: 'Cyanuric Acid',     short: 'CYA', unit: 'ppm', step: 1,   decimals: 0, scale: [0, 100] },
};

const PARAM_KEYS = Object.keys(PARAMS);

const DEFAULT_TARGETS = {
  fc:  { min: 1,   max: 4,   target: 2.5 },
  tc:  { min: 1,   max: 4,   target: 2.5 },
  ph:  { min: 7.2, max: 7.8, target: 7.5 },
  ta:  { min: 80,  max: 120, target: 100 },
  ch:  { min: 200, max: 500, target: 350 },
  cya: { min: 20,  max: 50,  target: 35  },
};

const SOURCES = [
  { value: 'pool-store',  label: 'Pool Store (ClearCare)', tier: 1, isReference: true },
  { value: 'photometer',  label: 'AquaDoc Photometer',     tier: 2 },
  { value: 'hydrocomm',   label: 'HydroComm Monitor',      tier: 4 },
  { value: 'manual-kit',  label: 'Manual Test Kit',        tier: 3 },
  { value: 'strip-reader',label: 'Eagle Ray Strip Reader', tier: 3 },
  { value: 'strips',      label: 'Test Strips',            tier: 4 },
];

const sourceLabel = (v) => SOURCES.find(s => s.value === v)?.label ?? v;
const sourceTier  = (v) => SOURCES.find(s => s.value === v)?.tier ?? 5;
const isReference = (v) => SOURCES.find(s => s.value === v)?.isReference === true;

const PAIR_WINDOW_HOURS = 24; // pair readings within this window for calibration
const STD_THRESHOLDS = { fc: 0.4, tc: 0.4, ph: 0.15, ta: 12, ch: 35, cya: 8 };
const STALE_AFTER_DAYS = 45; // re-verify trust if no fresh reference pair in this long

/* ---------- Helpers ---------- */

function status(value, range) {
  if (value == null || isNaN(value)) return 'none';
  if (value < range.min) return 'low';
  if (value > range.max) return 'high';
  return 'ok';
}

const STATUS_STYLES = {
  ok:   { dot: 'bg-emerald-700', text: 'text-emerald-800', bg: 'bg-emerald-50',  ring: 'ring-emerald-200' },
  low:  { dot: 'bg-amber-600',   text: 'text-amber-800',   bg: 'bg-amber-50',    ring: 'ring-amber-200' },
  high: { dot: 'bg-red-800',     text: 'text-red-900',     bg: 'bg-red-50',      ring: 'ring-red-200' },
  none: { dot: 'bg-stone-300',   text: 'text-stone-500',   bg: 'bg-stone-50',    ring: 'ring-stone-200' },
};

function fmt(v, p) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(PARAMS[p].decimals);
}

function fmtOffset(v, p) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return sign + Number(v).toFixed(PARAMS[p].decimals);
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/* ---------- Calibration logic ---------- */

function computeCalibrations(readings) {
  const refReadings = readings.filter(r => isReference(r.source));
  const deviceReadings = readings.filter(r => !isReference(r.source));
  const result = {};
  const windowMs = PAIR_WINDOW_HOURS * 3600 * 1000;

  // Each device reading pairs with its single nearest reference reading within the
  // window, not every reference in range — otherwise one device reading counted
  // against several nearby ref readings inflates n and skews mean/stdDev.
  for (const candidate of deviceReadings) {
    let nearestRef = null;
    let nearestDiff = Infinity;
    for (const ref of refReadings) {
      const diff = Math.abs(ref.timestamp - candidate.timestamp);
      if (diff <= windowMs && diff < nearestDiff) {
        nearestRef = ref;
        nearestDiff = diff;
      }
    }
    if (!nearestRef) continue;
    for (const p of PARAM_KEYS) {
      if (nearestRef[p] != null && candidate[p] != null) {
        if (!result[candidate.source]) result[candidate.source] = {};
        if (!result[candidate.source][p]) result[candidate.source][p] = { pairs: [] };
        result[candidate.source][p].pairs.push({
          deviceValue: candidate[p],
          refValue: nearestRef[p],
          offset: nearestRef[p] - candidate[p],
          refAt: nearestRef.timestamp,
          deviceAt: candidate.timestamp,
        });
      }
    }
  }

  for (const src in result) {
    for (const p in result[src]) {
      const pairs = result[src][p].pairs;
      const offsets = pairs.map(x => x.offset);
      const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
      const variance = offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / offsets.length;
      const stdDev = Math.sqrt(variance);
      const signs = offsets.map(o => Math.sign(o)).filter(s => s !== 0);
      const signConsistent = signs.length === 0 || signs.every(s => s === signs[0]);
      const refValues = pairs.map(x => x.refValue);
      result[src][p] = {
        ...result[src][p],
        meanOffset: +mean.toFixed(3),
        stdDev: +stdDev.toFixed(3),
        n: pairs.length,
        signConsistent,
        latestPairAt: Math.max(...pairs.map(x => x.refAt)),
        refRange: { min: Math.min(...refValues), max: Math.max(...refValues) },
      };
    }
  }
  return result;
}

function trustLevel(cal, param) {
  if (!cal || cal.n === 0) return 'none';
  if (cal.n === 1) return 'insufficient';
  if (!cal.signConsistent) return 'inconsistent';
  if (cal.n < 3) return 'developing';
  if (cal.stdDev > (STD_THRESHOLDS[param] ?? 1)) return 'noisy';
  const daysSincePair = (Date.now() - cal.latestPairAt) / 86400000;
  if (daysSincePair > STALE_AFTER_DAYS) return 'stale';
  return 'trusted';
}

const TRUST_INFO = {
  trusted:      { label: 'Trusted',          color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  stale:        { label: 'Re-verify',        color: 'bg-orange-100 text-orange-800 border-orange-200' },
  developing:   { label: 'Developing',       color: 'bg-teal-100 text-teal-800 border-teal-200' },
  noisy:        { label: 'High variance',    color: 'bg-amber-100 text-amber-800 border-amber-200' },
  inconsistent: { label: 'Sign flipped',     color: 'bg-red-100 text-red-800 border-red-200' },
  insufficient: { label: 'Need more pairs',  color: 'bg-stone-100 text-stone-600 border-stone-200' },
  none:         { label: 'No data',          color: 'bg-stone-100 text-stone-500 border-stone-200' },
};

function adjustedValue(rawValue, cal, param) {
  if (rawValue == null || cal == null) return null;
  const tl = trustLevel(cal, param);
  if (tl === 'none' || tl === 'insufficient' || tl === 'inconsistent' || tl === 'stale') return null;
  return rawValue + cal.meanOffset;
}

/* ---------- UI primitives ---------- */

function RangeBar({ value, range, scale }) {
  const [sMin, sMax] = scale;
  const span = sMax - sMin;
  const inStart = ((range.min - sMin) / span) * 100;
  const inWidth = ((range.max - range.min) / span) * 100;
  const targetPos = ((range.target - sMin) / span) * 100;
  const hasValue = value != null && !isNaN(value);
  const valuePos = hasValue ? Math.min(100, Math.max(0, ((value - sMin) / span) * 100)) : null;
  const st = status(value, range);
  return (
    <div className="relative h-5 w-full">
      <div className="absolute top-1/2 left-0 right-0 h-[3px] -translate-y-1/2 bg-stone-200 rounded-full" />
      <div className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-emerald-200 rounded-full"
           style={{ left: `${inStart}%`, width: `${inWidth}%` }} />
      <div className="absolute top-1/2 h-[7px] w-px -translate-y-1/2 bg-emerald-700/60"
           style={{ left: `${targetPos}%` }} />
      {hasValue && (
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${valuePos}%` }}>
          <div className={`w-3.5 h-3.5 rounded-full border-2 border-white shadow ${STATUS_STYLES[st].dot}`} />
        </div>
      )}
    </div>
  );
}

function ParamRow({ p, value, range, adjusted }) {
  const displayValue = adjusted != null ? adjusted : value;
  const st = status(displayValue, range);
  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium tracking-wider uppercase text-stone-500">{PARAMS[p].short}</span>
          <span className="text-xs text-stone-400 hidden sm:inline">{PARAMS[p].label}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          {adjusted != null && value != null && (
            <span className="text-xs text-stone-400 font-mono tabular-nums line-through">
              {fmt(value, p)}
            </span>
          )}
          <span className={`font-mono text-lg tabular-nums ${STATUS_STYLES[st].text}`}>
            {fmt(displayValue, p)}
          </span>
          {PARAMS[p].unit && <span className="text-xs text-stone-400">{PARAMS[p].unit}</span>}
        </div>
      </div>
      <RangeBar value={displayValue} range={range} scale={PARAMS[p].scale} />
      <div className="flex justify-between mt-1">
        <span className="text-[10px] tabular-nums text-stone-400">{range.min}</span>
        <span className="text-[10px] tabular-nums text-stone-400">{range.max}</span>
      </div>
    </div>
  );
}

/* ---------- Status card ---------- */

function StatusCard({ latest, targets, calibrations }) {
  if (!latest) {
    return (
      <div className="bg-white border border-stone-200 rounded-lg p-6 text-center">
        <Droplets className="w-8 h-8 mx-auto text-stone-300 mb-2" />
        <p className="text-sm text-stone-500">No readings yet. Log your first test to begin.</p>
      </div>
    );
  }
  const srcCal = calibrations[latest.source];
  const usesAdjusted = !isReference(latest.source) && srcCal;
  const issues = PARAM_KEYS.map(p => {
    const adj = usesAdjusted ? adjustedValue(latest[p], srcCal?.[p], p) : null;
    const eff = adj != null ? adj : latest[p];
    return { p, st: status(eff, targets[p]) };
  }).filter(x => x.st === 'low' || x.st === 'high');

  const fcEff = usesAdjusted ? adjustedValue(latest.fc, srcCal?.fc, 'fc') ?? latest.fc : latest.fc;
  const tcEff = usesAdjusted ? adjustedValue(latest.tc, srcCal?.tc, 'tc') ?? latest.tc : latest.tc;
  const cc = fcEff != null && tcEff != null ? +(tcEff - fcEff).toFixed(2) : null;
  const ccWarn = cc != null && cc > 0.5;

  return (
    <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-0.5">Last reading</div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-stone-900">{relTime(latest.timestamp)}</span>
            <span className="text-xs text-stone-500">· {sourceLabel(latest.source)}</span>
            {usesAdjusted && (
              <span className="text-[10px] uppercase tracking-wider bg-teal-50 text-teal-700 border border-teal-200 px-1.5 py-0.5 rounded">
                Adjusted
              </span>
            )}
          </div>
        </div>
        {issues.length === 0 ? (
          <div className="flex items-center gap-1.5 text-emerald-700 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4" />
            All in range
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-amber-800 text-xs font-medium">
            <AlertCircle className="w-4 h-4" />
            {issues.length} out of range
          </div>
        )}
      </div>
      <div className="px-5 divide-y divide-stone-100">
        {PARAM_KEYS.map(p => {
          const adj = usesAdjusted ? adjustedValue(latest[p], srcCal?.[p], p) : null;
          return <ParamRow key={p} p={p} value={latest[p]} adjusted={adj} range={targets[p]} />;
        })}
      </div>
      {cc != null && (
        <div className={`px-5 py-3 border-t flex items-center justify-between text-xs ${ccWarn ? 'bg-amber-50 border-amber-200' : 'bg-stone-50 border-stone-100'}`}>
          <span className={ccWarn ? 'text-amber-900' : 'text-stone-600'}>
            Combined chlorine (TC − FC)
          </span>
          <span className={`font-mono tabular-nums font-medium ${ccWarn ? 'text-amber-900' : 'text-stone-700'}`}>
            {cc.toFixed(2)} ppm {ccWarn && '· high'}
          </span>
        </div>
      )}
      {usesAdjusted && (
        <div className="px-5 py-2.5 bg-teal-50/50 border-t border-teal-100 text-[11px] text-teal-800">
          Values shown adjusted to pool-store equivalent using calibration data. Raw reading struck through.
        </div>
      )}
    </div>
  );
}

/* ---------- Entry form (with calibration preview) ---------- */

function EntryForm({ onSave, onCancel, calibrations }) {
  const now = new Date();
  const localISO = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [values, setValues] = useState({});
  const [source, setSource] = useState('photometer');
  const [when, setWhen] = useState(localISO);
  const [notes, setNotes] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);
  const [extractedFrom, setExtractedFrom] = useState(null);

  const update = (k, v) => setValues(prev => ({ ...prev, [k]: v }));

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const result = await extractFromImage(file);
      const next = {};
      PARAM_KEYS.forEach(p => {
        if (typeof result[p] === 'number' && !isNaN(result[p])) {
          next[p] = String(result[p]);
        }
      });
      setValues(prev => ({ ...prev, ...next }));
      if (result.source && SOURCES.some(s => s.value === result.source)) {
        setSource(result.source);
      }
      if (result.notes) {
        setNotes(prev => prev ? `${prev} · ${result.notes}` : result.notes);
      }
      setExtractedFrom({
        confidence: result.confidence || 'medium',
        count: Object.keys(next).length,
      });
    } catch (err) {
      const msg = err.message || '';
      setExtractError(msg.includes('no chemistry')
        ? "No pool chemistry data found in that image."
        : "Couldn't extract values from photo. Try a clearer image or enter manually below.");
    } finally {
      setExtracting(false);
    }
  };
  const srcCal = calibrations[source];
  const showAdjustments = !isReference(source) && srcCal;

  const save = () => {
    const parsed = {};
    PARAM_KEYS.forEach(p => {
      const v = values[p];
      if (v != null && v !== '') {
        const n = parseFloat(v);
        if (!isNaN(n)) parsed[p] = n;
      }
    });
    onSave({
      id: `r_${Date.now()}`,
      timestamp: new Date(when).getTime(),
      source,
      notes: notes.trim(),
      ...parsed,
    });
  };

  const hasAny = PARAM_KEYS.some(p => values[p] != null && values[p] !== '');

  return (
    <div className="bg-white border border-stone-200 rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-stone-900">New reading</h2>
        <button onClick={onCancel} className="p-1 text-stone-400 hover:text-stone-600">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="mb-4 p-3 bg-gradient-to-br from-teal-50 to-stone-50 border border-teal-200 rounded-lg">
        {extracting ? (
          <div className="flex items-center justify-center gap-2 text-sm text-teal-800 py-2">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Reading values from photo…
          </div>
        ) : (
          <>
            <label className="flex items-center justify-center gap-2 px-3 py-2 bg-white border border-teal-300 rounded-md text-sm font-medium text-teal-800 hover:bg-teal-50 cursor-pointer transition-colors">
              <Camera className="w-4 h-4" />
              Extract from photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoUpload}
                className="hidden"
              />
            </label>
            <p className="text-[11px] text-stone-500 text-center mt-1.5">
              Photometer screen, HydroComm app, pool store printout, or test strip
            </p>
            {extractedFrom && (
              <div className="mt-2 px-2 py-1.5 bg-emerald-50 border border-emerald-200 rounded text-[11px] text-emerald-800 flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                <span>
                  Read {extractedFrom.count} value{extractedFrom.count === 1 ? '' : 's'} from photo · {extractedFrom.confidence} confidence · review and adjust below before saving
                </span>
              </div>
            )}
            {extractError && (
              <div className="mt-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[11px] text-red-800">
                {extractError}
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1">Source</label>
          <select value={source} onChange={e => setSource(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600">
            {SOURCES.map(s => (
              <option key={s.value} value={s.value}>{s.label}{s.isReference ? ' — reference' : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1">When</label>
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600" />
        </div>
      </div>
      <div className="space-y-2 mb-4">
        {PARAM_KEYS.map(p => {
          const raw = values[p] !== '' && values[p] != null ? parseFloat(values[p]) : null;
          const cal = srcCal?.[p];
          const adj = showAdjustments && raw != null ? adjustedValue(raw, cal, p) : null;
          return (
            <div key={p}>
              <div className="flex items-center gap-3">
                <label className="w-12 text-xs font-medium text-stone-500 uppercase tracking-wider">{PARAMS[p].short}</label>
                <input type="number" inputMode="decimal" step={PARAMS[p].step}
                  value={values[p] ?? ''} onChange={e => update(p, e.target.value)} placeholder="—"
                  className="flex-1 px-3 py-2 text-sm font-mono tabular-nums bg-stone-50 border border-stone-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600" />
                <span className="w-8 text-xs text-stone-400">{PARAMS[p].unit}</span>
              </div>
              {adj != null && (
                <div className="ml-[3.75rem] mt-1 text-[11px] text-teal-700 flex items-center gap-1">
                  <ArrowRight className="w-3 h-3" />
                  ≈ <span className="font-mono tabular-nums font-medium">{fmt(adj, p)}</span>
                  <span className="text-stone-400">pool-store equiv ({fmtOffset(cal.meanOffset, p)} offset, n={cal.n})</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mb-4">
        <label className="block text-xs font-medium text-stone-600 mb-1">Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          placeholder="Optional — weather, recent dosing, observations…"
          className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600 resize-none" />
      </div>
      {isReference(source) && (
        <div className="mb-4 px-3 py-2 bg-teal-50 border border-teal-200 rounded text-xs text-teal-900 flex gap-2">
          <Beaker className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Saving this as a reference reading will create calibration pairs with any device readings logged within {PAIR_WINDOW_HOURS}h.</span>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={save} disabled={!hasAny}
          className="flex-1 px-4 py-2.5 bg-teal-700 text-white text-sm font-medium rounded-md hover:bg-teal-800 disabled:bg-stone-200 disabled:text-stone-400 disabled:cursor-not-allowed">
          Save reading
        </button>
        <button onClick={onCancel} className="px-4 py-2.5 text-stone-600 text-sm font-medium hover:bg-stone-100 rounded-md">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---------- Calibration card ---------- */

function CalibrationCard({ calibrations, latestBySource }) {
  const sources = Object.keys(calibrations).sort((a, b) => sourceTier(a) - sourceTier(b));
  const [open, setOpen] = useState(true);

  if (sources.length === 0) {
    return (
      <div className="bg-white border border-stone-200 rounded-lg p-5">
        <div className="flex items-center gap-2 mb-2">
          <Beaker className="w-4 h-4 text-stone-400" />
          <h2 className="text-base font-semibold text-stone-900">Device calibration</h2>
        </div>
        <p className="text-sm text-stone-500">
          Log a pool store reading and at least one device reading within {PAIR_WINDOW_HOURS}h to start building calibration offsets.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50">
        <div className="flex items-center gap-2">
          <Beaker className="w-4 h-4 text-stone-500" />
          <span className="text-sm font-medium text-stone-900">Device calibration</span>
          <span className="text-xs text-stone-500">vs pool store</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
      </button>
      {open && (
        <div className="border-t border-stone-100 divide-y divide-stone-100">
          {sources.map(src => (
            <DeviceCalibrationSection key={src} source={src} cal={calibrations[src]} latestReading={latestBySource[src]} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceCalibrationSection({ source, cal, latestReading }) {
  const params = PARAM_KEYS.filter(p => cal[p] && cal[p].n > 0);
  return (
    <div className="px-5 py-4">
      <div className="text-sm font-medium text-stone-800 mb-3">{sourceLabel(source)}</div>
      <div className="space-y-2.5">
        {params.map(p => {
          const c = cal[p];
          const tl = trustLevel(c, p);
          const ti = TRUST_INFO[tl];
          const latestRaw = latestReading?.[p];
          const latestAdj = latestRaw != null ? adjustedValue(latestRaw, c, p) : null;
          return (
            <div key={p} className="grid grid-cols-12 gap-2 items-center text-xs">
              <div className="col-span-1 font-medium text-stone-700 uppercase tracking-wider">{PARAMS[p].short}</div>
              <div className="col-span-4 flex items-baseline gap-1 font-mono tabular-nums">
                {latestRaw != null ? (
                  <>
                    <span className="text-stone-700">{fmt(latestRaw, p)}</span>
                    {latestAdj != null ? (
                      <>
                        <ArrowRight className="w-3 h-3 text-stone-400 self-center" />
                        <span className="text-teal-700 font-semibold">{fmt(latestAdj, p)}</span>
                      </>
                    ) : (
                      <span className="text-stone-400 text-[10px]">no adj</span>
                    )}
                  </>
                ) : (
                  <span className="text-stone-400">— last reading</span>
                )}
              </div>
              <div className="col-span-3 font-mono tabular-nums text-stone-600">
                offset {fmtOffset(c.meanOffset, p)}
                {c.n >= 2 && <span className="text-stone-400"> ±{fmt(c.stdDev, p)}</span>}
              </div>
              <div className="col-span-1 font-mono tabular-nums text-stone-500">n={c.n}</div>
              <div className={`col-span-3 text-[10px] uppercase tracking-wider border rounded px-1.5 py-0.5 text-center ${ti.color}`}>
                {ti.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- AI analysis ---------- */

function buildPrompt(readings, targets, calibrations) {
  const lines = [];
  lines.push("You're helping me figure out which of my at-home pool test devices I can trust as substitutes for pool store testing. Goal: minimize trips to the pool store while keeping water safe.");
  lines.push("");
  lines.push("Pool: 25,000 gal residential unpainted plaster, sand filter.");
  lines.push("Devices: AquaDoc Photometer (with strips, reads FC/TC/pH/TA/CH/CYA), Aiper HydroComm (in-pool, pH/ORP/TDS/temp only — no chlorine).");
  lines.push("Reference: Pool store ClearCare software.");
  lines.push("");
  lines.push("Target ranges:");
  PARAM_KEYS.forEach(p => {
    const r = targets[p];
    lines.push(`- ${PARAMS[p].short} (${PARAMS[p].label}): ${r.min}–${r.max} ${PARAMS[p].unit}`);
  });
  lines.push("");

  const sources = Object.keys(calibrations);
  if (sources.length === 0) {
    lines.push("CALIBRATION DATA: none yet (no paired pool-store + device readings).");
  } else {
    lines.push("CALIBRATION DATA (offset = pool_store_value − device_value, applied additively):");
    sources.forEach(src => {
      lines.push(`  ${sourceLabel(src)}:`);
      PARAM_KEYS.forEach(p => {
        const c = calibrations[src][p];
        if (c && c.n > 0) {
          const tl = trustLevel(c, p);
          lines.push(`    ${PARAMS[p].short}: offset ${fmtOffset(c.meanOffset, p)}, n=${c.n}, σ=${c.stdDev.toFixed(2)}, sign-consistent=${c.signConsistent}, ref values tested ${c.refRange.min.toFixed(1)}–${c.refRange.max.toFixed(1)}, last paired ${new Date(c.latestPairAt).toLocaleDateString()}, current trust: ${tl}`);
        }
      });
    });
  }
  lines.push("");

  const recent = [...readings].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  if (recent.length > 0) {
    lines.push("RECENT READINGS (newest first):");
    recent.forEach(r => {
      const vals = PARAM_KEYS.filter(p => r[p] != null).map(p => `${PARAMS[p].short} ${fmt(r[p], p)}`).join(', ');
      lines.push(`  ${new Date(r.timestamp).toLocaleDateString()} ${sourceLabel(r.source)}: ${vals}${r.notes ? ` — "${r.notes}"` : ''}`);
    });
  }
  lines.push("");

  lines.push("In 180 words or less, plain prose (no headers, no bullets, no markdown), answer:");
  lines.push("1. For each device + parameter, can I trust the offset, or do I need more paired data?");
  lines.push("2. Any odd patterns — sign flips, drift, high variance, or stale data?");
  lines.push("3. Bottom line: should I take water to the pool store this week, or are device readings with offsets reliable enough?");
  lines.push("Be direct and specific. Reference actual numbers from the data.");
  lines.push("Free Chlorine (FC) is a swimmer-safety parameter, not just a comfort one — be more conservative recommending trust on FC offsets than on cosmetic parameters like CYA or CH, and say so explicitly if FC calibration is thin or stale.");

  return lines.join("\n");
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === 'string') resolve(r.split(',')[1]);
      else reject(new Error('Read returned non-string'));
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const EXTRACTION_PROMPT = `You're a vision assistant for a pool chemistry log. Examine this image and extract test result values.

The image is likely one of:
- AquaDoc Photometer LCD — labels TCL (total chlorine), TH (total hardness/calcium), FCL (free chlorine), CyA, Alk, pH, ppm units
- HydroComm app screen — pH, ORP(mV), TDS, Temperature on Good/Fair/Poor colored bars
- Pool store ClearCare printout
- Test strip color comparison
- Manual test kit color comparator

Return ONLY a valid JSON object on a single line. No markdown fences. No commentary. Include only keys for values clearly visible.

Schema:
{
  "fc": number,          // Free Chlorine ppm (photometer FCL — first number, not bromine value in parens)
  "tc": number,          // Total Chlorine ppm (photometer TCL)
  "ph": number,
  "ta": number,          // Total Alkalinity ppm (Alk)
  "ch": number,          // Calcium Hardness ppm (photometer TH)
  "cya": number,         // Cyanuric Acid ppm
  "source": string,      // "pool-store" | "photometer" | "hydrocomm" | "strips" | "manual-kit"
  "notes": string,       // anything notable, e.g. "CYA reported as <40", "ORP 593 mV from HydroComm"
  "confidence": "high" | "medium" | "low"
}

For "<X" notation (e.g. CYA <40), use the numeric value and mention "<" in notes.
If image doesn't show pool chemistry data, return: {"error": "no chemistry data visible"}`;

async function extractFromImage(file) {
  const base64 = await fileToBase64(file);
  const mediaType = file.type || 'image/jpeg';
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: EXTRACTION_PROMPT }
        ]
      }]
    })
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  const data = await response.json();
  const text = data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(clean);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

async function runAIAnalysis({ readings, targets, calibrations }) {
  const prompt = buildPrompt(readings, targets, calibrations);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  const data = await response.json();
  return data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}

function AIAnalysisCard({ readings, targets, calibrations }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get('pool-ai-analysis');
        if (r?.value) setAnalysis(JSON.parse(r.value));
      } catch (e) { /* none cached */ }
    })();
  }, []);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await runAIAnalysis({ readings, targets, calibrations });
      const next = { text, timestamp: Date.now() };
      setAnalysis(next);
      await window.storage.set('pool-ai-analysis', JSON.stringify(next));
    } catch (e) {
      setError("Couldn't reach the analysis service. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  };

  const noData = readings.length === 0;

  return (
    <div className="bg-gradient-to-br from-teal-50 to-stone-50 border border-teal-200 rounded-lg p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-teal-700" />
          <h2 className="text-base font-semibold text-stone-900">Calibration analysis</h2>
        </div>
        {analysis && (
          <span className="text-[10px] text-stone-500">{relTime(analysis.timestamp)}</span>
        )}
      </div>

      {!analysis && !loading && (
        <p className="text-sm text-stone-600 mb-3">
          Get an AI assessment of your calibration: which device readings can be trusted with offsets applied, which need more paired data, and whether you should take water to the pool store.
        </p>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-stone-500 py-4">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Analyzing your data…
        </div>
      )}

      {analysis && !loading && (
        <div className="text-sm text-stone-700 whitespace-pre-wrap leading-relaxed mb-3">
          {analysis.text}
        </div>
      )}

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">
          {error}
        </div>
      )}

      <button onClick={run} disabled={loading || noData}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-700 text-white text-xs font-medium rounded-md hover:bg-teal-800 disabled:bg-stone-200 disabled:text-stone-400">
        {analysis ? <RefreshCw className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
        {analysis ? 'Refresh analysis' : 'Run analysis'}
      </button>
      {noData && (
        <span className="ml-2 text-xs text-stone-500">Log a reading first.</span>
      )}
    </div>
  );
}

/* ---------- History ---------- */

function HistoryRow({ reading, targets, calibrations, onDelete, expanded, onToggle }) {
  const srcCal = calibrations[reading.source];
  const usesAdjusted = !isReference(reading.source) && srcCal;
  const issues = PARAM_KEYS.map(p => {
    const adj = usesAdjusted ? adjustedValue(reading[p], srcCal?.[p], p) : null;
    const eff = adj != null ? adj : reading[p];
    return { p, st: status(eff, targets[p]) };
  }).filter(x => x.st === 'low' || x.st === 'high');

  return (
    <div className="border-b border-stone-100 last:border-b-0">
      <button onClick={onToggle} className="w-full px-5 py-3 text-left hover:bg-stone-50 flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-stone-900">
              {new Date(reading.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
            <span className="text-xs text-stone-500">
              {new Date(reading.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${isReference(reading.source) ? 'bg-teal-100 text-teal-800' : 'bg-stone-100 text-stone-600'}`}>
              {isReference(reading.source) ? 'Ref' : `T${sourceTier(reading.source)}`}
            </span>
          </div>
          <div className="text-xs text-stone-500 mt-0.5 truncate">{sourceLabel(reading.source)}</div>
        </div>
        <div className="flex items-center gap-2">
          {issues.length === 0 ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          ) : (
            <span className="flex items-center gap-1 text-xs text-amber-700">
              <AlertCircle className="w-3.5 h-3.5" />
              {issues.length}
            </span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
        </div>
      </button>
      {expanded && (
        <div className="px-5 pb-4 bg-stone-50/50">
          <div className="grid grid-cols-3 gap-3 mb-3">
            {PARAM_KEYS.map(p => {
              const adj = usesAdjusted ? adjustedValue(reading[p], srcCal?.[p], p) : null;
              const eff = adj != null ? adj : reading[p];
              const st = status(eff, targets[p]);
              return (
                <div key={p} className="text-center">
                  <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-0.5">{PARAMS[p].short}</div>
                  <div className={`text-base font-mono tabular-nums ${STATUS_STYLES[st].text}`}>
                    {fmt(reading[p], p)}
                  </div>
                  {adj != null && (
                    <div className="text-[10px] text-teal-700 font-mono tabular-nums">→ {fmt(adj, p)}</div>
                  )}
                </div>
              );
            })}
          </div>
          {reading.notes && (
            <div className="text-xs text-stone-600 italic pt-2 border-t border-stone-200 mb-2">
              {reading.notes}
            </div>
          )}
          <button onClick={() => onDelete(reading.id)}
            className="flex items-center gap-1.5 text-xs text-red-700 hover:text-red-900 mt-2">
            <Trash2 className="w-3.5 h-3.5" />
            Delete reading
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Trends ---------- */

function Trends({ readings, targets }) {
  const [selectedParam, setSelectedParam] = useState('fc');
  const range = targets[selectedParam];
  const [sMin, sMax] = PARAMS[selectedParam].scale;

  const chartData = useMemo(() => {
    return [...readings]
      .filter(r => r[selectedParam] != null)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(r => ({
        ts: r.timestamp,
        dateLabel: new Date(r.timestamp).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
        value: r[selectedParam],
        source: r.source,
      }));
  }, [readings, selectedParam]);

  if (readings.length === 0) return null;

  return (
    <div className="bg-white border border-stone-200 rounded-lg p-5">
      <h2 className="text-base font-semibold text-stone-900 mb-4">Trend</h2>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {PARAM_KEYS.map(p => (
          <button key={p} onClick={() => setSelectedParam(p)}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
              selectedParam === p ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
            }`}>
            {PARAMS[p].short}
          </button>
        ))}
      </div>
      {chartData.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-sm text-stone-400">
          No data for {PARAMS[selectedParam].short}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 16, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid stroke="#e7e5e4" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="dateLabel" stroke="#a8a29e" fontSize={11} tickLine={false} axisLine={{ stroke: '#e7e5e4' }} />
            <YAxis stroke="#a8a29e" fontSize={11} tickLine={false} axisLine={false} domain={[sMin, sMax]} />
            <ReferenceArea y1={range.min} y2={range.max} fill="#a7f3d0" fillOpacity={0.3} />
            <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e7e5e4', borderRadius: '6px', fontSize: '12px' }}
              formatter={(value) => [fmt(value, selectedParam) + ' ' + PARAMS[selectedParam].unit, PARAMS[selectedParam].short]} />
            <Line type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={2}
              dot={{ r: 3, fill: '#0f766e', strokeWidth: 0 }} activeDot={{ r: 5, fill: '#0f766e' }} />
          </LineChart>
        </ResponsiveContainer>
      )}
      <div className="text-[10px] text-stone-400 mt-2 text-center">
        Shaded band shows in-range target ({range.min}–{range.max} {PARAMS[selectedParam].unit})
      </div>
    </div>
  );
}

/* ---------- Targets editor ---------- */

function targetsToStrings(targets) {
  const out = {};
  PARAM_KEYS.forEach(p => {
    out[p] = { min: String(targets[p].min), target: String(targets[p].target), max: String(targets[p].max) };
  });
  return out;
}

function validateTargets(local) {
  for (const p of PARAM_KEYS) {
    const [sMin, sMax] = PARAMS[p].scale;
    const min = parseFloat(local[p].min);
    const target = parseFloat(local[p].target);
    const max = parseFloat(local[p].max);
    if ([min, target, max].some(v => isNaN(v))) return `${PARAMS[p].short}: all fields must be numbers.`;
    if (min > max) return `${PARAMS[p].short}: min can't be greater than max.`;
    if (target < min || target > max) return `${PARAMS[p].short}: target must be between min and max.`;
    if (min < sMin || max > sMax) return `${PARAMS[p].short}: values must stay within ${sMin}–${sMax}.`;
  }
  return null;
}

function TargetsEditor({ targets, onSave }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(() => targetsToStrings(targets));
  useEffect(() => { setLocal(targetsToStrings(targets)); }, [targets]);
  const update = (p, field, v) => {
    setLocal(prev => ({ ...prev, [p]: { ...prev[p], [field]: v } }));
  };
  const error = validateTargets(local);
  const save = () => {
    if (error) return;
    const parsed = {};
    PARAM_KEYS.forEach(p => {
      parsed[p] = { min: parseFloat(local[p].min), target: parseFloat(local[p].target), max: parseFloat(local[p].max) };
    });
    onSave(parsed);
    setEditing(false);
  };

  return (
    <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
      <button onClick={() => setEditing(!editing)}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50">
        <div className="flex items-center gap-2">
          <Pencil className="w-4 h-4 text-stone-400" />
          <span className="text-sm font-medium text-stone-900">Target ranges</span>
        </div>
        {editing ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
      </button>
      {editing && (
        <div className="px-5 pb-5 border-t border-stone-100">
          <p className="text-xs text-stone-500 mt-3 mb-4">
            Edit your in-range bounds and target values per parameter.
          </p>
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2 text-[10px] uppercase tracking-wider text-stone-400 px-1">
              <span></span><span className="text-center">Min</span><span className="text-center">Target</span><span className="text-center">Max</span>
            </div>
            {PARAM_KEYS.map(p => (
              <div key={p} className="grid grid-cols-4 gap-2 items-center">
                <span className="text-xs font-medium text-stone-700 uppercase tracking-wider">{PARAMS[p].short}</span>
                {['min', 'target', 'max'].map((f, i) => (
                  <input key={f} type="number" step={PARAMS[p].step} value={local[p][f]}
                    onChange={e => update(p, f, e.target.value)}
                    className={`px-2 py-1.5 text-sm font-mono tabular-nums border rounded text-center focus:outline-none focus:ring-1 focus:ring-teal-600 ${
                      f === 'target' ? 'bg-teal-50 border-teal-200' : 'bg-stone-50 border-stone-200'
                    }`} />
                ))}
              </div>
            ))}
          </div>
          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 mt-3">{error}</p>
          )}
          <div className="flex gap-2 mt-5">
            <button onClick={save} disabled={!!error}
              className="flex-1 px-4 py-2 bg-teal-700 text-white text-sm font-medium rounded-md hover:bg-teal-800 disabled:bg-stone-200 disabled:text-stone-400 disabled:cursor-not-allowed">
              Save targets
            </button>
            <button onClick={() => setLocal(targetsToStrings(DEFAULT_TARGETS))}
              className="px-4 py-2 text-stone-600 text-sm font-medium hover:bg-stone-100 rounded-md">
              Reset defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Backup & restore ----------
   window.storage is whatever the host environment provides — its durability
   across refreshes, sessions, or platform updates isn't something this app
   controls. A local file export/import gives an escape hatch that doesn't
   depend on that host at all. */

function downloadBackup(readings, targets) {
  const payload = { exportedAt: new Date().toISOString(), readings, targets };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pool-log-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseBackupFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.readings)) throw new Error();
        if (data.targets != null && typeof data.targets !== 'object') throw new Error();
        resolve(data);
      } catch {
        reject(new Error("That doesn't look like a Pool Log backup file."));
      }
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

function BackupCard({ readings, targets, onRestore }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const [restored, setRestored] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setRestored(null);
    try {
      const data = await parseBackupFile(file);
      onRestore(data);
      setRestored({ count: data.readings.length });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50">
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 text-stone-400" />
          <span className="text-sm font-medium text-stone-900">Backup &amp; restore</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-stone-100">
          <p className="text-xs text-stone-500 mt-3 mb-4">
            Download a backup occasionally so your readings aren't only ever stored in one place. Restoring replaces current readings and targets with the backup's contents.
          </p>
          <div className="flex gap-2">
            <button onClick={() => downloadBackup(readings, targets)} disabled={readings.length === 0}
              className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-teal-700 text-white text-sm font-medium rounded-md hover:bg-teal-800 disabled:bg-stone-200 disabled:text-stone-400 disabled:cursor-not-allowed">
              <Download className="w-4 h-4" />
              Download backup
            </button>
            <label className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 border border-stone-200 text-stone-700 text-sm font-medium rounded-md hover:bg-stone-50 cursor-pointer">
              <Upload className="w-4 h-4" />
              Restore from file
              <input type="file" accept="application/json" onChange={handleFile} className="hidden" />
            </label>
          </div>
          {restored && (
            <div className="mt-3 px-2 py-1.5 bg-emerald-50 border border-emerald-200 rounded text-[11px] text-emerald-800 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
              Restored {restored.count} reading{restored.count === 1 ? '' : 's'} from backup.
            </div>
          )}
          {error && (
            <div className="mt-3 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[11px] text-red-800">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- App ---------- */

export default function App() {
  const [readings, setReadings] = useState([]);
  const [targets, setTargets] = useState(DEFAULT_TARGETS);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get('pool-readings');
        if (r?.value) setReadings(JSON.parse(r.value));
      } catch (e) { /* none */ }
      try {
        const t = await window.storage.get('pool-targets');
        if (t?.value) setTargets(JSON.parse(t.value));
      } catch (e) { /* none */ }
      setLoading(false);
    })();
  }, []);

  const saveReadings = async (next) => {
    setReadings(next);
    try { await window.storage.set('pool-readings', JSON.stringify(next)); }
    catch (e) { console.error(e); }
  };
  const saveTargets = async (next) => {
    setTargets(next);
    try { await window.storage.set('pool-targets', JSON.stringify(next)); }
    catch (e) { console.error(e); }
  };

  const addReading = (reading) => {
    const next = [...readings, reading].sort((a, b) => b.timestamp - a.timestamp);
    saveReadings(next);
    setShowForm(false);
  };
  const deleteReading = (id) => saveReadings(readings.filter(r => r.id !== id));
  const restoreBackup = (data) => {
    saveReadings(data.readings.slice().sort((a, b) => b.timestamp - a.timestamp));
    if (data.targets) saveTargets({ ...DEFAULT_TARGETS, ...data.targets });
  };

  const sorted = useMemo(() => [...readings].sort((a, b) => b.timestamp - a.timestamp), [readings]);
  const latest = sorted[0];

  const calibrations = useMemo(() => computeCalibrations(readings), [readings]);

  const latestBySource = useMemo(() => {
    const map = {};
    for (const r of sorted) {
      if (!map[r.source]) map[r.source] = r;
    }
    return map;
  }, [sorted]);

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <Droplets className="w-6 h-6 text-stone-300 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8 space-y-4 pb-24">
        <header className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-2xl font-semibold text-stone-900 tracking-tight">Pool Log</h1>
            <p className="text-xs text-stone-500 mt-0.5">
              {sorted.length} reading{sorted.length === 1 ? '' : 's'} · {Object.keys(calibrations).length} device{Object.keys(calibrations).length === 1 ? '' : 's'} calibrated
            </p>
          </div>
          {!showForm && (
            <button onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-teal-700 text-white text-sm font-medium rounded-md hover:bg-teal-800 shadow-sm">
              <Plus className="w-4 h-4" />
              New
            </button>
          )}
        </header>

        {showForm && (
          <EntryForm onSave={addReading} onCancel={() => setShowForm(false)} calibrations={calibrations} />
        )}

        <StatusCard latest={latest} targets={targets} calibrations={calibrations} />

        <AIAnalysisCard readings={readings} targets={targets} calibrations={calibrations} />

        <CalibrationCard calibrations={calibrations} latestBySource={latestBySource} />

        {readings.length > 0 && <Trends readings={readings} targets={targets} />}

        {readings.length > 0 && (
          <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <button onClick={() => setHistoryOpen(!historyOpen)}
              className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50">
              <span className="text-sm font-medium text-stone-900">History</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-500">{readings.length} total</span>
                {historyOpen ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
              </div>
            </button>
            {historyOpen && (
              <div className="border-t border-stone-100">
                {sorted.map(r => (
                  <HistoryRow key={r.id} reading={r} targets={targets} calibrations={calibrations}
                    onDelete={deleteReading} expanded={expandedId === r.id}
                    onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)} />
                ))}
              </div>
            )}
          </div>
        )}

        <TargetsEditor targets={targets} onSave={saveTargets} />

        <BackupCard readings={readings} targets={targets} onRestore={restoreBackup} />

        <div className="text-[10px] text-stone-400 text-center pt-4 leading-relaxed">
          Ref = Pool Store (ClearCare) · T2 Photometer · T3 Manual/Strip Reader · T4 Strips/HydroComm<br />
          Calibration pairs readings within {PAIR_WINDOW_HOURS}h of a reference sample.
        </div>
      </div>
    </div>
  );
}
