// Chivatazo: descarga precios oficiales de carburantes (Ministerio) y luz PVPC (Red Eléctrica)
// y los guarda en data/today.json y data/history.json. Lo ejecuta GitHub Actions a diario.
import fs from 'node:fs/promises';

const MINETUR = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/';
const FUELS = { g95: 'Precio Gasolina 95 E5', diesel: 'Precio Gasoleo A' };
const PER_PROVINCE = 60;      // gasolineras más baratas guardadas por provincia
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

async function fuels() {
  const raw = await getJSON(MINETUR);
  const list = raw.ListaEESSPrecio || [];
  if (list.length < 1000) throw new Error('El Ministerio ha devuelto pocas gasolineras: ' + list.length);
  const out = {};
  for (const [key, field] of Object.entries(FUELS)) {
    const byProv = {}; let sum = 0, n = 0;
    for (const e of list) {
      const p = price(e[field]); if (!p) continue;
      const prov = (e['Provincia'] || '').trim(); if (!prov) continue;
      (byProv[prov] ??= []).push({
        b: (e['Rótulo'] || '').trim(), dir: (e['Dirección'] || '').trim(), mun: (e['Municipio'] || '').trim(),
        lat: coord(e['Latitud']), lon: coord(e['Longitud (WGS84)']), p, h: (e['Horario'] || '').trim()
      });
      sum += p; n++;
    }
    const provinces = {};
    for (const [prov, arr] of Object.entries(byProv)) {
      arr.sort((a, b) => a.p - b.p);
      const avg = arr.reduce((s, x) => s + x.p, 0) / arr.length;
      provinces[prov] = { avg: +avg.toFixed(4), n: arr.length, cheapest: arr.slice(0, PER_PROVINCE) };
    }
    out[key] = { avg: +(sum / n).toFixed(4), provinces };
  }
  return out;
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

let fuel;
try { fuel = await fuels(); }
catch (e) { console.warn('Carburantes no disponibles:', e.message); fuel = prev.fuels; }
if (!fuel) throw new Error('No hay datos de carburantes');

const light = { date: today, today: await pvpc(today), tomorrow: await pvpc(madridDate(1)) };

await fs.writeFile('data/today.json', JSON.stringify({ updated: new Date().toISOString(), date: today, fuels: fuel, light }));

let hist = {};
try { hist = JSON.parse(await fs.readFile('data/history.json', 'utf8')); } catch {}
hist[today] = Object.fromEntries(Object.entries(fuel).map(([k, f]) =>
  [k, { _: f.avg, ...Object.fromEntries(Object.entries(f.provinces).map(([p, v]) => [p, v.avg])) }]));
const keep = Object.keys(hist).sort().slice(-HISTORY_DAYS);
hist = Object.fromEntries(keep.map(k => [k, hist[k]]));
await fs.writeFile('data/history.json', JSON.stringify(hist));

console.log('OK', today, 'provincias:', Object.keys(fuel.g95.provinces).length, 'luz hoy:', !!light.today, 'mañana:', !!light.tomorrow);
