// Chivatazo: publica el chivatazo del día en los canales de Telegram listados en canales.json.
// Cada canal puede ser nacional ("provincia": null) o de una provincia ("provincia": "BIZKAIA").
import fs from 'node:fs/promises';

const TOKEN = process.env.TELEGRAM_TOKEN;
const FORCE = process.env.FORCE === 'true';
if (!TOKEN) { console.log('Falta TELEGRAM_TOKEN: no se publica.'); process.exit(0); }

const channels = JSON.parse(await fs.readFile('canales.json', 'utf8'));
const data = JSON.parse(await fs.readFile('data/today.json', 'utf8'));
let hist = {}; try { hist = JSON.parse(await fs.readFile('data/history.json', 'utf8')); } catch {}
let last = {}; try { last = JSON.parse(await fs.readFile('data/telegram-last.json', 'utf8')); } catch {}
const today = data.date;

const fmt = (n, d = 3) => n.toFixed(d).replace('.', ',');
const nice = s => s.toLowerCase().replace(/(^|[\s\/(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();

// encuentra la provincia del Ministerio que corresponde a lo escrito en canales.json
function findProv(name) {
  if (!name) return null;
  const all = Object.keys(data.fuels.g95.provinces);
  return all.find(p => norm(p) === norm(name)) || all.find(p => norm(p).includes(norm(name))) || null;
}

function trend(fuel, key) {
  const s = Object.keys(hist).sort().slice(-14).map(d => hist[d]?.[fuel]?.[key]).filter(v => typeof v === 'number');
  if (s.length < 4) return { icon: '🟡', txt: 'aún recopilando datos' };
  const diff = s[s.length - 1] - s[s.length - 4];
  if (diff > 0.004) return { icon: '🟢', txt: 'reposta hoy, está subiendo' };
  if (diff < -0.004) return { icon: '🔴', txt: 'espera si puedes, está bajando' };
  return { icon: '🟡', txt: 'estable, da igual el día' };
}

function lightBlock(L) {
  if (!L) return '';
  const win = n => { let best = 0, bs = 1e9; for (let i = 0; i <= 24 - n; i++) { const s = L.slice(i, i + n).reduce((a, b) => a + b, 0); if (s < bs) { bs = s; best = i; } } return best; };
  const w2 = win(2), w3 = win(3), mx = Math.max(...L), mn = Math.min(...L);
  return `\n💡 <b>Luz (PVPC, península)</b>\n` +
    `🧺 Lavadora: ${w2}:00–${w2 + 2}:00\n` +
    `🍽️ Lavavajillas: ${w3}:00–${w3 + 3}:00\n` +
    `✅ Hora más barata: ${L.indexOf(mn)}:00 (${fmt(mn)} €/kWh)\n` +
    `🚫 Hora más cara: ${L.indexOf(mx)}:00 (${fmt(mx)} €/kWh)\n`;
}

async function stationsBlock(prov) {
  const file = data.geo?.[prov]?.file; if (!file) return '';
  let arr = []; try { arr = JSON.parse(await fs.readFile(`data/prov/${file}.json`, 'utf8')); } catch { return ''; }
  let out = '';
  for (const [i, name] of [[5, 'Gasolina 95'], [6, 'Diésel']]) {
    const top = arr.filter(x => x[i]).sort((a, b) => a[i] - b[i]).slice(0, 3);
    if (!top.length) continue;
    out += `\n🏆 <b>Más baratas, ${name}</b>\n` + top.map((x, k) =>
      `${k + 1}. ${esc(nice(x[0] || 'Gasolinera'))} (${esc(nice(x[2]))}): <b>${fmt(x[i])} €/l</b>`).join('\n') + '\n';
  }
  return out;
}

function fuelBlock(prov) {
  const key = prov || '_';
  const lines = [];
  for (const [fuel, name] of [['g95', 'Gasolina 95'], ['diesel', 'Diésel']]) {
    const F = data.fuels[fuel];
    const avg = prov ? F.provinces[prov]?.avg : F.avg;
    if (!avg) continue;
    const t = trend(fuel, key);
    lines.push(`${t.icon} ${name}: ${fmt(avg)} €/l de media, ${t.txt}`);
  }
  let extra = '';
  if (!prov) {
    const ps = Object.entries(data.fuels.g95.provinces).filter(([, v]) => v.n >= 20).sort((a, b) => a[1].avg - b[1].avg);
    if (ps.length > 2) extra = `\n📉 Provincia más barata (95): ${esc(nice(ps[0][0]))}, ${fmt(ps[0][1].avg)} €/l\n📈 Más cara: ${esc(nice(ps.at(-1)[0]))}, ${fmt(ps.at(-1)[1].avg)} €/l`;
  }
  return `⛽ <b>Carburantes ${prov ? 'en ' + esc(nice(prov)) : 'en España'}</b>\n` + lines.join('\n') + extra + '\n';
}

async function buildMessage(prov) {
  const d = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(today + 'T12:00:00Z'));
  return `🤫 <b>El chivatazo de hoy${prov ? ' · ' + esc(nice(prov)) : ''}</b>\n<i>${d[0].toUpperCase() + d.slice(1)}</i>\n\n` +
    fuelBlock(prov) + (prov ? await stationsBlock(prov) : '') + lightBlock(data.light?.today) +
    `\n📍 La más barata cerca de ti: <a href="https://chivatazo.es">chivatazo.es</a>`;
}

let failed = 0;
for (const ch of channels) {
  const prov = findProv(ch.provincia);
  if (ch.provincia && !prov) { console.error('Provincia no encontrada:', ch.provincia); failed++; continue; }
  if (last[ch.chat] === today && !FORCE) { console.log('Ya publicado hoy en', ch.chat); continue; }
  const text = await buildMessage(prov);
  if (process.env.DRY_RUN) { console.log('---', ch.chat, '\n' + text); continue; }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ch.chat, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const j = await r.json();
  if (!j.ok) { console.error('Telegram ha rechazado el mensaje en', ch.chat + ':', j.description); failed++; continue; }
  last[ch.chat] = today;
  console.log('Publicado en', ch.chat);
}
await fs.writeFile('data/telegram-last.json', JSON.stringify(last));
if (failed) process.exit(1);
