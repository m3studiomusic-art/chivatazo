// Chivatazo: descarga precios oficiales de carburantes (Ministerio) y luz PVPC (Red Eléctrica)
// y los guarda en data/today.json y data/history.json. Lo ejecuta GitHub Actions a diario.
import fs from 'node:fs/promises';

const MINETUR = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/';
const FUELS = { g95: 'Precio Gasolina 95 E5', diesel: 'Precio Gasoleo A' };
const HISTORY_DAYS = 60;

const price = s => { const n = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
const coord = s => { const n = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(n) ? +n.toFixed(5) : null; };
const madridDate = (plusDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + plusDays * 864e5));

async function getJSON(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'chivatazo.es' } });
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status} en ${url}`);
    } catch (e) { last = e; }
    await new Promise(res => setTimeout(res, 5000));
  }
  throw last;
}

const slug = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

// Devuelve { fuels: medias por provincia, byProv: todas las gasolineras por provincia }
async function fuels() {
  const raw = await getJSON(MINETUR);
  const list = raw.ListaEESSPrecio || [];
  if (list.length < 1000) throw new Error('El Ministerio ha devuelto pocas gasolineras: ' + list.length);
  const byProv = {};
  for (const e of list) {
    const prov = (e['Provincia'] || '').trim(); if (!prov) continue;
    const g = price(e[FUELS.g95]), d = price(e[FUELS.diesel]);
    if (!g && !d) continue;
    (byProv[prov] ??= []).push([
      (e['Rótulo'] || '').trim(), (e['Dirección'] || '').trim(), (e['Municipio'] || '').trim(),
      coord(e['Latitud']), coord(e['Longitud (WGS84)']), g, d
    ]);
  }
  const out = {};
  const idx = { g95: 5, diesel: 6 };
  for (const [key, i] of Object.entries(idx)) {
    let sum = 0, n = 0; const provinces = {};
    for (const [prov, arr] of Object.entries(byProv)) {
      const ps = arr.map(x => x[i]).filter(Boolean);
      if (!ps.length) continue;
      const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
      provinces[prov] = { avg: +avg.toFixed(4), n: ps.length };
      sum += ps.reduce((a, b) => a + b, 0); n += ps.length;
    }
    out[key] = { avg: +(sum / n).toFixed(4), provinces };
  }
  const geo = {};
  for (const [prov, arr] of Object.entries(byProv)) {
    const pts = arr.filter(x => x[3] != null && x[4] != null);
    geo[prov] = {
      file: slug(prov),
      lat: +(pts.reduce((a, x) => a + x[3], 0) / pts.length).toFixed(3),
      lon: +(pts.reduce((a, x) => a + x[4], 0) / pts.length).toFixed(3)
    };
  }
  return { fuels: out, byProv, geo };
}

async function pvpc(date) {
  const url = `https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=${date}T00:00&end_date=${date}T23:59&time_trunc=hour`;
  try {
    const j = await getJSON(url);
    const serie = (j.included || []).find(x => /PVPC/i.test(x.attributes?.title || ''));
    if (!serie) return null;
    const sums = Array(24).fill(0), cnt = Array(24).fill(0);
    for (const v of serie.attributes.values || []) {
      const h = parseInt(String(v.datetime).slice(11, 13), 10);
      if (h >= 0 && h < 24 && Number.isFinite(v.value)) { sums[h] += v.value; cnt[h]++; }
    }
    if (cnt.filter(Boolean).length < 20) return null;
    const hours = sums.map((s, h) => cnt[h] ? +(s / cnt[h] / 1000).toFixed(4) : null); // €/MWh → €/kWh
    for (let h = 0; h < 24; h++) if (hours[h] === null) hours[h] = hours[h - 1] ?? hours.find(x => x !== null);
    return hours;
  } catch (e) { console.warn('Luz no disponible para', date, e.message); return null; }
}


// ---------- Mercado: Brent (Yahoo Finance) y cambio euro-dólar (BCE) ----------
async function getText(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (chivatazo.es)' } });
      if (r.ok) return await r.text();
      last = new Error(`HTTP ${r.status} en ${url}`);
    } catch (e) { last = e; }
    await new Promise(res => setTimeout(res, 4000));
  }
  throw last;
}

async function brentUSD() {
  // Futuro del Brent (BZ=F), cierres diarios del último mes y medio
  const j = JSON.parse(await getText('https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF?range=2mo&interval=1d'));
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp || [], close = r?.indicators?.quote?.[0]?.close || [];
  const out = {};
  ts.forEach((t, i) => { if (Number.isFinite(close[i])) out[new Date(t * 1000).toISOString().slice(0, 10)] = close[i]; });
  if (Object.keys(out).length < 10) throw new Error('Pocos datos de Brent');
  return out;
}

async function usdPerEur() {
  // Tipo de cambio oficial del BCE (dólares por euro)
  const csv = await getText('https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=60&format=csvdata');
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  const iT = head.indexOf('TIME_PERIOD'), iV = head.indexOf('OBS_VALUE');
  const out = {};
  for (const l of lines.slice(1)) { const c = l.split(','); const v = parseFloat(c[iV]); if (Number.isFinite(v)) out[c[iT]] = v; }
  if (Object.keys(out).length < 10) throw new Error('Pocos datos del BCE');
  return out;
}

async function market(prevMarket) {
  try {
    const [b, fx] = await Promise.all([brentUSD(), usdPerEur()]);
    const fxDates = Object.keys(fx).sort();
    const series = Object.keys(b).sort().map(d => {
      const rateDate = fxDates.filter(x => x <= d).pop() || fxDates[0];
      return { d, usd: +b[d].toFixed(2), eur: +(b[d] / fx[rateDate]).toFixed(2) };
    });
    return { updated: new Date().toISOString(), brent: series.slice(-30) };
  } catch (e) {
    console.warn('Mercado no disponible:', e.message);
    return prevMarket || null;
  }
}

// ---------- Semáforo: Brent en euros + tendencia de la provincia ----------
function brentSignal(m) {
  const s = m?.brent; if (!s || s.length < 10) return null;
  const avg = a => a.reduce((x, y) => x + y.eur, 0) / a.length;
  const recent = avg(s.slice(-3)), past = avg(s.slice(-10, -7));
  const pct = recent / past - 1;
  const cents = (recent - past) / 159 * 1.21 * 100; // barril = 159 l, con IVA
  return { pct, cents, now: s.at(-1).eur };
}

function verdictFor(series, sig) {
  const localDiff = series.length >= 4 ? series.at(-1) - series.at(-4) : null;
  const up = localDiff != null && localDiff > 0.004, down = localDiff != null && localDiff < -0.004;
  const pctTxt = sig ? `${Math.abs(sig.pct * 100).toFixed(1).replace('.', ',')} %` : '';
  const cN = sig ? Math.max(1, Math.round(Math.abs(sig.cents))) : 0;
  const cTxt = cN === 1 ? 'alrededor de 1 céntimo' : `unos ${cN} céntimos`;
  if (sig && sig.cents >= 0.8) return { k: 'g', t: 'Reposta hoy',
    why: `El Brent en euros ha subido un ${pctTxt} en la última semana y suele llegar a las gasolineras en pocos días. Podría subir ${cTxt} por litro.` + (up ? ' En tu provincia ya ha empezado a subir.' : '') };
  if (sig && sig.cents <= -0.8) {
    if (up) return { k: 'a', t: 'Da igual el día',
      why: `Los precios han subido estos días, pero el Brent en euros ha bajado un ${pctTxt} en la última semana. Lo normal es que la subida se frene pronto.` };
    return { k: 'r', t: 'Espera si puedes',
      why: `El Brent en euros ha bajado un ${pctTxt} en la última semana. Las bajadas tardan más en llegar a las gasolineras, pero podría bajar ${cTxt} por litro en los próximos días.` };
  }
  const brentTxt = sig ? ' El Brent está estable.' : '';
  if (up) return { k: 'g', t: 'Reposta hoy', why: 'El precio medio en tu provincia lleva varios días subiendo y lo más probable es que siga al alza unos días más.' + brentTxt };
  if (down) return { k: 'r', t: 'Espera si puedes', why: 'Los precios llevan días bajando. Si no vas justo, en 2 o 3 días seguramente te salga algo más barato.' + brentTxt };
  if (localDiff == null && !sig) return { k: 'a', t: 'Aún aprendiendo', why: 'Estoy recopilando los precios de los últimos días. Mientras, fíjate en la gasolinera: ahí está el ahorro de verdad.' };
  return { k: 'a', t: 'Da igual el día', why: 'El precio está estable.' + brentTxt + ' Lo que de verdad ahorra hoy es elegir bien la gasolinera.' };
}

const today = madridDate(0);
await fs.mkdir('data', { recursive: true });

let prev = {};
try { prev = JSON.parse(await fs.readFile('data/today.json', 'utf8')); } catch {}

let fuel, geo;
try {
  const f = await fuels();
  fuel = f.fuels; geo = f.geo;
  await fs.mkdir('data/prov', { recursive: true });
  for (const [prov, arr] of Object.entries(f.byProv))
    await fs.writeFile(`data/prov/${geo[prov].file}.json`, JSON.stringify(arr));
} catch (e) { console.warn('Carburantes no disponibles:', e.message); fuel = prev.fuels; geo = prev.geo; }
if (!fuel || !geo) throw new Error('No hay datos de carburantes');

const light = { date: today, today: await pvpc(today), tomorrow: await pvpc(madridDate(1)) };


let hist = {};
try { hist = JSON.parse(await fs.readFile('data/history.json', 'utf8')); } catch {}
hist[today] = Object.fromEntries(Object.entries(fuel).map(([k, f]) =>
  [k, { _: f.avg, ...Object.fromEntries(Object.entries(f.provinces).map(([p, v]) => [p, v.avg])) }]));
const keep = Object.keys(hist).sort().slice(-HISTORY_DAYS);
hist = Object.fromEntries(keep.map(k => [k, hist[k]]));
await fs.writeFile('data/history.json', JSON.stringify(hist));

const mk = await market(prev.market);
const sig = brentSignal(mk);
const verdicts = {};
for (const f of Object.keys(fuel)) {
  verdicts[f] = {};
  for (const p of ['_', ...Object.keys(fuel[f].provinces)]) {
    const series = Object.keys(hist).sort().slice(-14).map(d => hist[d]?.[f]?.[p]).filter(v => typeof v === 'number');
    verdicts[f][p] = verdictFor(series, sig);
  }
}
const marketOut = mk ? { ...mk, signal: sig } : null;
await fs.writeFile('data/today.json', JSON.stringify({ updated: new Date().toISOString(), date: today, fuels: fuel, geo, light, market: marketOut, verdicts }));

console.log('OK', today, 'brent:', sig ? `${sig.now} €/barril, ${(sig.pct*100).toFixed(1)}% (≈${sig.cents.toFixed(1)} cts/l)` : 'no', 'provincias:', Object.keys(fuel.g95.provinces).length, 'luz hoy:', !!light.today, 'mañana:', !!light.tomorrow);
