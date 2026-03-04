// ============================================================
// SISMO FVG — Cloudflare Worker v2.0
// Monitor Sismico FVG + Correlazione Solare NOAA
// Gimmy Pignolo © 2026 — gimmycloud.com
// ============================================================

const INGV_URL    = "https://webservices.ingv.it/fdsnws/event/1/query";
const NOAA_KP     = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const NOAA_WIND   = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
const UPDATE_SECRET = "mira755colo";

const FVG = { lat_min:45.5, lat_max:46.8, lon_min:12.4, lon_max:14.1 };

// ============================================================
// INGV
// ============================================================
async function fetchINGV(giorni = 2) {
  const end   = new Date();
  const start = new Date(end - giorni * 86400000);
  const fmt   = d => d.toISOString().slice(0,19);
  const url   = `${INGV_URL}?format=geojson&starttime=${fmt(start)}&endtime=${fmt(end)}&minmagnitude=0.5`
              + `&minlatitude=${FVG.lat_min}&maxlatitude=${FVG.lat_max}`
              + `&minlongitude=${FVG.lon_min}&maxlongitude=${FVG.lon_max}&orderby=time`;
  const res   = await fetch(url, { headers:{"User-Agent":"SismoFVG/2.0 gimmycloud.com"} });
  if (!res.ok) throw new Error(`INGV ${res.status}`);
  const data  = await res.json();
  return (data.features||[]).map(f => {
    const p = f.properties||{};
    const c = f.geometry?.coordinates||[];
    return {
      id:          String(p.eventId||p.originId||Math.random()),
      data_ora:    p.time ? String(p.time).slice(0,26) : new Date().toISOString(),
      magnitudine: parseFloat(p.mag)||0,
      latitudine:  c[1]!=null ? parseFloat(c[1]) : 0,
      longitudine: c[0]!=null ? parseFloat(c[0]) : 0,
      profondita:  c[2]!=null ? parseFloat(c[2]) : 0,
      localita:    String(p.place||"N/D"),
    };
  });
}

