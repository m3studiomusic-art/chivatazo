(async function () {
  const $ = s => document.querySelector(s);
  const fmt = (n, d = 3) => n.toFixed(d).replace('.', ',');
  const TZ = 'Europe/Madrid';
  const nowHour = +new Intl.DateTimeFormat('es-ES', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()) % 24;
  const nice = s => s.toLowerCase().replace(/(^|[\s\/(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  const dateTxt = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  $('#date').textContent = dateTxt[0].toUpperCase() + dateTxt.slice(1);

  let data, hist = {};
  try {
    data = await (await fetch('data/today.json', { cache: 'no-cache' })).json();
    try { hist = await (await fetch('data/history.json', { cache: 'no-cache' })).json(); } catch {}
  } catch (e) {
    $('#verdict').textContent = 'Sin datos';
    $('#why').textContent = 'No se han podido cargar los precios. Vuelve a intentarlo en unos minutos.';
    return;
  }

  const provs = Object.keys(data.fuels.g95.provinces).sort((a, b) => a.localeCompare(b, 'es'));
  $('#place').innerHTML = provs.map(p => `<option value="${p}">${nice(p)}</option>`).join('');
  let place = store.get('prov'); if (!provs.includes(place)) place = provs.find(p => /BIZKAIA|VIZCAYA/i.test(p)) || provs[0];
  $('#place').value = place;
  let fuel = store.get('fuel') === 'diesel' ? 'diesel' : 'g95';
  document.querySelectorAll('[data-fuel]').forEach(x => x.setAttribute('aria-pressed', x.dataset.fuel === fuel));
  let day = 'today', me = null, shown = 5;
  let km = +store.get('km') || 5;
  const PAGE = 5;

  const dist = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

  // gasolineras por provincia, cargadas bajo demanda
  const cache = {};
  async function loadProv(p) {
    if (cache[p]) return cache[p];
    const g = data.geo?.[p]; if (!g) return [];
    try {
      const arr = await (await fetch(`data/prov/${g.file}.json`, { cache: 'no-cache' })).json();
      cache[p] = arr.map(x => ({ b: x[0], dir: x[1], mun: x[2], lat: x[3], lon: x[4], g95: x[5], diesel: x[6], prov: p }));
    } catch { cache[p] = []; }
    return cache[p];
  }
  function nearestProvs(pt, n = 3) {
    return Object.entries(data.geo || {}).map(([p, g]) => [p, dist(pt, g)]).sort((a, b) => a[1] - b[1]).slice(0, n).map(x => x[0]);
  }

  function series() {
    return Object.keys(hist).sort().slice(-14).map(d => hist[d]?.[fuel]?.[place]).filter(v => typeof v === 'number');
  }

  function verdict(s) {
    if (s.length < 4) return { k: 'a', t: 'Aún aprendiendo', why: 'Estoy recopilando los precios de los últimos días. En cuanto tenga unos cuantos te diré si conviene esperar. Mientras, fíjate en la gasolinera: ahí está el ahorro de verdad.' };
    const diff = s[s.length - 1] - s[s.length - 4];
    if (diff > 0.004) return { k: 'g', t: 'Reposta hoy', why: 'El precio medio en tu provincia lleva varios días subiendo. Lo más probable es que siga al alza unos días más.' };
    if (diff < -0.004) return { k: 'r', t: 'Espera si puedes', why: 'Los precios llevan días bajando. Si no vas justo, en 2 o 3 días seguramente te salga algo más barato.' };
    return { k: 'a', t: 'Da igual el día', why: 'El precio está estable. Lo que de verdad ahorra hoy es elegir bien la gasolinera.' };
  }

  let lastFuel = null, lastLight = null;

  function renderVerdict() {
    const P = data.fuels[fuel].provinces[place];
    const s = series(), v = verdict(s);
    $('#verdict').textContent = v.t; $('#why').textContent = v.why;
    document.querySelectorAll('.light span').forEach(e => e.classList.toggle('on', e.classList.contains(v.k)));
    $('#avg').textContent = P ? fmt(P.avg) + ' €/l' : '';
    const col = v.k === 'g' ? 'var(--go)' : v.k === 'r' ? 'var(--stop)' : 'var(--wait)';
    if (s.length >= 2) {
      const mn = Math.min(...s) - 0.003, mx = Math.max(...s) + 0.003;
      const pts = s.map((y, i) => [i * (300 / (s.length - 1)), 64 - ((y - mn) / (mx - mn)) * 58]);
      const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      const lp = pts[pts.length - 1];
      $('#spark').innerHTML = `<path d="${line} L300 70 L0 70Z" fill="${col}" opacity=".12"/><path d="${line}" fill="none" stroke="${col}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><circle cx="${lp[0]}" cy="${lp[1]}" r="4" fill="${col}"/>`;
      $('#trendLabel').textContent = `Precio medio en tu provincia, últimos ${s.length} días`;
    } else { $('#spark').innerHTML = ''; $('#trendLabel').textContent = 'Precio medio en tu provincia'; }
    return v;
  }

  let renderId = 0;
  async function renderFuel() {
    const id = ++renderId;
    const v = renderVerdict();
    const P = data.fuels[fuel].provinces[place];
    let list;
    if (me) {
      const provsNear = nearestProvs(me);
      const all = (await Promise.all(provsNear.map(loadProv))).flat();
      list = all.filter(x => x[fuel] && x.lat != null).map(x => ({ ...x, km: dist(me, x) })).filter(x => x.km <= km);
      $('#stSub').textContent = list.length
        ? `${list.length} gasolineras a menos de ${km} km, de la más barata a la más cara.`
        : `No hay gasolineras con ${fuel === 'g95' ? 'gasolina 95' : 'diésel'} a menos de ${km} km. Prueba con más distancia.`;
    } else {
      list = (await loadProv(place)).filter(x => x[fuel]);
      $('#stSub').textContent = `Toda la provincia, de la más barata a la más cara. Pulsa 📍 para ver solo las de tu alrededor.`;
    }
    if (id !== renderId) return;
    list.sort((a, b) => a[fuel] - b[fuel]);
    const avg = P ? P.avg : null;
    const view = list.slice(0, shown);
    $('#stations').innerHTML = view.length ? view.map((st, i) => {
      const p = st[fuel];
      const save = avg ? (avg - p) * 50 : 0;
      const saveTxt = save > 0.5 ? `<span class="save">${fmt(save, 2)} € menos</span> que la media en un depósito de 50 l`
        : save < -0.5 ? `${fmt(-save, 2)} € más que la media en un depósito de 50 l` : 'En la media de la provincia';
      const [e, c] = fmt(p).split(',');
      const where = nice(st.dir) + ', ' + nice(st.mun);
      const kmTxt = st.km != null ? ` · a ${fmt(st.km, 1)} km` : '';
      const maps = st.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lon}` : `https://www.google.com/maps/search/${encodeURIComponent(st.b + ' ' + st.dir + ' ' + st.mun)}`;
      return `<div class="row${i === 0 ? ' best' : ''}">
        <div><div class="brand">${i === 0 ? '🏆 ' : ''}${nice(st.b || 'Gasolinera')}</div><div class="meta addr">${where}${kmTxt}</div><div class="meta">${saveTxt}</div>
        <a class="go-btn" href="${maps}" target="_blank" rel="noopener">Cómo llegar</a></div>
        <div class="price">${e},${c.slice(0, 2)}<small>${c.slice(2)}</small></div></div>`;
    }).join('') : '<div class="empty">No hay gasolineras que mostrar.</div>';
    const rest = list.length - view.length;
    const more = $('#moreBtn');
    more.hidden = rest <= 0;
    more.textContent = `Ver ${Math.min(PAGE, rest)} más (quedan ${rest})`;
    lastFuel = { v, st: list[0], p: list[0]?.[fuel] };
    renderShare();
  }

  function renderLight() {
    const L = data.light?.[day];
    const btnTomorrow = document.querySelector('[data-day="tomorrow"]');
    if (!L) {
      $('#lightBody').hidden = true; $('#lightEmpty').hidden = false;
      $('#lightEmpty').textContent = day === 'tomorrow' ? 'Los precios de mañana se publican cada tarde. Vuelve a partir de las 21:00.' : 'Hoy no se han podido cargar los precios de la luz.';
      if (day === 'today') lastLight = null; renderShare(); return;
    }
    $('#lightBody').hidden = false; $('#lightEmpty').hidden = true;
    const sorted = [...L].sort((a, b) => a - b), mx = Math.max(...L);
    const level = p => p <= sorted[7] ? 'go' : p >= sorted[16] ? 'stop' : 'wait';
    const cur = day === 'today' ? nowHour : null;
    $('#bars').innerHTML = L.map((p, i) => `<div class="bar${i === cur ? ' cur' : ''}" title="${i}:00, ${fmt(p)} €/kWh" style="height:${Math.max(5, p / mx * 100).toFixed(0)}%;background:var(--${level(p)})"></div>`).join('');
    $('#hours').innerHTML = L.map((_, i) => `<span>${i % 3 === 0 ? i : ''}</span>`).join('');
    const ref = day === 'today' ? L[nowHour] : sorted[0];
    $('#nowLabel').textContent = day === 'today' ? `Ahora mismo (${nowHour}:00)` : 'La hora más barata de mañana';
    $('#nowPrice').innerHTML = fmt(ref) + ' <small>€/kWh</small>';
    const lv = level(ref), tag = $('#nowTag');
    tag.textContent = lv === 'go' ? 'Buen momento' : lv === 'stop' ? 'Hora cara' : 'Precio medio'; tag.style.background = `var(--${lv})`;
    const from = day === 'today' ? nowHour : 0;
    const win = n => { let best = from, bs = 1e9; for (let i = from; i <= 24 - n; i++) { const s = L.slice(i, i + n).reduce((a, b) => a + b, 0); if (s < bs) { bs = s; best = i; } } return best; };
    const w2 = win(2), w3 = win(3), w4 = win(4), worst = L.indexOf(mx);
    const tips = [['🧺', 'Lavadora', w2, 2], ['🍽️', 'Lavavajillas', w3, 3], ['🔌', 'Cargar el coche', w4, 4], ['🚫', 'Evita el horno', worst, 1]];
    $('#tips').innerHTML = tips.map(t => `<li><span class="ico" aria-hidden="true">${t[0]}</span><span class="what">${t[1]}</span><span class="when">${t[2]}:00–${Math.min(24, t[2] + t[3])}:00</span></li>`).join('');
    if (day === 'today') { lastLight = { w2, worst }; renderShare(); }
    btnTomorrow.disabled = false;
  }

  function renderShare() {
    if (!lastFuel) return;
    const { v, st, p } = lastFuel;
    const icon = v.k === 'g' ? '🟢' : v.k === 'r' ? '🔴' : '🟡';
    let t = `🤫 El chivatazo de hoy (${nice(place)})\n${icon} ${fuel === 'g95' ? 'Gasolina 95' : 'Diésel'}: ${v.t.toLowerCase()}`;
    if (st) t += `\n⛽ Más barata: ${nice(st.b)} (${nice(st.mun)}), ${fmt(p)} €/l`;
    if (lastLight) t += `\n💡 Luz barata: ${lastLight.w2}:00–${lastLight.w2 + 2}:00\n🚫 Hora cara: ${lastLight.worst}:00`;
    t += '\nchivatazo.es';
    $('#shareText').textContent = t;
  }

  $('#shareBtn').addEventListener('click', async () => {
    const t = $('#shareText').textContent, b = $('#shareBtn');
    try { if (navigator.share) { await navigator.share({ text: t }); return; } await navigator.clipboard.writeText(t); b.textContent = 'Copiado'; }
    catch (e) { if (e.name !== 'AbortError') b.textContent = 'Mantén pulsado el texto para copiarlo'; }
    setTimeout(() => b.textContent = 'Compartir', 2200);
  });

  const locMsg = t => { const m = $('#locMsg'); m.hidden = !t; m.textContent = t || ''; };
  function setKm(k) {
    km = k; store.set('km', k);
    document.querySelectorAll('[data-km]').forEach(x => x.setAttribute('aria-pressed', +x.dataset.km === km));
  }
  setKm(km);
  document.querySelectorAll('[data-km]').forEach(b => b.addEventListener('click', () => { setKm(+b.dataset.km); shown = PAGE; renderFuel(); }));

  $('#locBtn').addEventListener('click', () => {
    const btn = $('#locBtn');
    if (me) { // desactivar
      me = null; shown = PAGE; $('#radius').hidden = true; btn.textContent = '📍 Ver las de cerca de mí'; locMsg(''); renderFuel(); return;
    }
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      locMsg('Tu navegador no permite usar la ubicación. Elige tu provincia en el desplegable de arriba.'); return;
    }
    btn.textContent = '📍 Buscando tu ubicación…'; btn.disabled = true; locMsg('');
    navigator.geolocation.getCurrentPosition(pos => {
      btn.disabled = false;
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      const p = nearestProvs(me, 1)[0];
      if (p) { place = p; $('#place').value = place; store.set('prov', place); }
      $('#radius').hidden = false; btn.textContent = '✕ Ver toda la provincia';
      shown = PAGE; renderFuel();
    }, err => {
      btn.disabled = false; btn.textContent = '📍 Ver las de cerca de mí';
      if (err.code === 1) locMsg('Para ver las gasolineras de tu alrededor necesito tu ubicación. Activa la ubicación del móvil y permite que el navegador la use, y vuelve a pulsar el botón.');
      else if (err.code === 3) locMsg('Tu ubicación está tardando demasiado. Comprueba que tienes la ubicación del móvil activada y vuelve a intentarlo.');
      else locMsg('No he podido saber dónde estás. Activa la ubicación del móvil (GPS) y vuelve a intentarlo.');
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  });

  $('#moreBtn').addEventListener('click', () => { shown += PAGE; renderFuel(); });

  $('#place').addEventListener('change', e => { place = e.target.value; me = null; shown = PAGE; $('#radius').hidden = true; $('#locBtn').textContent = '📍 Ver las de cerca de mí'; locMsg(''); store.set('prov', place); renderFuel(); });
  document.querySelectorAll('[data-fuel]').forEach(b => b.addEventListener('click', () => {
    fuel = b.dataset.fuel; store.set('fuel', fuel); shown = PAGE;
    document.querySelectorAll('[data-fuel]').forEach(x => x.setAttribute('aria-pressed', x === b)); renderFuel();
  }));
  document.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
    day = b.dataset.day; document.querySelectorAll('[data-day]').forEach(x => x.setAttribute('aria-pressed', x === b)); renderLight();
  }));

  const up = new Date(data.updated);
  $('#updated').textContent = 'Actualizado: ' + new Intl.DateTimeFormat('es-ES', { timeZone: TZ, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(up);

  renderLight(); renderFuel();
})();
