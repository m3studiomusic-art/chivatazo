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

await fs.writeFile('data/today.json', JSON.stringify({ updated: new Date().toISOString(), date: today, fuels: fuel, geo, light }));

let hist = {};
try { hist = JSON.parse(await fs.readFile('data/history.json', 'utf8')); } catch {}
hist[today] = Object.fromEntries(Object.entries(fuel).map(([k, f]) =>
  [k, { _: f.avg, ...Object.fromEntries(Object.entries(f.provinces).map(([p, v]) => [p, v.avg])) }]));
const keep = Object.keys(hist).sort().slice(-HISTORY_DAYS);
hist = Object.fromEntries(keep.map(k => [k, hist[k]]));
await fs.writeFile('data/history.json', JSON.stringify(hist));

console.log('OK', today, 'provincias:', Object.keys(fuel.g95.provinces).length, 'luz hoy:', !!light.today, 'mañana:', !!light.tomorrow);