async function salvaEventi(db, eventi) {
  let nuovi = 0;
  for (const e of eventi) {
    const r = await db.prepare(
      `INSERT OR IGNORE INTO terremoti (event_id,data_ora,magnitudine,latitudine,longitudine,profondita,localita)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(e.id,e.data_ora,e.magnitudine,e.latitudine,e.longitudine,e.profondita,e.localita).run();
    if (r.meta.changes > 0) nuovi++;
  }
  const { results } = await db.prepare("SELECT COUNT(*) as n FROM terremoti").all();
  const totale = results[0].n;
  await db.prepare("INSERT INTO fetch_log (data_fetch,nuovi,totale) VALUES (?,?,?)")
    .bind(new Date().toISOString(), nuovi, totale).run();
  return { nuovi, totale };
}

// ============================================================
// NOAA — dati solari
// ============================================================
async function fetchSolare() {
  try {
    const [kpRes, windRes] = await Promise.allSettled([
      fetch(NOAA_KP),
      fetch(NOAA_WIND),
    ]);

    let kpData = [];
    if (kpRes.status === 'fulfilled' && kpRes.value.ok) {
      const raw = await kpRes.value.json();
      kpData = raw
        .filter((_,i) => i % 60 === 0)
        .slice(-72)
        .map(r => ({
          time: r.time_tag,
          kp:   parseFloat(r.kp_index)||0,
        }));
    }

    let windData = null;
    if (windRes.status === 'fulfilled' && windRes.value.ok) {
      const raw = await windRes.value.json();
      const last = raw[raw.length-1]||{};
      windData = {
        speed:   parseFloat(last.proton_speed)||null,
        density: parseFloat(last.proton_density)||null,
        time:    last.time_tag||null,
      };
    }

    return { kpData, windData };
  } catch(e) {
    return { kpData:[], windData:null };
  }
}

async function salvaSolare(db, kpData) {
  for (const r of kpData) {
    await db.prepare(
      `INSERT OR IGNORE INTO dati_solari (time_tag, kp_index) VALUES (?,?)`
    ).bind(r.time, r.kp).run();
  }
}

// ============================================================
// DATI PER DASHBOARD
// ============================================================
async function getDashboardData(db) {
  const [ultimi, stats, mensile, top, solare30, kpMax7] = await Promise.all([
    db.prepare("SELECT * FROM terremoti ORDER BY data_ora DESC LIMIT 100").all(),
    db.prepare("SELECT COUNT(*) as totale, MAX(magnitudine) as max_mag, AVG(magnitudine) as avg_mag, MIN(data_ora) as primo FROM terremoti").all(),
    db.prepare(`SELECT strftime('%Y-%m', data_ora) as mese, COUNT(*) as n, MAX(magnitudine) as max_m
                FROM terremoti GROUP BY mese ORDER BY mese DESC LIMIT 18`).all(),
    db.prepare("SELECT * FROM terremoti ORDER BY magnitudine DESC LIMIT 5").all(),
    db.prepare(`SELECT date(time_tag) as giorno, MAX(kp_index) as kp_max, AVG(kp_index) as kp_avg
                FROM dati_solari
                WHERE time_tag >= datetime('now','-30 days')
                GROUP BY giorno ORDER BY giorno ASC`).all(),
    db.prepare(`SELECT MAX(kp_index) as kp_max FROM dati_solari WHERE time_tag >= datetime('now','-7 days')`).all(),
  ]);

  const sismi30 = await db.prepare(`
    SELECT date(data_ora) as giorno, COUNT(*) as n, MAX(magnitudine) as mag_max
    FROM terremoti
    WHERE data_ora >= datetime('now','-30 days')
    GROUP BY giorno ORDER BY giorno ASC
  `).all();

  return {
    ultimi:   ultimi.results,
    stats:    stats.results[0],
    mensile:  mensile.results,
    top:      top.results,
    solare30: solare30.results,
    sismi30:  sismi30.results,
    kpMax7:   kpMax7.results[0],
  };
}

// ============================================================
// COLORS
// ============================================================
const magColor = m => m>=4.0?'#ff1744':m>=3.0?'#ff6d00':m>=2.0?'#ffd600':'#69f0ae';
const magBg    = m => m>=4.0?'rgba(255,23,68,.15)':m>=3.0?'rgba(255,109,0,.12)':m>=2.0?'rgba(255,214,0,.1)':'rgba(105,240,174,.08)';
const kpColor  = k => k>=7?'#ff1744':k>=5?'#ff6d00':k>=4?'#ffd600':k>=2?'#26c6da':'#546e7a';
const kpLabel  = k => k>=7?'TEMPESTA FORTE':k>=5?'TEMPESTA MODERATA':k>=4?'ATTIVA':k>=2?'QUIETE':'CALMA';

// ============================================================
// HTML DASHBOARD v2
// ============================================================
function renderDashboard(data) {
  const { ultimi, stats, mensile, top, solare30, sismi30, kpMax7 } = data;
  const now = new Date().toLocaleString("it-IT",{timeZone:"Europe/Rome"});

  const ultiRows = ultimi.slice(0,50).map(e => {
    const d = new Date(e.data_ora);
    const dIT = d.toLocaleString("it-IT",{timeZone:"Europe/Rome",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const m = e.magnitudine;
    return `<tr style="background:${magBg(m)};border-bottom:1px solid rgba(255,255,255,.04)">
      <td style="padding:9px 14px;font-weight:700;color:${magColor(m)};font-size:1.1em;font-family:'Share Tech Mono',monospace">M${m.toFixed(1)}</td>
      <td style="padding:9px 14px;color:#cfd8dc;font-size:.83em">${dIT}</td>
      <td style="padding:9px 14px;color:#eceff1">${e.localita}</td>
      <td style="padding:9px 14px;color:#90a4ae;font-size:.83em">${e.profondita?e.profondita.toFixed(1)+'km':'—'}</td>
    </tr>`;
  }).join("");

  const topRows = top.map((e,i) => {
    const m = ['🥇','🥈','🥉','4.','5.'];
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="font-size:1.2em;width:28px">${m[i]}</span>
      <span style="font-size:1.5em;font-weight:800;color:${magColor(e.magnitudine)}">M${e.magnitudine.toFixed(1)}</span>
      <div style="flex:1;min-width:0">
        <div style="color:#eceff1;font-size:.88em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.localita}</div>
        <div style="color:#546e7a;font-size:.75em">${new Date(e.data_ora).toLocaleDateString("it-IT")}</div>
      </div>
    </div>`;
  }).join("");

  // Timeline doppia SVG
  const allDays = [...new Set([
    ...solare30.map(r=>r.giorno),
    ...sismi30.map(r=>r.giorno),
  ])].sort();

  const maxKp  = Math.max(...solare30.map(r=>parseFloat(r.kp_max)||0), 6);
  const maxN   = Math.max(...sismi30.map(r=>parseInt(r.n)||0), 1);
  const W=780, H_KP=90, H_SISMO=75, PAD=44, GAP=28, totalH=H_KP+GAP+H_SISMO+24;
  const nDays  = allDays.length||1;
  const barW   = Math.max(2, Math.floor((W-PAD*2)/nDays)-2);

  const kpMap    = Object.fromEntries(solare30.map(r=>[r.giorno,parseFloat(r.kp_max)||0]));
  const sismiMap = Object.fromEntries(sismi30.map(r=>[r.giorno,{n:parseInt(r.n)||0,mag:parseFloat(r.mag_max)||0}]));

  const kpBars = allDays.map((day,i)=>{
    const kp=kpMap[day]||0;
    const h=Math.max(2,Math.round((kp/maxKp)*H_KP));
    const x=PAD+i*((W-PAD*2)/nDays);
    const c=kpColor(kp);
    const glow=kp>=5?`filter="url(#glow)"`:'' ;
    return `<rect x="${x}" y="${H_KP-h}" width="${barW}" height="${h}" fill="${c}" rx="2" opacity="0.9"/>`;
  }).join("");

  const sismoBars = allDays.map((day,i)=>{
    const s=sismiMap[day]||{n:0,mag:0};
    const h=s.n>0?Math.max(4,Math.round((s.n/maxN)*H_SISMO)):0;
    const x=PAD+i*((W-PAD*2)/nDays);
    const yBase=H_KP+GAP+H_SISMO;
    const c=s.mag>=3?'#ff6d00':s.mag>=2?'#ffd600':'#26c6da';
    return h>0?`<rect x="${x}" y="${yBase-h}" width="${barW}" height="${h}" fill="${c}" rx="2" opacity="0.85"/>`:'' ;
  }).join("");

  const xLabels = allDays.filter((_,i)=>i%5===0||i===allDays.length-1).map(day=>{
    const idx=allDays.indexOf(day);
    const x=PAD+idx*((W-PAD*2)/nDays)+barW/2;
    return `<text x="${x}" y="${totalH+2}" text-anchor="middle" fill="#455a64" font-size="9" font-family="monospace">${day.slice(5)}</text>`;
  }).join("");

  const coincidenze = allDays.filter(day=>(kpMap[day]||0)>=4&&(sismiMap[day]?.n||0)>0);
  const totGiorni   = allDays.filter(day=>(sismiMap[day]?.n||0)>0).length;
  const hitRate     = totGiorni>0?Math.round((coincidenze.length/totGiorni)*100):0;
  const kpNow       = kpMax7?.kp_max?parseFloat(kpMax7.kp_max).toFixed(1):'—';

  const maxMens=Math.max(...mensile.map(m=>m.n),1);
  const bH=100,bW2=mensile.length>0?Math.floor(480/mensile.length)-3:20;
  const barreMens=[...mensile].reverse().map((m,i)=>{
    const h=Math.round((m.n/maxMens)*bH);
    const x=i*(bW2+3);
    const c=m.max_m>=3?'#ff6d00':'#26c6da';
    return `<g><rect x="${x}" y="${bH-h}" width="${bW2}" height="${h}" fill="${c}" rx="2" opacity=".85"/>
    <text x="${x+bW2/2}" y="${bH+13}" text-anchor="middle" fill="#455a64" font-size="8">${m.mese.slice(2)}</text>
    <text x="${x+bW2/2}" y="${bH-h-3}" text-anchor="middle" fill="#78909c" font-size="8">${m.n}</text></g>`;
  }).join("");
  const svgMW=mensile.length*(bW2+3)||480;

  const coincRows = coincidenze.length===0
    ? '<p style="color:#455a64;font-size:.85em;font-family:\'Share Tech Mono\',monospace">Nessuna coincidenza nei dati disponibili. I dati solari si accumulano ad ogni aggiornamento.</p>'
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px">${
        coincidenze.map(day=>{
          const kp=kpMap[day]||0;
          const s=sismiMap[day]||{n:0,mag:0};
          return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.83em">
            <span style="color:#ffd600;font-family:'Share Tech Mono',monospace;min-width:55px">${day.slice(5)}</span>
            <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:.7em;font-weight:700;font-family:'Share Tech Mono',monospace;background:${kpColor(kp)}22;color:${kpColor(kp)};border:1px solid ${kpColor(kp)}44">Kp ${kp.toFixed(1)}</span>
            <span style="color:#eceff1">${s.n} eventi</span>
            <span style="color:${magColor(s.mag)};font-weight:700">M${s.mag.toFixed(1)}</span>
          </div>`;
        }).join("")
      }</div>`;

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECHO Monitor — Sismo FVG + Solare</title>
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEDUlEQVR4nLWXTWhcVRTHf+e+92Y6k6QJSUybOlFJbRNaW2ILWURBqAh+BOlOdOFCF4KIG1EpFPzY60J0KfgBKqRRRCVVF35RNUVMKVZE0UglWBuHJtPJfLyZ946LN8m8eZk3E5vkv5nLvXPP+d1z3j33XunPjCmbkkR+w+biTMvamNmc87ATv9aW0FgUbr22ACAMoTWQsJpB6FrfFgFEHWqoveow2hf021sPUDfeCNWsf8tSEOe4mYQw0DYAhBUOfRig3rcpAAEk/gOPcbq6U+TaAETq06s+VKr1gJpYmOjOqOt/AYhAyQ3MFVy45Qbh2CHIl4OxfKldRFZTUt+aGwYQwK3CvkFIJ6BYgtHrlYn9SrkMjgWTR4VKVVtEYlX1iGwcwASrH9kDLz0MxlMWsnBx0eDn4dnjwsEMFMpQqoDnt6p/dbWvA8aguTxy/530XP6XT779iV09KQ4M+6STUHB9Dh2EXxaED88qrieM3wgLWVgqgBW7xCAV8QCmNtMIVKpYo8OoX8W9WmT29zTvPw17dwc5XSnBM2/7rBSFNx4HVeHke7pmIl5xldD30WIJvZLDmTwGnocUSujEOLvnzjP9ZJHBASGXVwRDwvZ57TGlUBbePSN8OudjLGFnGhzTujStB/B9pLMDM3YAa3iIxD13IEkHy7FZ6s9w38UZBndeYHkljWMURClVDMmUz20jynNTyqN3wdWicv5P4dJya4hGABFQhYSDNTiAffNNmN4epCOFcSzUsulISWgjKWiQJV+FpA0je4Qje5W/s8Ifl0CvABaxBI0AqmDbaHYJd/o05TenST4wiSYTOMMZ7MOHmf1+CR2zcSxwK4IRxVPFOHBhAb77VfniBzBp6NwBSScwGyezbrOogm2Q7i7M4HVUZ89RmT6Nh2B9NMO5z+c58UGSVMqnuxu6uqCnF059KUydEU49JZx4UOjrau88FAFDw8GhgOcFTbcCnocu5WA5h3EsvvlZeeRVw8R+2JGAH+fh7G/KPzl44nXh+Dj0pGExFxSoVgzSn7k1NN7kryJQrWIN9JHPlTnan+fFh2zufkHZNwSZXpj5WnnnpPDZeXjrK7CtIPztK2JDJRSiZ3XAVPsuFrP4yyvs6rN5fkopu3D7KNx7BKy08PLHMNQnpBPQ17kx57CWgtXjUmh6cqniWzadnTAzp1gGkh3wVxaMCCapzF+GV2aUVBIq3sacQ0MKomd2zITacez5kHDAiFJ0JSi52v4+FFVoG0bvcM1Nac2JCLgVUAQj7b/2OEWqdZA4EVk/1EQiYG0w1y0AwpeEYBnBaqKPjOba5LMqvMzwBbL5/W07FAGIOmr2zNo2gDBI3EsmGo3NQ0UAmmW02Y3WrJ+6NQBRxdWFaJSuXf8BvyFun5BoZfoAAAAASUVORK5CYII=">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;
  background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);
  background-size:40px 40px;pointer-events:none;z-index:0}
.container{max-width:1280px;margin:0 auto;padding:24px 20px;position:relative;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;padding:20px 0 28px;border-bottom:1px solid rgba(38,198,218,.15);margin-bottom:28px;flex-wrap:wrap;gap:16px}
.logo{display:flex;align-items:center;gap:16px}
.logo-icon{width:50px;height:50px;background:radial-gradient(circle,#ff6d00,#e53935);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.7em;box-shadow:0 0 28px rgba(255,109,0,.5);animation:pulse 2.5s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 28px rgba(255,109,0,.5)}50%{box-shadow:0 0 50px rgba(255,109,0,.9)}}
.logo-text h1{font-size:1.7em;font-weight:800;letter-spacing:.02em}
.logo-text p{font-size:.78em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-top:3px}
.echo-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.25);border-radius:20px;padding:3px 12px;font-size:.6em;font-family:'Share Tech Mono',monospace;color:#26c6da;margin-left:12px;vertical-align:middle}
.update-info{text-align:right;font-family:'Share Tech Mono',monospace;font-size:.75em;color:#546e7a;line-height:1.8}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#69f0ae;animation:blink 1.5s ease-in-out infinite;margin-right:6px;vertical-align:middle}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.btn{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 16px;border-radius:6px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.78em;text-decoration:none;display:inline-block;transition:all .2s;margin-top:6px}
.btn:hover{background:rgba(38,198,218,.2)}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:24px}
.stat-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:18px 20px;position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat-card.blue::before{background:linear-gradient(90deg,#26c6da,transparent)}
.stat-card.orange::before{background:linear-gradient(90deg,#ff6d00,transparent)}
.stat-card.yellow::before{background:linear-gradient(90deg,#ffd600,transparent)}
.stat-card.green::before{background:linear-gradient(90deg,#69f0ae,transparent)}
.stat-label{font-size:.7em;color:#546e7a;text-transform:uppercase;letter-spacing:.1em;font-family:'Share Tech Mono',monospace;margin-bottom:8px}
.stat-value{font-size:2em;font-weight:800;color:#eceff1;line-height:1}
.stat-sub{font-size:.73em;color:#78909c;margin-top:6px}
.panel{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:14px;overflow:hidden;margin-bottom:20px}
.panel-header{padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.07);font-size:.73em;font-weight:600;color:#546e7a;text-transform:uppercase;letter-spacing:.12em;font-family:'Share Tech Mono',monospace;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.acc{color:#26c6da}
.panel-body{padding:16px 20px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
@media(max-width:800px){.grid-2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 14px;font-size:.68em;color:#455a64;text-transform:uppercase;letter-spacing:.08em;font-family:'Share Tech Mono',monospace;border-bottom:1px solid rgba(255,255,255,.07)}
footer{text-align:center;padding:28px 0 18px;color:#263238;font-size:.73em;font-family:'Share Tech Mono',monospace;border-top:1px solid rgba(255,255,255,.04);margin-top:32px}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>
<div class="container">

<header>
  <div class="logo">
    <div class="logo-icon"><img src="data:image/png;base64,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" style="width:100%;height:100%;border-radius:50%;object-fit:cover"></div>
    <div class="logo-text">
      <h1>SISMO FVG <span class="echo-badge">☀ PROGETTO ECHO v2</span></h1>
      <p>monitor sismico + correlazione solare NOAA // friuli venezia giulia</p>
    </div>
  </div>
  <div class="update-info">
    <div><span class="live-dot"></span>LIVE — INGV + NOAA SWPC</div>
    <div>${now}</div>
    <a href="/update?token=mira755colo" class="btn">↻ Aggiorna ora</a>
  </div>
</header>

<div class="stats-grid">
  <div class="stat-card blue">
    <div class="stat-label">🌍 Totale eventi FVG</div>
    <div class="stat-value">${stats.totale||0}</div>
    <div class="stat-sub">dal ${stats.primo?new Date(stats.primo).toLocaleDateString("it-IT"):'—'}</div>
  </div>
  <div class="stat-card orange">
    <div class="stat-label">⚡ Magnitudo massima</div>
    <div class="stat-value" style="color:${magColor(stats.max_mag||0)}">${stats.max_mag?'M'+Number(stats.max_mag).toFixed(1):'—'}</div>
    <div class="stat-sub">evento più forte registrato</div>
  </div>
  <div class="stat-card yellow">
    <div class="stat-label">☀ Kp max (7 giorni)</div>
    <div class="stat-value" style="color:${kpColor(parseFloat(kpNow)||0)}">${kpNow}</div>
    <div class="stat-sub">${kpLabel(parseFloat(kpNow)||0)}</div>
  </div>
  <div class="stat-card green">
    <div class="stat-label">🔗 Hit rate correlazione</div>
    <div class="stat-value" style="color:${hitRate>60?'#ff6d00':hitRate>30?'#ffd600':'#69f0ae'}">${hitRate}%</div>
    <div class="stat-sub">Kp≥4 + sismi FVG stesso giorno (30gg)</div>
  </div>
</div>

<!-- TIMELINE DOPPIA — il cuore del Progetto ECHO -->
<div class="panel">
  <div class="panel-header">
    <span>📡 <span class="acc">TIMELINE CORRELAZIONE SISMO-SOLARE</span> — ultimi 30 giorni</span>
    <span style="color:#455a64">☀ Kp index &nbsp;·&nbsp; 🌍 eventi FVG/giorno</span>
  </div>
  <div class="panel-body" style="overflow-x:auto">
    <svg width="100%" viewBox="0 0 ${W} ${totalH+14}" style="overflow:visible;min-width:520px">
      <text x="${PAD}" y="11" fill="#26c6da" font-size="10" font-family="monospace" font-weight="700">☀ SOLARE — Kp index (max/giorno)</text>
      ${kpBars}
      <line x1="${PAD}" y1="${H_KP+GAP/2}" x2="${W-PAD}" y2="${H_KP+GAP/2}" stroke="rgba(255,255,255,.05)" stroke-width="1" stroke-dasharray="4,4"/>
      <text x="${PAD}" y="${H_KP+GAP+11}" fill="#69f0ae" font-size="10" font-family="monospace" font-weight="700">🌍 SISMICITÀ FVG — eventi/giorno</text>
      ${sismoBars}
      ${xLabels}
      <text x="${W-PAD+5}" y="${H_KP}" fill="#455a64" font-size="8" font-family="monospace">${maxKp.toFixed(0)}</text>
    </svg>
    <div style="display:flex;gap:18px;margin-top:14px;font-size:.7em;font-family:'Share Tech Mono',monospace;flex-wrap:wrap;color:#546e7a">
      <span><span style="color:#ff1744">■</span> Kp≥7 Tempesta forte</span>
      <span><span style="color:#ff6d00">■</span> Kp≥5 Moderata</span>
      <span><span style="color:#ffd600">■</span> Kp≥4 Attiva</span>
      <span><span style="color:#26c6da">■</span> Normale</span>
      <span style="margin-left:12px"><span style="color:#ff6d00">■</span> Sisma M≥3</span>
      <span><span style="color:#ffd600">■</span> M≥2</span>
      <span><span style="color:#26c6da">■</span> M&lt;2</span>
    </div>
  </div>
</div>

<!-- COINCIDENZE -->
<div class="panel">
  <div class="panel-header">
    <span>🔗 <span class="acc">COINCIDENZE RILEVATE</span> — giorni Kp≥4 con sismicità FVG</span>
    <span style="color:${hitRate>60?'#ff6d00':hitRate>30?'#ffd600':'#69f0ae'};font-size:1.1em;font-weight:700">${coincidenze.length} / ${totGiorni} giorni — ${hitRate}%</span>
  </div>
  <div class="panel-body">
    ${coincRows}
    <div style="margin-top:16px;padding:12px 16px;background:rgba(38,198,218,.04);border-radius:8px;border-left:3px solid rgba(38,198,218,.25)">
      <div style="font-size:.72em;color:#546e7a;font-family:'Share Tech Mono',monospace;line-height:1.9">
        ℹ METODOLOGIA: correlazione osservazionale. Il dataset cresce ogni giorno.<br>
        Delay +24h/+48h/+72h post-tempesta in sviluppo (TODO 2 — Progetto ECHO).<br>
        Significatività statistica aumenta con l'accumulo dei dati.
      </div>
    </div>
  </div>
</div>

<div class="grid-2">
  <div class="panel" style="margin-bottom:0">
    <div class="panel-header">📊 <span class="acc">Attività mensile FVG</span></div>
    <div class="panel-body">
      <svg width="100%" viewBox="0 0 ${svgMW+10} ${bH+24}" style="overflow:visible">${barreMens}</svg>
      <div style="margin-top:8px;font-size:.7em;color:#455a64;font-family:'Share Tech Mono',monospace">
        <span style="color:#ff6d00">■</span> M≥3 &nbsp; <span style="color:#26c6da">■</span> normale
      </div>
    </div>
  </div>
  <div class="panel" style="margin-bottom:0">
    <div class="panel-header">🏆 <span class="acc">Top 5 più forti</span></div>
    <div class="panel-body">${topRows||'<p style="color:#455a64;font-size:.85em">Nessun dato</p>'}</div>
  </div>
</div>

<div class="panel" style="margin-top:20px">
  <div class="panel-header">⚡ <span class="acc">Ultimi 50 eventi FVG</span> ≥ M0.5</div>
  <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Mag</th><th>Data/Ora</th><th>Località</th><th>Profondità</th></tr></thead>
      <tbody>${ultiRows||'<tr><td colspan="4" style="padding:20px;color:#455a64;text-align:center">Nessun dato. <a href="/update?token=mira755colo" style="color:#26c6da">Aggiorna →</a></td></tr>'}</tbody>
    </table>
  </div>
</div>

<div class="panel">
  <div class="panel-header">🔗 <span class="acc">API endpoint</span></div>
  <div class="panel-body" style="font-family:'Share Tech Mono',monospace;font-size:.78em;color:#78909c;line-height:2.1">
    <div><span style="color:#26c6da">GET</span> /api/events?giorni=7&mag=2.0</div>
    <div><span style="color:#26c6da">GET</span> /api/solar — dati Kp giornalieri (JSON)</div>
    <div><span style="color:#26c6da">GET</span> /api/stats — statistiche generali</div>
    <div><span style="color:#69f0ae">GET</span> /update?token=*** — forza aggiornamento INGV + NOAA</div>
  </div>
</div>

</div>

<div class="panel" style="margin-top:20px">
  <div class="panel-header">🎮 <span class="acc">ECHO GAMES</span></div>
  <div class="panel-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="font-size:2.5em;line-height:1">🔴🟡</div>
    <div>
      <div style="font-weight:700;font-size:1.05em;margin-bottom:4px">Forza 4</div>
      <div style="font-size:.75em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-bottom:12px">gioco classico // 2 giocatori // canvas game</div>
      <a href="/forza4" style="display:inline-block;padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.82em">&#9654; Gioca ora</a>
    </div>
  </div>
</div>

<footer>
  ECHO MONITOR v2 — <a href="https://gimmycloud.com">gimmycloud.com</a> //
  sismicità: <a href="https://www.ingv.it" target="_blank">INGV</a> —
  dati solari: <a href="https://www.swpc.noaa.gov" target="_blank">NOAA SWPC</a> //
  Gimmy Pignolo © 2026 // <span style="color:#26c6da">Progetto ECHO</span>
</footer>
</body>
</html>`;
}

// ============================================================
// FORZA 4 — ECHO Games
// ============================================================
function renderForza4() {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forza 4 — ECHO Games</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;width:100%;max-width:760px;text-align:center}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 0 18px;border-bottom:1px solid rgba(38,198,218,.15);margin-bottom:16px}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.sbar{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:12px}
.ps{display:flex;align-items:center;gap:10px;font-family:'Share Tech Mono',monospace}
.dot{width:18px;height:18px;border-radius:50%}
.dot1{background:radial-gradient(circle at 35% 35%,#ff8a80,#c62828)}
.dot2{background:radial-gradient(circle at 35% 35%,#fff176,#f9a825)}
.sv{font-size:1.35em;font-weight:700}
#cvs{border-radius:10px;cursor:pointer;touch-action:none;max-width:100%}
.brow{display:flex;gap:10px;justify-content:center;margin-top:10px}
.gbtn{padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.82em;transition:background .1s,transform .1s}
.gbtn:hover{background:rgba(38,198,218,.25)}
.gbtn:active{background:rgba(38,198,218,.45);transform:scale(.96)}
footer{margin-top:16px;font-size:.7em;color:#263238;font-family:'Share Tech Mono',monospace}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="/" class="back">&#8592; ECHO Monitor</a>
    <div>
      <div style="font-size:1.7em;font-weight:800"><span style="color:#ef5350">FORZA</span> <span style="color:#ffd600">4</span></div>
      <div style="font-size:.7em;color:#546e7a;font-family:'Share Tech Mono',monospace">2 giocatori // ECHO Games</div>
    </div>
    <div style="width:120px"></div>
  </div>
  <div class="sbar">
    <div class="ps"><div class="dot dot1"></div><div><div style="font-size:.68em;color:#546e7a">GIOCATORE 1</div><div class="sv" id="s1" style="color:#ef5350">0</div></div></div>
    <div style="font-size:.76em;color:#546e7a;font-family:'Share Tech Mono',monospace" id="ti">Turno: Giocatore 1</div>
    <div class="ps" style="flex-direction:row-reverse"><div class="dot dot2"></div><div style="text-align:right"><div style="font-size:.68em;color:#546e7a">GIOCATORE 2</div><div class="sv" id="s2" style="color:#ffd600">0</div></div></div>
  </div>
  <canvas id="cvs"></canvas>
  <div class="brow"><button class="gbtn" id="rbtn">&#8635; Nuova partita</button><button class="gbtn" id="mbtn">vs CPU: OFF</button></div>
  <footer>ECHO Games // <a href="/">&#8592; torna al monitor sismico</a></footer>
</div>
<script>
window.onerror=function(msg,src,line,col,err){
  var el=document.createElement('div');
  el.style='background:#b71c1c;color:#fff;padding:10px;border-radius:6px;font-family:monospace;font-size:12px;margin:10px 0;text-align:left';
  el.textContent='ERRORE JS: '+msg+' (linea '+line+')';
  document.querySelector('.wrap').insertBefore(el,document.getElementById('cvs'));
  return true;
};
(function(){
var COLS=7,ROWS=6,CELL,RAD,MX,TY,W,H;
var board,cur,over,wcells,drp,parts,hov,sc,wt,lastT,rf,aiMode,aiWait;
var cvs,ctx;
var C1='#ef5350',C1L='#ff8a80',C1D='#b71c1c';
var C2='#ffd600',C2L='#ffff6b',C2D='#c6a700';

function initCvs(){
  cvs=document.getElementById('cvs');ctx=cvs.getContext('2d');
  var mw=Math.min(window.innerWidth-44,720);
  CELL=Math.floor(mw/(COLS+1.1));RAD=Math.floor(CELL*.42);
  MX=Math.floor(CELL*.55);TY=Math.floor(CELL*1.55);
  W=COLS*CELL+MX*2;H=ROWS*CELL+TY+MX;
  cvs.width=W;cvs.height=H;cvs.style.width=W+'px';cvs.style.height=H+'px';
}
function bx(c){return MX+c*CELL+CELL/2;}
function by(r){return TY+r*CELL+CELL/2;}

function reset(){
  board=[];
  for(var r=0;r<ROWS;r++){board.push([]);for(var c=0;c<COLS;c++)board[r].push(0);}
  cur=1;over=false;wcells=[];drp=null;parts=[];hov=-1;wt=0;rf=0.35;aiWait=false;uiUpd();
}
function uiUpd(){
  document.getElementById('s1').textContent=sc[0];
  document.getElementById('s2').textContent=sc[1];
  var ti=document.getElementById('ti');
  if(over)ti.textContent=wcells.length?(aiMode&&cur===2?'Computer VINCE! \uD83E\uDD16':'Giocatore '+cur+' VINCE! \uD83C\uDFC6'):'PAREGGIO!';
  else ti.textContent=aiMode&&cur===2?'Computer sta pensando... \uD83E\uDD16':'Turno: Giocatore '+cur;
}

function chkWin(p){
  var r,c;
  for(r=0;r<ROWS;r++)for(c=0;c<=COLS-4;c++)
    if(board[r][c]===p&&board[r][c+1]===p&&board[r][c+2]===p&&board[r][c+3]===p)return[[r,c],[r,c+1],[r,c+2],[r,c+3]];
  for(r=0;r<=ROWS-4;r++)for(c=0;c<COLS;c++)
    if(board[r][c]===p&&board[r+1][c]===p&&board[r+2][c]===p&&board[r+3][c]===p)return[[r,c],[r+1,c],[r+2,c],[r+3,c]];
  for(r=3;r<ROWS;r++)for(c=0;c<=COLS-4;c++)
    if(board[r][c]===p&&board[r-1][c+1]===p&&board[r-2][c+2]===p&&board[r-3][c+3]===p)return[[r,c],[r-1,c+1],[r-2,c+2],[r-3,c+3]];
  for(r=0;r<=ROWS-4;r++)for(c=0;c<=COLS-4;c++)
    if(board[r][c]===p&&board[r+1][c+1]===p&&board[r+2][c+2]===p&&board[r+3][c+3]===p)return[[r,c],[r+1,c+1],[r+2,c+2],[r+3,c+3]];
  return null;
}
function full(){for(var c=0;c<COLS;c++)if(board[0][c]===0)return false;return true;}

function dropPiece(col){
  if(over||drp)return;
  var row=-1;
  for(var r=ROWS-1;r>=0;r--)if(board[r][col]===0){row=r;break;}
  if(row===-1)return;
  drp={col:col,row:row,y:TY-CELL*.7,sp:CELL*.1,pl:cur};
}

function Pt(x,y,col){
  this.x=x;this.y=y;this.col=col;
  this.vx=(Math.random()-.5)*CELL*.12;
  this.vy=-(Math.random()*CELL*.14+CELL*.05);
  this.life=0;this.ml=.8+Math.random()*.7;
  this.sz=RAD*.15+Math.random()*RAD*.18;
}
Pt.prototype.upd=function(dt){
  this.life+=dt;this.vy+=CELL*.4*dt;
  this.x+=this.vx;this.y+=this.vy;this.sz*=.97;
};
Pt.prototype.draw=function(){
  if(this.life>=this.ml)return;
  ctx.save();ctx.globalAlpha=1-this.life/this.ml;
  ctx.fillStyle=this.col;ctx.beginPath();ctx.arc(this.x,this.y,this.sz,0,Math.PI*2);ctx.fill();ctx.restore();
};
function spawn(x,y,pl,n){var col=pl===1?C1:C2;for(var i=0;i<n;i++)parts.push(new Pt(x,y,col));}

function drawPiece(x,y,pl,al){
  if(al===undefined)al=1;
  var main=pl===1?C1:C2,lt=pl===1?C1L:C2L,dk=pl===1?C1D:C2D;
  ctx.save();ctx.globalAlpha=al;
  ctx.shadowColor='rgba(0,0,0,.5)';ctx.shadowBlur=RAD*.3;ctx.shadowOffsetY=RAD*.1;
  ctx.beginPath();ctx.arc(x,y,RAD,0,Math.PI*2);ctx.fillStyle=dk;ctx.fill();
  ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
  ctx.beginPath();ctx.arc(x,y,RAD-2,0,Math.PI*2);ctx.fillStyle=main;ctx.fill();
  var g=ctx.createRadialGradient(x-RAD*.3,y-RAD*.3,0,x,y,RAD);
  g.addColorStop(0,'rgba(255,255,255,.35)');g.addColorStop(.5,'rgba(255,255,255,.05)');g.addColorStop(1,'rgba(0,0,0,.2)');
  ctx.beginPath();ctx.arc(x,y,RAD-2,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();ctx.arc(x-RAD*.3,y-RAD*.3,RAD*.2,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,.65)';ctx.fill();
  ctx.restore();
}
function rr(x,y,w,h,r){
  ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
}
function drawBoard(){
  ctx.save();ctx.shadowColor='rgba(0,0,0,.6)';ctx.shadowBlur=20;ctx.shadowOffsetY=8;
  rr(MX,TY-10,COLS*CELL,ROWS*CELL+20,13);ctx.fillStyle='rgba(25,50,160,1)';ctx.fill();
  ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
  ctx.strokeStyle='rgba(60,100,220,1)';ctx.lineWidth=3;ctx.stroke();ctx.restore();
  for(var r=0;r<ROWS;r++){
    for(var c=0;c<COLS;c++){
      var cx=bx(c),cy=by(r);
      ctx.beginPath();ctx.arc(cx,cy,RAD+4,0,Math.PI*2);ctx.fillStyle='rgba(5,10,35,1)';ctx.fill();
      var cell=board[r][c];
      if(cell!==0){
        if(drp&&drp.row===r&&drp.col===c)continue;
        var inw=false;
        for(var w=0;w<wcells.length;w++)if(wcells[w][0]===r&&wcells[w][1]===c){inw=true;break;}
        drawPiece(cx,cy,cell,inw&&wt>0?.4+.6*Math.abs(Math.sin(wt*5)):1);
      } else {
        ctx.beginPath();ctx.arc(cx,cy,RAD,0,Math.PI*2);ctx.fillStyle='rgba(10,18,60,1)';ctx.fill();
      }
    }
  }
}
function drawHov(){
  if(hov<0||over||drp)return;
  var x=bx(hov),t=Date.now()/1000,yo=Math.sin(t*4)*6,y=TY-CELL*.6+yo;
  drawPiece(x,y,cur,.7);
  ctx.save();ctx.fillStyle=cur===1?C1:C2;ctx.globalAlpha=.8;
  ctx.beginPath();ctx.moveTo(x,y+RAD+12);ctx.lineTo(x-8,y+RAD+2);ctx.lineTo(x+8,y+RAD+2);ctx.closePath();ctx.fill();ctx.restore();
}
function drawEnd(){
  if(!over)return;
  ctx.save();ctx.fillStyle='rgba(0,0,0,.6)';ctx.fillRect(0,0,W,H);
  var pw=W*.78,ph=130,px=(W-pw)/2,py=(H-ph)/2;
  rr(px,py,pw,ph,16);ctx.fillStyle='rgba(10,15,40,.95)';ctx.fill();
  var bc=wcells.length?(cur===1?C1:C2):'#26c6da';
  ctx.strokeStyle=bc;ctx.lineWidth=2.5;ctx.stroke();
  ctx.textAlign='center';
  ctx.font='bold '+Math.floor(CELL*.42)+'px "Exo 2",sans-serif';ctx.fillStyle=bc;
  ctx.fillText(wcells.length?'GIOCATORE '+cur+' VINCE! \uD83C\uDFC6':'PAREGGIO!',W/2,py+ph/2-10);
  ctx.font=Math.floor(CELL*.21)+'px "Share Tech Mono",monospace';ctx.fillStyle='#546e7a';
  ctx.fillText('premi R o clicca Nuova partita',W/2,py+ph/2+26);ctx.restore();
}

function update(dt){
  if(drp){
    var ty=by(drp.row);drp.sp+=CELL*.8*dt;drp.y+=drp.sp;
    if(drp.y>=ty){
      drp.y=ty;board[drp.row][drp.col]=drp.pl;
      spawn(bx(drp.col),by(drp.row),drp.pl,12);
      var win=chkWin(drp.pl);
      if(win){over=true;wcells=win;for(var w=0;w<win.length;w++)spawn(bx(win[w][1]),by(win[w][0]),drp.pl,18);sc[drp.pl-1]++;}
      else if(full())over=true;
      else{cur=3-drp.pl;}
      drp=null;uiUpd();
      if(aiMode&&!over&&cur===2){aiWait=true;setTimeout(function(){aiWait=false;if(!over&&cur===2&&!drp)aiMove();},520);}
    }
  }
  for(var i=parts.length-1;i>=0;i--){
    parts[i].upd(dt);if(parts[i].life>=parts[i].ml||parts[i].sz<.5)parts.splice(i,1);
  }
  if(over&&wcells.length)wt+=dt;
  if(rf>0)rf-=dt;
}
function draw(){
  ctx.clearRect(0,0,W,H);
  var g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'#080e14');g.addColorStop(1,'#0d1520');
  ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  drawHov();drawBoard();
  if(drp)drawPiece(bx(drp.col),drp.y,drp.pl,1);
  for(var i=0;i<parts.length;i++)parts[i].draw();
  drawEnd();
  if(rf>0){ctx.save();ctx.globalAlpha=rf/0.35*0.45;ctx.fillStyle='#26c6da';ctx.fillRect(MX,TY-10,COLS*CELL,ROWS*CELL+20);ctx.restore();}
}
function loop(ts){
  var now=ts/1000,dt=Math.min(now-(lastT||now),.05);lastT=now;update(dt);draw();requestAnimationFrame(loop);
}
function gcol(cx){
  var rect=cvs.getBoundingClientRect(),sx=W/rect.width,mx=(cx-rect.left)*sx;
  var col=Math.floor((mx-MX)/CELL);return(col>=0&&col<COLS)?col:-1;
}
function sc4(w,pl){
  var p=0,o=0,opp=pl===1?2:1,i;
  for(i=0;i<4;i++){if(w[i]===pl)p++;else if(w[i]===opp)o++;}
  if(o>0)return 0;if(p===4)return 100;if(p===3)return 5;if(p===2)return 2;return 0;
}
function bdSc(bd,pl){
  var s=0,mid=Math.floor(COLS/2),r,c,opp=pl===1?2:1;
  for(r=0;r<ROWS;r++)if(bd[r][mid]===pl)s+=3;
  for(r=0;r<ROWS;r++)for(c=0;c<=COLS-4;c++){s+=sc4([bd[r][c],bd[r][c+1],bd[r][c+2],bd[r][c+3]],pl);s-=sc4([bd[r][c],bd[r][c+1],bd[r][c+2],bd[r][c+3]],opp);}
  for(c=0;c<COLS;c++)for(r=0;r<=ROWS-4;r++){s+=sc4([bd[r][c],bd[r+1][c],bd[r+2][c],bd[r+3][c]],pl);s-=sc4([bd[r][c],bd[r+1][c],bd[r+2][c],bd[r+3][c]],opp);}
  for(r=3;r<ROWS;r++)for(c=0;c<=COLS-4;c++){s+=sc4([bd[r][c],bd[r-1][c+1],bd[r-2][c+2],bd[r-3][c+3]],pl);s-=sc4([bd[r][c],bd[r-1][c+1],bd[r-2][c+2],bd[r-3][c+3]],opp);}
  for(r=0;r<=ROWS-4;r++)for(c=0;c<=COLS-4;c++){s+=sc4([bd[r][c],bd[r+1][c+1],bd[r+2][c+2],bd[r+3][c+3]],pl);s-=sc4([bd[r][c],bd[r+1][c+1],bd[r+2][c+2],bd[r+3][c+3]],opp);}
  return s;
}
function winOn(bd,pl){
  var r,c;
  for(r=0;r<ROWS;r++)for(c=0;c<=COLS-4;c++)if(bd[r][c]===pl&&bd[r][c+1]===pl&&bd[r][c+2]===pl&&bd[r][c+3]===pl)return true;
  for(r=0;r<=ROWS-4;r++)for(c=0;c<COLS;c++)if(bd[r][c]===pl&&bd[r+1][c]===pl&&bd[r+2][c]===pl&&bd[r+3][c]===pl)return true;
  for(r=3;r<ROWS;r++)for(c=0;c<=COLS-4;c++)if(bd[r][c]===pl&&bd[r-1][c+1]===pl&&bd[r-2][c+2]===pl&&bd[r-3][c+3]===pl)return true;
  for(r=0;r<=ROWS-4;r++)for(c=0;c<=COLS-4;c++)if(bd[r][c]===pl&&bd[r+1][c+1]===pl&&bd[r+2][c+2]===pl&&bd[r+3][c+3]===pl)return true;
  return false;
}
function vCols(bd){var v=[],c;for(c=0;c<COLS;c++)if(bd[0][c]===0)v.push(c);return v;}
function drpBd(bd,col,pl){var nb=[],r;for(r=0;r<ROWS;r++)nb.push(bd[r].slice());for(r=ROWS-1;r>=0;r--)if(nb[r][col]===0){nb[r][col]=pl;break;}return nb;}
function mm(bd,depth,al,be,max){
  var v=vCols(bd),i,nb,res,mid=Math.floor(COLS/2);
  if(winOn(bd,2))return{s:100000+depth,c:-1};
  if(winOn(bd,1))return{s:-100000-depth,c:-1};
  if(!v.length||!depth)return{s:bdSc(bd,2),c:-1};
  v.sort(function(a,b){return Math.abs(a-mid)-Math.abs(b-mid);});
  var best={s:max?-1e9:1e9,c:v[0]};
  for(i=0;i<v.length;i++){
    nb=drpBd(bd,v[i],max?2:1);res=mm(nb,depth-1,al,be,!max);
    if(max?res.s>best.s:res.s<best.s)best={s:res.s,c:v[i]};
    if(max)al=Math.max(al,best.s);else be=Math.min(be,best.s);
    if(al>=be)break;
  }
  return best;
}
function aiMove(){var res=mm(board,6,-1e9,1e9,true);dropPiece(res.c);}
aiMode=false;aiWait=false;
sc=[0,0];initCvs();reset();
cvs.addEventListener('mousemove',function(e){hov=gcol(e.clientX);});
cvs.addEventListener('mouseleave',function(){hov=-1;});
cvs.addEventListener('click',function(e){if(!over&&!(aiMode&&(cur===2||aiWait))){var c=gcol(e.clientX);if(c>=0)dropPiece(c);}});
cvs.addEventListener('touchstart',function(e){e.preventDefault();if(!over&&!(aiMode&&(cur===2||aiWait))){var c=gcol(e.touches[0].clientX);if(c>=0)dropPiece(c);}},{passive:false});
document.addEventListener('keydown',function(e){if(e.key==='r'||e.key==='R')reset();});
document.getElementById('rbtn').addEventListener('click',reset);
document.getElementById('mbtn').addEventListener('click',function(){
  aiMode=!aiMode;
  this.textContent=aiMode?'vs CPU: ON \uD83E\uDD16':'vs CPU: OFF';
  this.style.color=aiMode?'#69f0ae':'#26c6da';
  this.style.borderColor=aiMode?'rgba(105,240,174,.4)':'rgba(38,198,218,.3)';
  reset();
});
requestAnimationFrame(loop);
})();
</script>
</body>
</html>`;
}

// ============================================================
// HANDLER PRINCIPALE
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db  = env.DB;

    if (!db) return new Response(JSON.stringify({error:"DB binding non trovato"}),{status:500,headers:{"Content-Type":"application/json"}});

    // Crea tabella solari se non esiste
    const initDB = () => db.prepare(`CREATE TABLE IF NOT EXISTS dati_solari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_tag TEXT UNIQUE NOT NULL,
      kp_index REAL
    )`).run();

    if (url.pathname === "/update-solar") {
      if (url.searchParams.get("token") !== UPDATE_SECRET) return new Response("Non autorizzato 🔒",{status:401});
      try {
        await initDB();
        const solare = await fetchSolare();
        const salvati = solare.kpData.length;
        if (salvati>0) await salvaSolare(db, solare.kpData);
        return new Response(JSON.stringify({ok:true, kp_records:salvati, wind:solare.windData}),{
          headers:{"Content-Type":"application/json"}
        });
      } catch(e) {
        return new Response(JSON.stringify({error:e.message}),{status:500,headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/update") {
      if (url.searchParams.get("token") !== UPDATE_SECRET) return new Response("Non autorizzato 🔒",{status:401});
      try {
        await initDB();
        const giorni = parseInt(url.searchParams.get("giorni"))||3;
        const [eventi, solare] = await Promise.all([fetchINGV(giorni), fetchSolare()]);
        const { nuovi } = await salvaEventi(db, eventi);
        if (solare.kpData.length>0) await salvaSolare(db, solare.kpData);
        return Response.redirect(url.origin+"/?updated="+nuovi, 302);
      } catch(e) {
        return new Response(JSON.stringify({error:e.message}),{status:500,headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/api/solar") {
      try {
        await initDB();
        const { results } = await db.prepare(
          `SELECT date(time_tag) as giorno, MAX(kp_index) as kp_max, AVG(kp_index) as kp_avg
           FROM dati_solari GROUP BY giorno ORDER BY giorno DESC LIMIT 60`
        ).all();
        return new Response(JSON.stringify(results),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      } catch(e) {
        return new Response(JSON.stringify([]),{headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/api/events") {
      const giorni = parseInt(url.searchParams.get("giorni"))||null;
      const mag    = parseFloat(url.searchParams.get("mag"))||0.5;
      let q = "SELECT * FROM terremoti WHERE magnitudine >= ?";
      const params = [mag];
      if (giorni) { q += " AND data_ora >= ?"; params.push(new Date(Date.now()-giorni*86400000).toISOString()); }
      q += " ORDER BY data_ora DESC LIMIT 200";
      const { results } = await db.prepare(q).bind(...params).all();
      return new Response(JSON.stringify({count:results.length,events:results}),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/api/stats") {
      const { results } = await db.prepare("SELECT COUNT(*) as totale, MAX(magnitudine) as max_mag, AVG(magnitudine) as avg_mag, MIN(data_ora) as primo FROM terremoti").all();
      return new Response(JSON.stringify(results[0]),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/forza4") {
      return new Response(renderForza4(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    try {
      await initDB();
      const d    = await getDashboardData(db);
      const html = renderDashboard(d);
      return new Response(html,{headers:{"Content-Type":"text/html;charset=UTF-8"}});
    } catch(e) {
      return new Response(`<h1>Errore dashboard</h1><pre>${e.message}</pre>`,{status:500,headers:{"Content-Type":"text/html"}});
    }
  },

  async scheduled(event, env, ctx) {
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS dati_solari (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time_tag TEXT UNIQUE NOT NULL,
        kp_index REAL
      )`).run();
      const [eventi, solare] = await Promise.all([fetchINGV(2), fetchSolare()]);
      if (eventi.length>0) await salvaEventi(env.DB, eventi);
      if (solare.kpData.length>0) await salvaSolare(env.DB, solare.kpData);
    } catch(e) {
      console.error("Cron error:", e.message);
    }
  },
};
