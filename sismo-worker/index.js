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
    <div class="logo-icon"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAHtElEQVR4nM2ae4hcVx3HP79z587MvjfZ7DbNY02TQEiiiVsNVNsYqa2gVvBRH/VJ46NYhZJGkcbYgiDUP4ptVLCItEVUBOkfWpFaqxJatJhWbUhtLTZEMWbz6O7Ozu7szNx7fv5x9u69c+e1s4+aHwz3cc495/s7v9f5/c7I0Ma9ShMSkZpn1aZdoy8S34LrXjuGiCyME91H06haQBLf1vaP2xQRRVXINAK6WIba908ypvO/5HslOWRy/MZ9dIGJ6GpagWq74K3hJ4DbBfDxVRau8TySep/GVo/VtITQ2YKnKF5xqFU/d28T80R9Y/CN50+O6ZhtycBqUaQCMShDLK3kexpIoZYyqwGwEdWralo/k+oW96lnNm5T1dWVQGuvldT3tGok2xuBn+8hq6xCrb1WrY3U3qfBN6f/iw00puRKR+pETQxoxNRlxEDaEzmqjSVRv5hM++j6WlOSEUu06g5nPYMtA9lySVhuLIko6Y2E2O2usgqFCtVgKV+m3Wm6zf1UV5EBa6EnJwwPQBBq7BwFTEdSSXsqqfmtGAOqscp4BgoluP4NwpffKxRmwRjXFoTKbLlT1Urrf7wpXBEGFMh4UA4gCN3AVmFtr7JprQVx76oB9OWFN14F5YouwT5qN4YrokIiUK7AlhH4yR1gRAlCh6w3ZxnqMxhxazc5o9x/0PCeMaFQ0raq1NxDxvFg2QyoCt05eP4MrO0VvvsZYa5iyWbg3KTh5f9CxhOm54Tb3ikc2AnHfm0Z7DXIvGSawmwqIicJkaXuhUSgUkXWD+N/8eNouYIxwpd+qLx5q6Gvy+n6kyct33zU0tcFxUnLDXsM9z6qjE8K3Vm4VICZOSGzJBROCkvfjYYhMjSId81eKp5Htw+nz8PYVy3vHhM+e4Owc4Pie5aL08pjzwmHH3b3a3phfEL50LWGz78DDj0Cr5yHvN86iXKpZK0hd8ZAQqSqiuntwRscQK1CpcpcmOHI+4WjH7YQKtXA+erhPti9VXnXGNx8nzJdMvz2Gx67NlvuesQx3g68m74+R28vPBHnAz0PVNFqQNddX0B93zn0fJ78vt0U/H4+uE85eosyU1SKs0o1gGpoKFWEyQnYs1353kEhnxX+chrefkT50XGlJ9dpbIgZas2ACFqpolPT2FcnsaUy3rZRvKt34b/1aryto0glIHf4c3SPbef2AyVsVbAqGOPCvQBiIOsLxUm4cS/s2qDc+Z2Qv58FUMan4NK0YhtIoN1erbkKzTtus2EE2TaKd8UwZuc2smO7wPfpPno7eB6S86mOjrJpxLDjSqhWFWMSEVPmAahL3jUDb9qqnPw3fOxtUC5DNVQmZoTjL8BspTNptLQBDUO8tYP4Y7sxmzdgtm5GhofQIMB05dD5iBVmc+Q9SyazECNZiJx1ubriGWFkULjlOigUHegz5w3PvGwpll0kT9aFlsaAKpLPEZx8ieCZv6KewVs/gn/dPrKfeh9zT53AGxki85YxsjNzXCj5TE4rV64RwvSuN1FRESucm4JnX1L2fw0qgRCEzq/3d4Nv2htzkhrYQGJmVSSXRYbWYAb60cI05V88AZMFSg/+lMoTT2ONIfzVk5w9dZ7HT/n4XUo1rE/YLUo2q1yagD+cgtErhEoVertgZEBY1w8Z0zyotWGg0XLFTBCGbnuZySD5HLP3HIPiDDrft/T9H5M/8wrfejzHv/4Dg2uU0CqhhcBCYBXfCLlej6M/g+mS8Kd7hW8fBLXKTNlNs5TUyqS3py1JFVSx5y8425ydI5ycQgNLV3eGcxOW/V9Xfv83Q1+v0Deg9A9Cfx8UysKt9yk/+J3b9H3yAWX3FsNv7vZYP6BUgqUlPwkbiBPp9l9lEK+KFmfh4gRUKlSzOXrzlpuvET59TNl7lcfYFsWIcnEaHjth2bFJ2DMK/xyHP/4Dbrxbuf71WrdutRG3Ncm6TWMaVceiyu+iGAkt9PXg7dwOf36O8aLPkQ/A4ZsMu++0nJuCbeth0xo4/oKiVvj5V4ThfsuBe1gw9sKsi8J+Zmm12IQNaNOg0fC9Z6A4S/j0CUrqs2MjHLrJ8JH7QwolyGbgE/vhgVsh58O6QbjjIcuOjR4fvdbwatHN2t8Fvrf0QnLKC6WrYvNPzcRpBOnuAoUuX7jtQeWpF2GwxyU2U7NwbkoIrGNofAoOPWx53TALUdcu0Xgjyrg6u84XUZNFpMUNq9aS8+H0BeXFs9DfLYQuCaMSQKXqtC20Ll/45bOKoAz2uH7LpQaBrHNGVN0K530HVATyWXj+jDBTdiqk6la7Oysuw12BcpSqRkbcCDyLAt9sYGOEauASm66crAjgRvOkJNDooKHzmd25lvMs2Yw03GWuBCW209G5Uy14EUHE0DbANaFIbVaKGnlDE72rbYvcqk2cNK5eCXKx1MgbZuLzKag9mIPYy9YXlS4XStnAYj3Q5cNMKpBFVa9kcTUpFa3/ZBm0EqX9FmjSW+y0ejW2i05ALbe036Iq0SSdqv2cWnfrrqt53pAmkaaFrVaraKhlqhng18ZOOlDoSGWStqEN2k1nwy6T2p6Rxe3pPCFtF5LqU+/FViOmZCKQke4mGWqkz9HfY1w/WUgD47/QLPSsGy9+dsy1/qNJNJ40faeq/A9DCVRVWO4ylAAAAABJRU5ErkJggg==" style="width:100%;height:100%;border-radius:50%;object-fit:cover"></div>
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
<meta name="author" content="Gimmy Pignolo">
<meta name="copyright" content="© 2026 Gimmy Pignolo. Tutti i diritti riservati.">
<meta name="robots" content="noindex">
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
  <footer>ECHO Games // <a href="/">&#8592; torna al monitor sismico</a> &nbsp;|&nbsp; &copy; 2026 Gimmy Pignolo</footer>
</div>
<script>
var a0_0x52ec1b=a0_0x1953;function a0_0x1953(_0x5ae1ac,_0x3c6306){_0x5ae1ac=_0x5ae1ac-0xf9;var _0x26b1f8=a0_0x213a();var _0x228526=_0x26b1f8[_0x5ae1ac];if(a0_0x1953['WDDAWY']===undefined){var _0x471042=function(_0x5c748d){var _0x103712='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x6680f8='',_0x354e='',_0x18399f=_0x6680f8+_0x471042;for(var _0x1fe676=0x0,_0x3900aa,_0x2fcbdd,_0x522c39=0x0;_0x2fcbdd=_0x5c748d['charAt'](_0x522c39++);~_0x2fcbdd&&(_0x3900aa=_0x1fe676%0x4?_0x3900aa*0x40+_0x2fcbdd:_0x2fcbdd,_0x1fe676++%0x4)?_0x6680f8+=_0x18399f['charCodeAt'](_0x522c39+0xa)-0xa!==0x0?String['fromCharCode'](0xff&_0x3900aa>>(-0x2*_0x1fe676&0x6)):_0x1fe676:0x0){_0x2fcbdd=_0x103712['indexOf'](_0x2fcbdd);}for(var _0x4fb0e8=0x0,_0x506a6b=_0x6680f8['length'];_0x4fb0e8<_0x506a6b;_0x4fb0e8++){_0x354e+='%'+('00'+_0x6680f8['charCodeAt'](_0x4fb0e8)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x354e);};a0_0x1953['JxsRpN']=_0x471042,a0_0x1953['nANYnp']={},a0_0x1953['WDDAWY']=!![];}var _0x213a2f=_0x26b1f8[0x0],_0x1953a7=_0x5ae1ac+_0x213a2f,_0x49f1b7=a0_0x1953['nANYnp'][_0x1953a7];if(!_0x49f1b7){var _0x4c6913=function(_0x4c8b2a){this['hwZfWC']=_0x4c8b2a,this['bkWaXy']=[0x1,0x0,0x0],this['xvHeLR']=function(){return'newState';},this['IoVMxK']='\x5cw+\x20*\x5c(\x5c)\x20*{\x5cw+\x20*',this['iCiQlT']='[\x27|\x22].+[\x27|\x22];?\x20*}';};_0x4c6913['prototype']['oTLrdX']=function(){var _0x109ff8=new RegExp(this['IoVMxK']+this['iCiQlT']),_0x413b15=_0x109ff8['test'](this['xvHeLR']['toString']())?--this['bkWaXy'][0x1]:--this['bkWaXy'][0x0];return this['iiPlRK'](_0x413b15);},_0x4c6913['prototype']['iiPlRK']=function(_0x2f13cb){if(!Boolean(~_0x2f13cb))return _0x2f13cb;return this['mypKVD'](this['hwZfWC']);},_0x4c6913['prototype']['mypKVD']=function(_0x5b03cd){for(var _0x104a72=0x0,_0x21bfac=this['bkWaXy']['length'];_0x104a72<_0x21bfac;_0x104a72++){this['bkWaXy']['push'](Math['round'](Math['random']())),_0x21bfac=this['bkWaXy']['length'];}return _0x5b03cd(this['bkWaXy'][0x0]);},new _0x4c6913(a0_0x1953)['oTLrdX'](),_0x228526=a0_0x1953['JxsRpN'](_0x228526),a0_0x1953['nANYnp'][_0x1953a7]=_0x228526;}else _0x228526=_0x49f1b7;return _0x228526;}(function(_0x16def6,_0x36a743){var _0x1cece6=a0_0x1953,_0x4b6755=_0x16def6();while(!![]){try{var _0x216591=parseInt(_0x1cece6(0x147))/0x1*(-parseInt(_0x1cece6(0x146))/0x2)+parseInt(_0x1cece6(0x120))/0x3+parseInt(_0x1cece6(0x1f3))/0x4*(parseInt(_0x1cece6(0x114))/0x5)+-parseInt(_0x1cece6(0x19f))/0x6*(-parseInt(_0x1cece6(0x152))/0x7)+parseInt(_0x1cece6(0x15c))/0x8*(parseInt(_0x1cece6(0x154))/0x9)+-parseInt(_0x1cece6(0x1bf))/0xa+-parseInt(_0x1cece6(0x1e8))/0xb;if(_0x216591===_0x36a743)break;else _0x4b6755['push'](_0x4b6755['shift']());}catch(_0xa87c7c){_0x4b6755['push'](_0x4b6755['shift']());}}}(a0_0x213a,0xd75ef),window[a0_0x52ec1b(0x1ee)]=function(_0x587a95,_0x1970b8,_0x2831f6,_0x27521b,_0x5e4e1e){var _0x4fc353=a0_0x52ec1b,_0x4ec88f={'ljUbY':_0x4fc353(0x1f5),'DPqjM':_0x4fc353(0x205),'xxCda':_0x4fc353(0x1ba),'MMUGo':_0x4fc353(0x1f6),'aTsOq':function(_0x3565ac,_0x5c42ae){return _0x3565ac+_0x5c42ae;}},_0x133e6a=_0x4fc353(0x162)[_0x4fc353(0x17d)]('|'),_0x1c16b9=0x0;while(!![]){switch(_0x133e6a[_0x1c16b9++]){case'0':var _0x430ec4=document[_0x4fc353(0x202)](_0x4ec88f[_0x4fc353(0x11c)]);continue;case'1':_0x430ec4[_0x4fc353(0x151)]=_0x4ec88f[_0x4fc353(0x105)];continue;case'2':document['querySelector'](_0x4ec88f[_0x4fc353(0x1c0)])[_0x4fc353(0x1fa)](_0x430ec4,document[_0x4fc353(0x1c3)](_0x4ec88f[_0x4fc353(0x156)]));continue;case'3':return!![];case'4':_0x430ec4[_0x4fc353(0x13a)]=_0x4ec88f[_0x4fc353(0x1b7)](_0x4fc353(0x1b0)+_0x587a95+_0x4fc353(0x13f),_0x2831f6)+')';continue;}break;}},(function(){var _0x42be23=a0_0x52ec1b,_0x59db3c={'DaUwY':'(((.+)+)+)+$','GqkTn':'5|10|11|12|0|1|2|4|9|8|7|6|3','sXbkx':function(_0x24a891,_0x550130){return _0x24a891+_0x550130;},'pBHfo':function(_0xb565b9,_0x28c78f){return _0xb565b9*_0x28c78f;},'JDYkN':function(_0x5c29a,_0x5a9899){return _0x5c29a+_0x5a9899;},'xoSAc':function(_0x1c6d1a,_0x45ea50){return _0x1c6d1a+_0x45ea50;},'gOHBu':function(_0x4c979d,_0x119850){return _0x4c979d-_0x119850;},'Rwjvv':function(_0x156b87,_0x57a3fb){return _0x156b87+_0x57a3fb;},'NDogT':function(_0x47ba65,_0x2e9cdd){return _0x47ba65/_0x2e9cdd;},'KvZBw':function(_0x3d0dc8,_0x58c822){return _0x3d0dc8<_0x58c822;},'gsJLj':_0x42be23(0x1f8),'QzCQA':function(_0x218c11,_0x3672ea){return _0x218c11+_0x3672ea;},'DzoEn':function(_0x14d17f,_0x5452cc){return _0x14d17f+_0x5452cc;},'KTEoJ':_0x42be23(0x160),'NIFMJ':_0x42be23(0x194),'cZTFQ':function(_0x57f535,_0xee6f08){return _0x57f535===_0xee6f08;},'UPjBv':function(_0x27663f,_0xddf31c){return _0x27663f+_0xddf31c;},'Jtofr':'5|1|3|2|4|0','ngzDb':function(_0x4b7232,_0x1fe8f3){return _0x4b7232<=_0x1fe8f3;},'JbPRw':function(_0x39688f,_0x381368){return _0x39688f===_0x381368;},'kMbuf':function(_0x3c1ba3,_0x39d842){return _0x3c1ba3===_0x39d842;},'yEVuU':function(_0x24ad5c,_0x3d1e43){return _0x24ad5c+_0x3d1e43;},'iSXcS':function(_0x126060,_0x78123c){return _0x126060===_0x78123c;},'BmjlP':function(_0x3d59b7,_0xcd7ae9){return _0x3d59b7+_0xcd7ae9;},'rokAA':function(_0x646991,_0x5eaa02){return _0x646991+_0x5eaa02;},'KVAHY':function(_0x20c10f,_0x3a6b80){return _0x20c10f<_0x3a6b80;},'OUUnr':function(_0x2dff6e,_0x47478d){return _0x2dff6e===_0x47478d;},'mXoHc':function(_0x53f6f6,_0x2ddb8f){return _0x53f6f6-_0x2ddb8f;},'mLSKo':function(_0x3ca6ef,_0x1ff57f){return _0x3ca6ef-_0x1ff57f;},'WrsYh':function(_0x190ffb,_0x242a11){return _0x190ffb+_0x242a11;},'aAshr':function(_0xdf38ea,_0x22c338){return _0xdf38ea+_0x22c338;},'THKmT':function(_0x113477,_0x21076a){return _0x113477===_0x21076a;},'WITCT':function(_0x325dfd,_0x148f0b){return _0x325dfd===_0x148f0b;},'MCuPe':function(_0x175b84,_0x4b82bc){return _0x175b84+_0x4b82bc;},'qnuVK':function(_0x465373,_0x532313){return _0x465373+_0x532313;},'fYiEp':function(_0x1ff4dd,_0x57cdee){return _0x1ff4dd+_0x57cdee;},'ajdjT':function(_0x8856c8,_0x1af467){return _0x8856c8>=_0x1af467;},'Anzol':function(_0x32e7b6,_0x21da19){return _0x32e7b6*_0x21da19;},'tRAAn':function(_0x586e75,_0xe8481f){return _0x586e75+_0xe8481f;},'xBtwa':function(_0x305f6b,_0x20b4fe){return _0x305f6b*_0x20b4fe;},'zXWSy':function(_0x377615,_0x17f433){return _0x377615*_0x17f433;},'rcsMR':_0x42be23(0x109),'DwIct':function(_0x447eaf,_0x214eaf){return _0x447eaf*_0x214eaf;},'uZVHu':function(_0x2c7ccc,_0x329bc8){return _0x2c7ccc===_0x329bc8;},'AAlRb':function(_0xe01ca2,_0x447244){return _0xe01ca2<_0x447244;},'dnBVK':_0x42be23(0x18c),'fqUEX':function(_0x251735,_0x191eb3){return _0x251735*_0x191eb3;},'OxtwH':_0x42be23(0x144),'PvJXv':function(_0xc9832e,_0x2e3efc){return _0xc9832e-_0x2e3efc;},'bjHGu':function(_0x576232,_0x54c66b){return _0x576232===_0x54c66b;},'GcTxK':function(_0x29f623,_0x53bb09){return _0x29f623+_0x53bb09;},'UlvpG':function(_0x4916d4,_0x4d384a){return _0x4916d4+_0x4d384a;},'dmJbL':function(_0x40d220,_0x14fd40){return _0x40d220+_0x14fd40;},'VBZFH':function(_0x34e3df,_0x425972){return _0x34e3df+_0x425972;},'SIbQZ':function(_0x2e482a,_0x11b725){return _0x2e482a+_0x11b725;},'zkRlj':function(_0x3b33c5,_0x197b64){return _0x3b33c5-_0x197b64;},'pudHT':function(_0x4a6a48,_0x4ce4e4){return _0x4a6a48+_0x4ce4e4;},'bNXQu':function(_0x1ac205,_0x41df3c,_0x1728d6,_0x5a7e4f,_0x1dd7f0,_0x59b9ab){return _0x1ac205(_0x41df3c,_0x1728d6,_0x5a7e4f,_0x1dd7f0,_0x59b9ab);},'MncmA':function(_0xac8a7a,_0x148cd7){return _0xac8a7a*_0x148cd7;},'aNGuk':function(_0x55642d,_0x3c509b){return _0x55642d(_0x3c509b);},'taTvN':function(_0x1613a0,_0x3daa10){return _0x1613a0+_0x3daa10;},'faqkc':_0x42be23(0x11f),'AgpbX':function(_0x51a07d,_0xe7df07){return _0x51a07d!==_0xe7df07;},'fIfLv':function(_0x1d1b33,_0x3e9ef6){return _0x1d1b33<_0x3e9ef6;},'eyCVp':function(_0xccb088,_0x4bc7f6){return _0xccb088===_0x4bc7f6;},'ULDWJ':function(_0x2220c1,_0x27af8b){return _0x2220c1*_0x27af8b;},'YJuSf':function(_0x1d7c49,_0x150e03){return _0x1d7c49*_0x150e03;},'DyslX':function(_0x435124,_0x2462b8){return _0x435124*_0x2462b8;},'nljwa':_0x42be23(0x113),'qOXtx':function(_0x1008c9,_0x230fe4){return _0x1008c9<_0x230fe4;},'BngEj':function(_0x178bd4,_0x5ebdc3){return _0x178bd4+_0x5ebdc3;},'IdOnw':function(_0x110716,_0x57398c){return _0x110716===_0x57398c;},'vECFc':function(_0x53ef4b,_0x13bfcd){return _0x53ef4b+_0x13bfcd;},'FwUMZ':function(_0x43a749,_0x59b040){return _0x43a749+_0x59b040;},'MOCis':'rgba(0,0,0,.6)','xXxrN':function(_0x59cf4d,_0x4f5994){return _0x59cf4d-_0x4f5994;},'makgf':function(_0x2e8cc7,_0x57e22d){return _0x2e8cc7-_0x57e22d;},'TzFfW':function(_0x910b3e,_0x2adef6,_0x50b620,_0x222783,_0x822680,_0x16e7f4){return _0x910b3e(_0x2adef6,_0x50b620,_0x222783,_0x822680,_0x16e7f4);},'Pzxpg':_0x42be23(0x1a9),'FEOxz':function(_0x5cda8d,_0xa030a4){return _0x5cda8d+_0xa030a4;},'athbx':function(_0x11811e,_0x52acb3){return _0x11811e+_0x52acb3;},'AKshH':_0x42be23(0x195),'qUuQS':function(_0x340815,_0x32b21c){return _0x340815*_0x32b21c;},'UMDHY':_0x42be23(0x13b),'kbgKx':function(_0x491c04,_0x324dc4){return _0x491c04*_0x324dc4;},'tcavu':_0x42be23(0x1c8),'jOPIK':function(_0xb43b87,_0x325751){return _0xb43b87+_0x325751;},'YhbNE':function(_0x40a5aa,_0x17b03a){return _0x40a5aa===_0x17b03a;},'ysoAE':function(_0x378e78,_0x2f65e4){return _0x378e78*_0x2f65e4;},'pnMEB':function(_0x30c24c,_0x190197){return _0x30c24c>=_0x190197;},'WfoYC':function(_0xd9cea6,_0x55312f,_0x2da03a,_0x415820,_0x205a15){return _0xd9cea6(_0x55312f,_0x2da03a,_0x415820,_0x205a15);},'sQfFQ':function(_0x1c5496,_0xd27a38){return _0x1c5496(_0xd27a38);},'GxPcP':function(_0x1c41c4){return _0x1c41c4();},'dxZxL':function(_0x50bbbf,_0xaff65d){return _0x50bbbf+_0xaff65d;},'uxLyA':function(_0xee85,_0x29d9be){return _0xee85*_0x29d9be;},'sTWyp':_0x42be23(0x1ca),'WIJFD':function(_0x71484f){return _0x71484f();},'moknw':function(_0x494288,_0x5b3932,_0x4ffe05,_0xa08b4b,_0x1962cb){return _0x494288(_0x5b3932,_0x4ffe05,_0xa08b4b,_0x1962cb);},'pXRyM':function(_0x39a2e2,_0x51ca8e){return _0x39a2e2(_0x51ca8e);},'aoDbc':function(_0x6482c4,_0xc429eb){return _0x6482c4/_0xc429eb;},'KYNQq':function(_0xfe8569,_0x4d81ca){return _0xfe8569-_0x4d81ca;},'eWdyu':function(_0x344d75,_0x383e3e){return _0x344d75||_0x383e3e;},'jtkfp':function(_0x26626c,_0xa06e2){return _0x26626c<_0xa06e2;},'qnGsO':function(_0x25da51,_0x262f83){return _0x25da51===_0x262f83;},'gPoAA':function(_0x3cfddf,_0x3b56fe){return _0x3cfddf===_0x3b56fe;},'ToUkA':function(_0x2c99f9,_0x33a3dd){return _0x2c99f9-_0x33a3dd;},'oVaoB':function(_0x12d3c3,_0x35b590,_0x541288){return _0x12d3c3(_0x35b590,_0x541288);},'zFKBi':function(_0x4be51f,_0x47d2d9){return _0x4be51f+_0x47d2d9;},'dVhuv':function(_0x8e146a,_0x2cfe4b){return _0x8e146a+_0x2cfe4b;},'qaPUo':function(_0x43bd8e,_0x4ba564,_0x3c0b36){return _0x43bd8e(_0x4ba564,_0x3c0b36);},'qHhvN':function(_0x1eb256,_0x1240ff){return _0x1eb256+_0x1240ff;},'rOZoe':function(_0x320e1c,_0x3042e3){return _0x320e1c+_0x3042e3;},'qmJnD':function(_0x4b1cb7,_0x35cc9c){return _0x4b1cb7+_0x35cc9c;},'yWIay':function(_0x5b9d4f,_0x4a7463,_0x2dd14){return _0x5b9d4f(_0x4a7463,_0x2dd14);},'GUaXX':function(_0x1ea1cf,_0x17ed1f){return _0x1ea1cf+_0x17ed1f;},'BbepD':function(_0x349aae,_0x24a186){return _0x349aae+_0x24a186;},'wXTlC':function(_0x3fdaf5,_0x287862){return _0x3fdaf5+_0x287862;},'KfiMf':function(_0x1b2627,_0xb6af04){return _0x1b2627<_0xb6af04;},'dAQZu':function(_0x549952,_0x394a52){return _0x549952===_0x394a52;},'QlMVz':function(_0x1b646f,_0x495ad1){return _0x1b646f+_0x495ad1;},'hAhut':function(_0x52fd4e,_0x173b2f){return _0x52fd4e+_0x173b2f;},'MIwWk':function(_0x4ff319,_0x53b5b1){return _0x4ff319<=_0x53b5b1;},'JeDJJ':function(_0x165625,_0x361c89){return _0x165625-_0x361c89;},'lympF':function(_0x494735,_0x2175f2){return _0x494735-_0x2175f2;},'EQHaR':function(_0x455d9d,_0x4e22ea){return _0x455d9d-_0x4e22ea;},'GbIlb':function(_0x5a7030,_0x8cde38){return _0x5a7030+_0x8cde38;},'uuuEk':function(_0x25be6d,_0x50d61a){return _0x25be6d-_0x50d61a;},'nLnxa':function(_0xa7b5b2,_0x1028a7){return _0xa7b5b2===_0x1028a7;},'AUyEO':function(_0x4ae068,_0x3c66b5){return _0x4ae068+_0x3c66b5;},'vRmth':function(_0x428bbb,_0x4999e5){return _0x428bbb===_0x4999e5;},'aFCjY':function(_0x50ac36,_0x17183f){return _0x50ac36-_0x17183f;},'WlrCm':function(_0x2bde69,_0x408d50,_0x151227){return _0x2bde69(_0x408d50,_0x151227);},'ORwoJ':function(_0x124fb0,_0x432467){return _0x124fb0>_0x432467;},'fUWUp':function(_0xf697de,_0x221cf6){return _0xf697de>=_0x221cf6;},'kixQt':function(_0x10b043,_0x394f2b){return _0x10b043(_0x394f2b);},'GtAHf':function(_0x26696b,_0x452395){return _0x26696b(_0x452395);},'fFoXv':function(_0x18891f,_0x4bd93f){return _0x18891f===_0x4bd93f;},'iCxpU':function(_0x11f77d,_0x3e57eb){return _0x11f77d(_0x3e57eb);},'WlVtA':function(_0x2bf6eb,_0x426be8){return _0x2bf6eb===_0x426be8;},'lnCrO':function(_0x4bff31){return _0x4bff31();},'cyqHE':_0x42be23(0x171),'Ncgrw':_0x42be23(0x125),'vkbDr':'vs\x20CPU:\x20OFF','jZita':_0x42be23(0x183),'kYhcM':_0x42be23(0x102),'MXsHh':_0x42be23(0x198),'FivZH':_0x42be23(0x124),'VdmJZ':function(_0x321228){return _0x321228();},'IioDy':_0x42be23(0x136),'LkUjh':'mouseleave','YuJQA':_0x42be23(0x16d),'BbGFG':_0x42be23(0x14a),'RQwyq':_0x42be23(0x1ad),'hkxIP':function(_0x32358a,_0x43512a){return _0x32358a(_0x43512a);}},_0x196fb8=(function(){var _0x532976=!![];return function(_0x50c95b,_0xb02280){var _0x28fbb8=_0x532976?function(){var _0x26b1ff=a0_0x1953;if(_0xb02280){var _0x591546=_0xb02280[_0x26b1ff(0x20c)](_0x50c95b,arguments);return _0xb02280=null,_0x591546;}}:function(){};return _0x532976=![],_0x28fbb8;};}()),_0x11ef36=_0x196fb8(this,function(){var _0x3fcfcf=_0x42be23;return _0x11ef36[_0x3fcfcf(0x12f)]()[_0x3fcfcf(0x14d)](_0x3fcfcf(0x10c))[_0x3fcfcf(0x12f)]()[_0x3fcfcf(0x1cc)](_0x11ef36)[_0x3fcfcf(0x14d)](_0x59db3c[_0x3fcfcf(0x16e)]);});_0x59db3c[_0x42be23(0x13e)](_0x11ef36);var _0x430cd7=0x7,_0x4bd444=0x6,_0x3323ef,_0x100a6e,_0x4582ab,_0xe6b5cb,_0x5e48c4,_0x4c048f,_0x60871f,_0x1e017f,_0x59cb4d,_0x334f40,_0x273a1e,_0x12a13f,_0xdf7f4a,_0x2eb27b,_0x34f108,_0x463c8d,_0x266fb8,_0x46d7b5,_0x3a8785,_0x407e23,_0x35171a,_0xe307f8=_0x42be23(0x18b),_0x270d7e=_0x59db3c[_0x42be23(0x178)],_0x484645='#b71c1c',_0x1cc2d4=_0x59db3c[_0x42be23(0x1fc)],_0x39e852=_0x42be23(0xff),_0x376c0b='#c6a700';function _0x547ec7(){var _0x4e8a90=_0x42be23,_0x1e486d=_0x59db3c[_0x4e8a90(0x1e1)][_0x4e8a90(0x17d)]('|'),_0x4326ff=0x0;while(!![]){switch(_0x1e486d[_0x4326ff++]){case'0':_0x100a6e=Math[_0x4e8a90(0x1c5)](_0x3323ef*0.42);continue;case'1':_0x4582ab=Math[_0x4e8a90(0x1c5)](_0x3323ef*0.55);continue;case'2':_0xe6b5cb=Math[_0x4e8a90(0x1c5)](_0x3323ef*1.55);continue;case'3':_0x407e23[_0x4e8a90(0x151)][_0x4e8a90(0x12d)]=_0x4c048f+'px';continue;case'4':_0x5e48c4=_0x59db3c[_0x4e8a90(0x12e)](_0x430cd7*_0x3323ef,_0x59db3c[_0x4e8a90(0x186)](_0x4582ab,0x2));continue;case'5':_0x407e23=document[_0x4e8a90(0x1c3)](_0x4e8a90(0x1f6));continue;case'6':_0x407e23[_0x4e8a90(0x151)][_0x4e8a90(0x185)]=_0x5e48c4+'px';continue;case'7':_0x407e23[_0x4e8a90(0x12d)]=_0x4c048f;continue;case'8':_0x407e23[_0x4e8a90(0x185)]=_0x5e48c4;continue;case'9':_0x4c048f=_0x59db3c[_0x4e8a90(0x19e)](_0x59db3c['xoSAc'](_0x4bd444*_0x3323ef,_0xe6b5cb),_0x4582ab);continue;case'10':_0x35171a=_0x407e23[_0x4e8a90(0x1ec)]('2d');continue;case'11':var _0x4fb7a5=Math[_0x4e8a90(0x1ac)](_0x59db3c[_0x4e8a90(0x101)](window['innerWidth'],0x2c),0x2d0);continue;case'12':_0x3323ef=Math['floor'](_0x4fb7a5/_0x59db3c['Rwjvv'](_0x430cd7,1.1));continue;}break;}}function _0x5117dc(_0x3c3519){return _0x4582ab+_0x59db3c['pBHfo'](_0x3c3519,_0x3323ef)+_0x3323ef/0x2;}function _0x53ece5(_0x4e5337){var _0x2b0fd1=_0x42be23;return _0x59db3c[_0x2b0fd1(0x1ff)](_0xe6b5cb+_0x4e5337*_0x3323ef,_0x59db3c[_0x2b0fd1(0x197)](_0x3323ef,0x2));}function _0x526670(){var _0x9ec86a=_0x42be23,_0x17ff55=_0x9ec86a(0x15f)[_0x9ec86a(0x17d)]('|'),_0x25e71d=0x0;while(!![]){switch(_0x17ff55[_0x25e71d++]){case'0':for(var _0x375743=0x0;_0x59db3c[_0x9ec86a(0x174)](_0x375743,_0x4bd444);_0x375743++){_0x60871f[_0x9ec86a(0x132)]([]);for(var _0x574271=0x0;_0x59db3c[_0x9ec86a(0x174)](_0x574271,_0x430cd7);_0x574271++)_0x60871f[_0x375743][_0x9ec86a(0x132)](0x0);}continue;case'1':_0x1e017f=0x1;continue;case'2':_0x273a1e=null;continue;case'3':_0x266fb8=0.35;continue;case'4':_0x56fa05();continue;case'5':_0xdf7f4a=-0x1;continue;case'6':_0x334f40=[];continue;case'7':_0x59cb4d=![];continue;case'8':_0x12a13f=[];continue;case'9':_0x3a8785=![];continue;case'10':_0x60871f=[];continue;case'11':_0x34f108=0x0;continue;}break;}}function _0x56fa05(){var _0x12cb9a=_0x42be23;document[_0x12cb9a(0x1c3)]('s1')[_0x12cb9a(0x13a)]=_0x2eb27b[0x0],document[_0x12cb9a(0x1c3)]('s2')['textContent']=_0x2eb27b[0x1];var _0x172b7e=document[_0x12cb9a(0x1c3)]('ti');if(_0x59cb4d)_0x172b7e['textContent']=_0x334f40[_0x12cb9a(0x123)]?_0x46d7b5&&_0x1e017f===0x2?_0x59db3c[_0x12cb9a(0x1b8)]:_0x59db3c[_0x12cb9a(0x1d0)](_0x59db3c[_0x12cb9a(0x110)](_0x59db3c[_0x12cb9a(0x1b4)],_0x1e017f),_0x59db3c[_0x12cb9a(0x1cb)]):_0x12cb9a(0x17e);else _0x172b7e[_0x12cb9a(0x13a)]=_0x46d7b5&&_0x59db3c[_0x12cb9a(0x139)](_0x1e017f,0x2)?_0x12cb9a(0x119):_0x59db3c[_0x12cb9a(0x1fd)](_0x12cb9a(0x19c),_0x1e017f);}function _0x5d5b1a(_0x1d2853){var _0x1428c7=_0x42be23,_0x3ac2ac=_0x59db3c[_0x1428c7(0x106)][_0x1428c7(0x17d)]('|'),_0x1057e4=0x0;while(!![]){switch(_0x3ac2ac[_0x1057e4++]){case'0':return null;case'1':for(_0x1449df=0x0;_0x1449df<_0x4bd444;_0x1449df++)for(_0x593439=0x0;_0x59db3c[_0x1428c7(0x128)](_0x593439,_0x430cd7-0x4);_0x593439++)if(_0x60871f[_0x1449df][_0x593439]===_0x1d2853&&_0x59db3c[_0x1428c7(0x1e6)](_0x60871f[_0x1449df][_0x593439+0x1],_0x1d2853)&&_0x59db3c[_0x1428c7(0x189)](_0x60871f[_0x1449df][_0x59db3c[_0x1428c7(0x1d6)](_0x593439,0x2)],_0x1d2853)&&_0x59db3c[_0x1428c7(0x1c4)](_0x60871f[_0x1449df][_0x593439+0x3],_0x1d2853))return[[_0x1449df,_0x593439],[_0x1449df,_0x59db3c[_0x1428c7(0x1ab)](_0x593439,0x1)],[_0x1449df,_0x59db3c[_0x1428c7(0x164)](_0x593439,0x2)],[_0x1449df,_0x59db3c[_0x1428c7(0x1ab)](_0x593439,0x3)]];continue;case'2':for(_0x1449df=0x3;_0x59db3c[_0x1428c7(0x184)](_0x1449df,_0x4bd444);_0x1449df++)for(_0x593439=0x0;_0x593439<=_0x430cd7-0x4;_0x593439++)if(_0x60871f[_0x1449df][_0x593439]===_0x1d2853&&_0x59db3c[_0x1428c7(0x1e6)](_0x60871f[_0x1449df-0x1][_0x593439+0x1],_0x1d2853)&&_0x59db3c[_0x1428c7(0x209)](_0x60871f[_0x1449df-0x2][_0x59db3c[_0x1428c7(0x19e)](_0x593439,0x2)],_0x1d2853)&&_0x60871f[_0x59db3c['gOHBu'](_0x1449df,0x3)][_0x59db3c[_0x1428c7(0x1fd)](_0x593439,0x3)]===_0x1d2853)return[[_0x1449df,_0x593439],[_0x1449df-0x1,_0x593439+0x1],[_0x1449df-0x2,_0x59db3c[_0x1428c7(0x164)](_0x593439,0x2)],[_0x59db3c[_0x1428c7(0x1da)](_0x1449df,0x3),_0x593439+0x3]];continue;case'3':for(_0x1449df=0x0;_0x59db3c[_0x1428c7(0x128)](_0x1449df,_0x59db3c[_0x1428c7(0x20a)](_0x4bd444,0x4));_0x1449df++)for(_0x593439=0x0;_0x59db3c[_0x1428c7(0x174)](_0x593439,_0x430cd7);_0x593439++)if(_0x60871f[_0x1449df][_0x593439]===_0x1d2853&&_0x60871f[_0x59db3c[_0x1428c7(0xfe)](_0x1449df,0x1)][_0x593439]===_0x1d2853&&_0x60871f[_0x1449df+0x2][_0x593439]===_0x1d2853&&_0x59db3c['kMbuf'](_0x60871f[_0x59db3c[_0x1428c7(0x20b)](_0x1449df,0x3)][_0x593439],_0x1d2853))return[[_0x1449df,_0x593439],[_0x1449df+0x1,_0x593439],[_0x1449df+0x2,_0x593439],[_0x59db3c[_0x1428c7(0x19e)](_0x1449df,0x3),_0x593439]];continue;case'4':for(_0x1449df=0x0;_0x1449df<=_0x4bd444-0x4;_0x1449df++)for(_0x593439=0x0;_0x593439<=_0x430cd7-0x4;_0x593439++)if(_0x59db3c[_0x1428c7(0x1e6)](_0x60871f[_0x1449df][_0x593439],_0x1d2853)&&_0x59db3c[_0x1428c7(0x206)](_0x60871f[_0x1449df+0x1][_0x593439+0x1],_0x1d2853)&&_0x59db3c[_0x1428c7(0x177)](_0x60871f[_0x1449df+0x2][_0x59db3c[_0x1428c7(0x1a3)](_0x593439,0x2)],_0x1d2853)&&_0x60871f[_0x59db3c[_0x1428c7(0x110)](_0x1449df,0x3)][_0x59db3c[_0x1428c7(0x164)](_0x593439,0x3)]===_0x1d2853)return[[_0x1449df,_0x593439],[_0x59db3c[_0x1428c7(0x169)](_0x1449df,0x1),_0x593439+0x1],[_0x59db3c[_0x1428c7(0x1f4)](_0x1449df,0x2),_0x593439+0x2],[_0x1449df+0x3,_0x593439+0x3]];continue;case'5':var _0x1449df,_0x593439;continue;}break;}}function _0xdb633(){for(var _0x13ca62=0x0;_0x13ca62<_0x430cd7;_0x13ca62++)if(_0x60871f[0x0][_0x13ca62]===0x0)return![];return!![];}function _0x4e8732(_0xf2bce1){var _0x519984=_0x42be23;if(_0x59cb4d||_0x273a1e)return;var _0x4235b5=-0x1;for(var _0x2c603f=_0x59db3c[_0x519984(0x101)](_0x4bd444,0x1);_0x59db3c[_0x519984(0x112)](_0x2c603f,0x0);_0x2c603f--)if(_0x60871f[_0x2c603f][_0xf2bce1]===0x0){_0x4235b5=_0x2c603f;break;}if(_0x59db3c[_0x519984(0x209)](_0x4235b5,-0x1))return;_0x273a1e={'col':_0xf2bce1,'row':_0x4235b5,'y':_0x59db3c[_0x519984(0x20a)](_0xe6b5cb,_0x3323ef*0.7),'sp':_0x3323ef*0.1,'pl':_0x1e017f};}function _0x2e021d(_0x1d342f,_0x716827,_0x499527){var _0x447090=_0x42be23;this['x']=_0x1d342f,this['y']=_0x716827,this[_0x447090(0x1df)]=_0x499527,this['vx']=(Math[_0x447090(0x137)]()-0.5)*_0x3323ef*0.12,this['vy']=-(Math['random']()*_0x3323ef*0.14+_0x59db3c[_0x447090(0x1ea)](_0x3323ef,0.05)),this['life']=0x0,this['ml']=0.8+_0x59db3c[_0x447090(0x186)](Math[_0x447090(0x137)](),0.7),this['sz']=_0x59db3c[_0x447090(0x11b)](_0x59db3c[_0x447090(0x1b1)](_0x100a6e,0.15),_0x59db3c[_0x447090(0x13c)](Math[_0x447090(0x137)]()*_0x100a6e,0.18));}_0x2e021d['prototype']['upd']=function(_0x1e7417){var _0x4f19a0=_0x42be23,_0x206686=_0x59db3c[_0x4f19a0(0x170)]['split']('|'),_0x4b0563=0x0;while(!![]){switch(_0x206686[_0x4b0563++]){case'0':this['y']+=this['vy'];continue;case'1':this['life']+=_0x1e7417;continue;case'2':this['x']+=this['vx'];continue;case'3':this['sz']*=0.97;continue;case'4':this['vy']+=_0x59db3c[_0x4f19a0(0x16f)](_0x3323ef*0.4,_0x1e7417);continue;}break;}},_0x2e021d[_0x42be23(0x1e2)][_0x42be23(0x141)]=function(){var _0x238574=_0x42be23,_0x4a49e5=_0x238574(0x1b2)[_0x238574(0x17d)]('|'),_0x45ce11=0x0;while(!![]){switch(_0x4a49e5[_0x45ce11++]){case'0':_0x35171a[_0x238574(0x148)]();continue;case'1':_0x35171a[_0x238574(0xfb)](this['x'],this['y'],this['sz'],0x0,_0x59db3c[_0x238574(0x16f)](Math['PI'],0x2));continue;case'2':_0x35171a[_0x238574(0x1a8)]();continue;case'3':_0x35171a[_0x238574(0x16c)]();continue;case'4':_0x35171a[_0x238574(0x1dd)]();continue;case'5':_0x35171a[_0x238574(0x14e)]=this[_0x238574(0x1df)];continue;case'6':_0x35171a[_0x238574(0x1d5)]=0x1-this[_0x238574(0x172)]/this['ml'];continue;case'7':if(_0x59db3c['ajdjT'](this[_0x238574(0x172)],this['ml']))return;continue;}break;}};function _0x1dda2f(_0x481c46,_0xca867a,_0x6a0df3,_0x16f32d){var _0x3737c4=_0x42be23,_0x1c8e15=_0x59db3c[_0x3737c4(0x17c)](_0x6a0df3,0x1)?_0xe307f8:_0x1cc2d4;for(var _0x23aeea=0x0;_0x59db3c[_0x3737c4(0x20d)](_0x23aeea,_0x16f32d);_0x23aeea++)_0x12a13f[_0x3737c4(0x132)](new _0x2e021d(_0x481c46,_0xca867a,_0x1c8e15));}function _0x11683b(_0xfdd81c,_0x543c06,_0x541b4b,_0x5d1683){var _0x338273=_0x42be23,_0x3ff4e5=_0x59db3c[_0x338273(0x175)][_0x338273(0x17d)]('|'),_0x369449=0x0;while(!![]){switch(_0x3ff4e5[_0x369449++]){case'0':_0x35171a[_0x338273(0x16c)]();continue;case'1':_0x35171a[_0x338273(0x1a8)]();continue;case'2':var _0x33af98=_0x35171a[_0x338273(0x1db)](_0xfdd81c-_0x100a6e*0.3,_0x59db3c[_0x338273(0x20a)](_0x543c06,_0x59db3c['Anzol'](_0x100a6e,0.3)),0x0,_0xfdd81c,_0x543c06,_0x100a6e);continue;case'3':_0x35171a[_0x338273(0x14e)]=_0x33af98;continue;case'4':_0x33af98[_0x338273(0x130)](0.5,_0x338273(0x200));continue;case'5':_0x35171a[_0x338273(0x1a8)]();continue;case'6':_0x35171a[_0x338273(0x148)]();continue;case'7':_0x33af98[_0x338273(0x130)](0x0,_0x338273(0x1e9));continue;case'8':_0x35171a[_0x338273(0xfb)](_0xfdd81c,_0x543c06,_0x100a6e-0x2,0x0,Math['PI']*0x2);continue;case'9':_0x35171a[_0x338273(0x1a8)]();continue;case'10':_0x35171a[_0x338273(0xfb)](_0x59db3c['gOHBu'](_0xfdd81c,_0x59db3c[_0x338273(0x12c)](_0x100a6e,0.3)),_0x543c06-_0x100a6e*0.3,_0x100a6e*0.2,0x0,Math['PI']*0x2);continue;case'11':_0x35171a[_0x338273(0x14e)]=_0x338273(0x155);continue;case'12':_0x35171a[_0x338273(0xfb)](_0xfdd81c,_0x543c06,_0x100a6e,0x0,_0x59db3c[_0x338273(0x13c)](Math['PI'],0x2));continue;case'13':_0x35171a[_0x338273(0x16c)]();continue;case'14':_0x35171a[_0x338273(0x18d)]=0x0;continue;case'15':_0x35171a[_0x338273(0x16c)]();continue;case'16':_0x35171a[_0x338273(0x16c)]();continue;case'17':_0x35171a[_0x338273(0x167)]=_0x100a6e*0.1;continue;case'18':var _0x18709d=_0x59db3c[_0x338273(0x206)](_0x541b4b,0x1)?_0xe307f8:_0x1cc2d4,_0x3d4aa3=_0x59db3c[_0x338273(0x177)](_0x541b4b,0x1)?_0x270d7e:_0x39e852,_0xe8eb8f=_0x541b4b===0x1?_0x484645:_0x376c0b;continue;case'19':_0x35171a[_0x338273(0x167)]=0x0;continue;case'20':_0x35171a[_0x338273(0x1dd)]();continue;case'21':_0x35171a[_0x338273(0x1a5)]=_0x59db3c[_0x338273(0x207)];continue;case'22':_0x35171a[_0x338273(0xfb)](_0xfdd81c,_0x543c06,_0x59db3c[_0x338273(0x168)](_0x100a6e,0x2),0x0,Math['PI']*0x2);continue;case'23':_0x35171a['globalAlpha']=_0x5d1683;continue;case'24':_0x33af98[_0x338273(0x130)](0x1,_0x338273(0x187));continue;case'25':_0x35171a[_0x338273(0x18d)]=_0x100a6e*0.3;continue;case'26':_0x35171a[_0x338273(0x14e)]=_0xe8eb8f;continue;case'27':if(_0x59db3c['bjHGu'](_0x5d1683,undefined))_0x5d1683=0x1;continue;case'28':_0x35171a[_0x338273(0x1a5)]=_0x338273(0x19d);continue;case'29':_0x35171a[_0x338273(0x14e)]=_0x18709d;continue;case'30':_0x35171a[_0x338273(0x1a8)]();continue;}break;}}function _0x1b7c40(_0x4117f1,_0x5198f5,_0x32de28,_0x51d665,_0x2494a2){var _0x3b6d25=_0x42be23;_0x35171a[_0x3b6d25(0x1a8)](),_0x35171a[_0x3b6d25(0x1f0)](_0x4117f1+_0x2494a2,_0x5198f5),_0x35171a[_0x3b6d25(0x12b)](_0x4117f1+_0x32de28-_0x2494a2,_0x5198f5),_0x35171a[_0x3b6d25(0x1b3)](_0x59db3c[_0x3b6d25(0x1a0)](_0x4117f1,_0x32de28),_0x5198f5,_0x59db3c['UlvpG'](_0x4117f1,_0x32de28),_0x5198f5+_0x2494a2),_0x35171a[_0x3b6d25(0x12b)](_0x59db3c[_0x3b6d25(0x1cd)](_0x4117f1,_0x32de28),_0x59db3c['UlvpG'](_0x5198f5,_0x51d665)-_0x2494a2),_0x35171a[_0x3b6d25(0x1b3)](_0x59db3c[_0x3b6d25(0x1d3)](_0x4117f1,_0x32de28),_0x59db3c[_0x3b6d25(0x121)](_0x5198f5,_0x51d665),_0x59db3c['zkRlj'](_0x59db3c[_0x3b6d25(0x193)](_0x4117f1,_0x32de28),_0x2494a2),_0x59db3c[_0x3b6d25(0x1cd)](_0x5198f5,_0x51d665)),_0x35171a[_0x3b6d25(0x12b)](_0x59db3c[_0x3b6d25(0xfe)](_0x4117f1,_0x2494a2),_0x5198f5+_0x51d665),_0x35171a[_0x3b6d25(0x1b3)](_0x4117f1,_0x59db3c[_0x3b6d25(0x1ab)](_0x5198f5,_0x51d665),_0x4117f1,_0x59db3c[_0x3b6d25(0x166)](_0x5198f5,_0x51d665)-_0x2494a2),_0x35171a[_0x3b6d25(0x12b)](_0x4117f1,_0x59db3c[_0x3b6d25(0x1c1)](_0x5198f5,_0x2494a2)),_0x35171a['quadraticCurveTo'](_0x4117f1,_0x5198f5,_0x59db3c[_0x3b6d25(0x193)](_0x4117f1,_0x2494a2),_0x5198f5),_0x35171a[_0x3b6d25(0x1b6)]();}function _0x332646(){var _0x436b64=_0x42be23;_0x35171a['save'](),_0x35171a['shadowColor']=_0x436b64(0x1d8),_0x35171a[_0x436b64(0x18d)]=0x14,_0x35171a[_0x436b64(0x167)]=0x8,_0x59db3c[_0x436b64(0x18a)](_0x1b7c40,_0x4582ab,_0xe6b5cb-0xa,_0x430cd7*_0x3323ef,_0x59db3c[_0x436b64(0x192)](_0x4bd444,_0x3323ef)+0x14,0xd),_0x35171a[_0x436b64(0x14e)]=_0x436b64(0x188),_0x35171a[_0x436b64(0x16c)](),_0x35171a['shadowColor']=_0x436b64(0x19d),_0x35171a[_0x436b64(0x18d)]=0x0,_0x35171a['shadowOffsetY']=0x0,_0x35171a[_0x436b64(0x10d)]=_0x436b64(0x115),_0x35171a[_0x436b64(0x1b5)]=0x3,_0x35171a[_0x436b64(0x159)](),_0x35171a[_0x436b64(0x1dd)]();for(var _0x168af1=0x0;_0x168af1<_0x4bd444;_0x168af1++){for(var _0x43bb3f=0x0;_0x59db3c[_0x436b64(0x20d)](_0x43bb3f,_0x430cd7);_0x43bb3f++){var _0x3e09eb=_0x5117dc(_0x43bb3f),_0x58d8f3=_0x59db3c['aNGuk'](_0x53ece5,_0x168af1);_0x35171a[_0x436b64(0x1a8)](),_0x35171a[_0x436b64(0xfb)](_0x3e09eb,_0x58d8f3,_0x59db3c[_0x436b64(0x1ce)](_0x100a6e,0x4),0x0,_0x59db3c[_0x436b64(0x192)](Math['PI'],0x2)),_0x35171a[_0x436b64(0x14e)]=_0x59db3c[_0x436b64(0x134)],_0x35171a[_0x436b64(0x16c)]();var _0x32d6a5=_0x60871f[_0x168af1][_0x43bb3f];if(_0x59db3c[_0x436b64(0x15b)](_0x32d6a5,0x0)){if(_0x273a1e&&_0x273a1e[_0x436b64(0x15d)]===_0x168af1&&_0x273a1e['col']===_0x43bb3f)continue;var _0x310e54=![];for(var _0x25bc76=0x0;_0x59db3c['fIfLv'](_0x25bc76,_0x334f40[_0x436b64(0x123)]);_0x25bc76++)if(_0x334f40[_0x25bc76][0x0]===_0x168af1&&_0x59db3c[_0x436b64(0x117)](_0x334f40[_0x25bc76][0x1],_0x43bb3f)){_0x310e54=!![];break;}_0x11683b(_0x3e09eb,_0x58d8f3,_0x32d6a5,_0x310e54&&_0x34f108>0x0?_0x59db3c['sXbkx'](0.4,_0x59db3c[_0x436b64(0x173)](0.6,Math[_0x436b64(0xfa)](Math[_0x436b64(0x201)](_0x59db3c['YJuSf'](_0x34f108,0x5))))):0x1);}else _0x35171a[_0x436b64(0x1a8)](),_0x35171a[_0x436b64(0xfb)](_0x3e09eb,_0x58d8f3,_0x100a6e,0x0,_0x59db3c[_0x436b64(0x1d9)](Math['PI'],0x2)),_0x35171a[_0x436b64(0x14e)]=_0x59db3c['nljwa'],_0x35171a[_0x436b64(0x16c)]();}}}function _0x504c4a(){var _0x59d768=_0x42be23;if(_0x59db3c[_0x59d768(0x18e)](_0xdf7f4a,0x0)||_0x59cb4d||_0x273a1e)return;var _0x162535=_0x59db3c[_0x59d768(0x143)](_0x5117dc,_0xdf7f4a),_0x357071=_0x59db3c[_0x59d768(0x197)](Date[_0x59d768(0x176)](),0x3e8),_0x47c4ea=Math[_0x59d768(0x201)](_0x357071*0x4)*0x6,_0x3b7355=_0x59db3c[_0x59d768(0x1a6)](_0xe6b5cb-_0x59db3c[_0x59d768(0x186)](_0x3323ef,0.6),_0x47c4ea);_0x11683b(_0x162535,_0x3b7355,_0x1e017f,0.7),_0x35171a[_0x59d768(0x148)](),_0x35171a[_0x59d768(0x14e)]=_0x59db3c[_0x59d768(0x1e0)](_0x1e017f,0x1)?_0xe307f8:_0x1cc2d4,_0x35171a[_0x59d768(0x1d5)]=0.8,_0x35171a[_0x59d768(0x1a8)](),_0x35171a[_0x59d768(0x1f0)](_0x162535,_0x59db3c[_0x59d768(0x1bc)](_0x59db3c[_0x59d768(0x1d6)](_0x3b7355,_0x100a6e),0xc)),_0x35171a[_0x59d768(0x12b)](_0x162535-0x8,_0x3b7355+_0x100a6e+0x2),_0x35171a[_0x59d768(0x12b)](_0x59db3c[_0x59d768(0x1c9)](_0x162535,0x8),_0x59db3c['MCuPe'](_0x3b7355,_0x100a6e)+0x2),_0x35171a[_0x59d768(0x1b6)](),_0x35171a['fill'](),_0x35171a[_0x59d768(0x1dd)]();}function _0x6c6dc3(){var _0x588053=_0x42be23;if(!_0x59cb4d)return;_0x35171a['save'](),_0x35171a[_0x588053(0x14e)]=_0x59db3c[_0x588053(0x157)],_0x35171a[_0x588053(0x11a)](0x0,0x0,_0x5e48c4,_0x4c048f);var _0x5df2ff=_0x59db3c[_0x588053(0x1c7)](_0x5e48c4,0.78),_0x282adf=0x82,_0x490050=_0x59db3c[_0x588053(0x103)](_0x5e48c4,_0x5df2ff)/0x2,_0x4edfe3=_0x59db3c[_0x588053(0x1f7)](_0x4c048f,_0x282adf)/0x2;_0x59db3c[_0x588053(0x199)](_0x1b7c40,_0x490050,_0x4edfe3,_0x5df2ff,_0x282adf,0x10),_0x35171a[_0x588053(0x14e)]=_0x588053(0x19a),_0x35171a[_0x588053(0x16c)]();var _0x5e0cf7=_0x334f40[_0x588053(0x123)]?_0x59db3c[_0x588053(0x1e0)](_0x1e017f,0x1)?_0xe307f8:_0x1cc2d4:_0x588053(0x1a2);_0x35171a[_0x588053(0x10d)]=_0x5e0cf7,_0x35171a['lineWidth']=2.5,_0x35171a[_0x588053(0x159)](),_0x35171a[_0x588053(0xf9)]=_0x59db3c[_0x588053(0x161)],_0x35171a[_0x588053(0x15a)]=_0x59db3c[_0x588053(0x1af)](_0x59db3c[_0x588053(0x16b)](_0x59db3c[_0x588053(0x116)],Math[_0x588053(0x1c5)](_0x59db3c[_0x588053(0x1e4)](_0x3323ef,0.42))),_0x59db3c[_0x588053(0x12a)]),_0x35171a['fillStyle']=_0x5e0cf7,_0x35171a[_0x588053(0x1be)](_0x334f40[_0x588053(0x123)]?_0x59db3c['tRAAn']('GIOCATORE\x20'+_0x1e017f,_0x588053(0x194)):_0x588053(0x17e),_0x5e48c4/0x2,_0x4edfe3+_0x59db3c[_0x588053(0x197)](_0x282adf,0x2)-0xa),_0x35171a[_0x588053(0x15a)]=Math[_0x588053(0x1c5)](_0x59db3c[_0x588053(0x10a)](_0x3323ef,0.21))+_0x59db3c['tcavu'],_0x35171a[_0x588053(0x14e)]=_0x588053(0x1a1),_0x35171a[_0x588053(0x1be)]('premi\x20R\x20o\x20clicca\x20Nuova\x20partita',_0x5e48c4/0x2,_0x59db3c[_0x588053(0x1f4)](_0x59db3c[_0x588053(0x203)](_0x4edfe3,_0x282adf/0x2),0x1a)),_0x35171a[_0x588053(0x1dd)]();}function _0x4905d8(_0x13c11d){var _0x2e8bb9=_0x42be23,_0x293d00={'BOuSa':function(_0x49e8e0,_0x54d270){var _0x2717f9=a0_0x1953;return _0x59db3c[_0x2717f9(0x1bd)](_0x49e8e0,_0x54d270);},'XenXm':function(_0x114078){return _0x114078();}};if(_0x273a1e){var _0xeacba0=_0x53ece5(_0x273a1e[_0x2e8bb9(0x15d)]);_0x273a1e['sp']+=_0x59db3c[_0x2e8bb9(0x19b)](_0x3323ef,0.8)*_0x13c11d,_0x273a1e['y']+=_0x273a1e['sp'];if(_0x59db3c[_0x2e8bb9(0x1c2)](_0x273a1e['y'],_0xeacba0)){var _0x626e5a=_0x2e8bb9(0x127)['split']('|'),_0x587d02=0x0;while(!![]){switch(_0x626e5a[_0x587d02++]){case'0':_0x59db3c[_0x2e8bb9(0x1f9)](_0x1dda2f,_0x59db3c[_0x2e8bb9(0x129)](_0x5117dc,_0x273a1e[_0x2e8bb9(0x1df)]),_0x59db3c[_0x2e8bb9(0x143)](_0x53ece5,_0x273a1e[_0x2e8bb9(0x15d)]),_0x273a1e['pl'],0xc);continue;case'1':_0x273a1e['y']=_0xeacba0;continue;case'2':if(_0xd5e3a1){_0x59cb4d=!![],_0x334f40=_0xd5e3a1;for(var _0x8dfde3=0x0;_0x59db3c[_0x2e8bb9(0x184)](_0x8dfde3,_0xd5e3a1[_0x2e8bb9(0x123)]);_0x8dfde3++)_0x59db3c['WfoYC'](_0x1dda2f,_0x5117dc(_0xd5e3a1[_0x8dfde3][0x1]),_0x53ece5(_0xd5e3a1[_0x8dfde3][0x0]),_0x273a1e['pl'],0x12);_0x2eb27b[_0x273a1e['pl']-0x1]++;}else{if(_0x59db3c[_0x2e8bb9(0x190)](_0xdb633))_0x59cb4d=!![];else _0x1e017f=0x3-_0x273a1e['pl'];}continue;case'3':_0x273a1e=null;continue;case'4':var _0xd5e3a1=_0x59db3c[_0x2e8bb9(0x143)](_0x5d5b1a,_0x273a1e['pl']);continue;case'5':_0x46d7b5&&!_0x59cb4d&&_0x1e017f===0x2&&(_0x3a8785=!![],setTimeout(function(){var _0x8905cf=_0x2e8bb9;_0x3a8785=![];if(!_0x59cb4d&&_0x293d00['BOuSa'](_0x1e017f,0x2)&&!_0x273a1e)_0x293d00[_0x8905cf(0x1e5)](_0x1467b1);},0x208));continue;case'6':_0x60871f[_0x273a1e[_0x2e8bb9(0x15d)]][_0x273a1e[_0x2e8bb9(0x1df)]]=_0x273a1e['pl'];continue;case'7':_0x56fa05();continue;}break;}}}for(var _0xef2879=_0x12a13f[_0x2e8bb9(0x123)]-0x1;_0xef2879>=0x0;_0xef2879--){_0x12a13f[_0xef2879][_0x2e8bb9(0x13d)](_0x13c11d);if(_0x12a13f[_0xef2879][_0x2e8bb9(0x172)]>=_0x12a13f[_0xef2879]['ml']||_0x12a13f[_0xef2879]['sz']<0.5)_0x12a13f['splice'](_0xef2879,0x1);}if(_0x59cb4d&&_0x334f40[_0x2e8bb9(0x123)])_0x34f108+=_0x13c11d;if(_0x266fb8>0x0)_0x266fb8-=_0x13c11d;}function _0x180289(){var _0x58c1c9=_0x42be23,_0x2ed310='3|11|0|8|4|7|9|6|10|2|1|5'[_0x58c1c9(0x17d)]('|'),_0x2a3abf=0x0;while(!![]){switch(_0x2ed310[_0x2a3abf++]){case'0':_0x4f3a47[_0x58c1c9(0x130)](0x0,_0x58c1c9(0x163));continue;case'1':_0x6c6dc3();continue;case'2':for(var _0x31e271=0x0;_0x59db3c[_0x58c1c9(0x18e)](_0x31e271,_0x12a13f[_0x58c1c9(0x123)]);_0x31e271++)_0x12a13f[_0x31e271]['draw']();continue;case'3':_0x35171a['clearRect'](0x0,0x0,_0x5e48c4,_0x4c048f);continue;case'4':_0x35171a[_0x58c1c9(0x14e)]=_0x4f3a47;continue;case'5':if(_0x266fb8>0x0){var _0x4777d2=_0x58c1c9(0x1e7)[_0x58c1c9(0x17d)]('|'),_0xb4f0cc=0x0;while(!![]){switch(_0x4777d2[_0xb4f0cc++]){case'0':_0x35171a[_0x58c1c9(0x14e)]=_0x58c1c9(0x1a2);continue;case'1':_0x35171a['fillRect'](_0x4582ab,_0x59db3c[_0x58c1c9(0x20a)](_0xe6b5cb,0xa),_0x430cd7*_0x3323ef,_0x59db3c[_0x58c1c9(0x14c)](_0x59db3c[_0x58c1c9(0x158)](_0x4bd444,_0x3323ef),0x14));continue;case'2':_0x35171a['save']();continue;case'3':_0x35171a[_0x58c1c9(0x1dd)]();continue;case'4':_0x35171a['globalAlpha']=_0x59db3c[_0x58c1c9(0x192)](_0x59db3c[_0x58c1c9(0x197)](_0x266fb8,0.35),0.45);continue;}break;}}continue;case'6':_0x59db3c[_0x58c1c9(0x190)](_0x332646);continue;case'7':_0x35171a[_0x58c1c9(0x11a)](0x0,0x0,_0x5e48c4,_0x4c048f);continue;case'8':_0x4f3a47[_0x58c1c9(0x130)](0x1,_0x59db3c[_0x58c1c9(0x17b)]);continue;case'9':_0x59db3c[_0x58c1c9(0x138)](_0x504c4a);continue;case'10':if(_0x273a1e)_0x59db3c[_0x58c1c9(0x16a)](_0x11683b,_0x59db3c[_0x58c1c9(0x1ae)](_0x5117dc,_0x273a1e[_0x58c1c9(0x1df)]),_0x273a1e['y'],_0x273a1e['pl'],0x1);continue;case'11':var _0x4f3a47=_0x35171a[_0x58c1c9(0x1d1)](0x0,0x0,0x0,_0x4c048f);continue;}break;}}function _0x14a244(_0x5c03b1){var _0x281a1f=_0x42be23,_0x41c948='2|4|3|0|1'[_0x281a1f(0x17d)]('|'),_0x247fec=0x0;while(!![]){switch(_0x41c948[_0x247fec++]){case'0':_0x180289();continue;case'1':_0x59db3c[_0x281a1f(0x129)](requestAnimationFrame,_0x14a244);continue;case'2':var _0x2d2408=_0x59db3c[_0x281a1f(0x1f2)](_0x5c03b1,0x3e8),_0x3ed3c8=Math[_0x281a1f(0x1ac)](_0x59db3c[_0x281a1f(0x1e3)](_0x2d2408,_0x59db3c[_0x281a1f(0x1c6)](_0x463c8d,_0x2d2408)),0.05);continue;case'3':_0x59db3c[_0x281a1f(0x1ae)](_0x4905d8,_0x3ed3c8);continue;case'4':_0x463c8d=_0x2d2408;continue;}break;}}function _0x518d14(_0x4d9bc5){var _0x334cd0=_0x42be23,_0x1d792f=_0x407e23[_0x334cd0(0x18f)](),_0x853779=_0x5e48c4/_0x1d792f[_0x334cd0(0x185)],_0x3ded69=_0x59db3c[_0x334cd0(0x103)](_0x4d9bc5,_0x1d792f[_0x334cd0(0x104)])*_0x853779,_0x576402=Math[_0x334cd0(0x1c5)](_0x59db3c[_0x334cd0(0x101)](_0x3ded69,_0x4582ab)/_0x3323ef);return _0x59db3c[_0x334cd0(0x1c2)](_0x576402,0x0)&&_0x59db3c[_0x334cd0(0x196)](_0x576402,_0x430cd7)?_0x576402:-0x1;}function _0x15597d(_0xda1711,_0x51df96){var _0x5adcce=_0x42be23,_0x38815a='3|6|5|2|1|4|0'[_0x5adcce(0x17d)]('|'),_0x444c2c=0x0;while(!![]){switch(_0x38815a[_0x444c2c++]){case'0':return 0x0;case'1':if(_0x30cca1===0x3)return 0x5;continue;case'2':if(_0x59db3c[_0x5adcce(0x180)](_0x30cca1,0x4))return 0x64;continue;case'3':var _0x30cca1=0x0,_0xd6fe47=0x0,_0x414c50=_0x51df96===0x1?0x2:0x1,_0x141db2;continue;case'4':if(_0x59db3c[_0x5adcce(0x17a)](_0x30cca1,0x2))return 0x2;continue;case'5':if(_0xd6fe47>0x0)return 0x0;continue;case'6':for(_0x141db2=0x0;_0x59db3c[_0x5adcce(0x184)](_0x141db2,0x4);_0x141db2++){if(_0x59db3c[_0x5adcce(0x1c4)](_0xda1711[_0x141db2],_0x51df96))_0x30cca1++;else{if(_0xda1711[_0x141db2]===_0x414c50)_0xd6fe47++;}}continue;}break;}}function _0x9400f8(_0x24aba6,_0x382993){var _0x4c6d38=_0x42be23,_0x57270f=_0x4c6d38(0x1cf)[_0x4c6d38(0x17d)]('|'),_0x30601e=0x0;while(!![]){switch(_0x57270f[_0x30601e++]){case'0':for(_0x277dac=0x3;_0x277dac<_0x4bd444;_0x277dac++)for(_0x21da1e=0x0;_0x21da1e<=_0x59db3c[_0x4c6d38(0x20a)](_0x430cd7,0x4);_0x21da1e++){_0x571f34+=_0x15597d([_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x277dac-0x1][_0x21da1e+0x1],_0x24aba6[_0x59db3c['ToUkA'](_0x277dac,0x2)][_0x59db3c[_0x4c6d38(0x1c9)](_0x21da1e,0x2)],_0x24aba6[_0x277dac-0x3][_0x21da1e+0x3]],_0x382993),_0x571f34-=_0x59db3c[_0x4c6d38(0x107)](_0x15597d,[_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x59db3c[_0x4c6d38(0x1e3)](_0x277dac,0x1)][_0x21da1e+0x1],_0x24aba6[_0x277dac-0x2][_0x21da1e+0x2],_0x24aba6[_0x277dac-0x3][_0x59db3c[_0x4c6d38(0x1eb)](_0x21da1e,0x3)]],_0x215583);}continue;case'1':for(_0x277dac=0x0;_0x277dac<_0x4bd444;_0x277dac++)for(_0x21da1e=0x0;_0x59db3c['ngzDb'](_0x21da1e,_0x59db3c[_0x4c6d38(0x1da)](_0x430cd7,0x4));_0x21da1e++){_0x571f34+=_0x59db3c[_0x4c6d38(0x107)](_0x15597d,[_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x277dac][_0x59db3c[_0x4c6d38(0x1c9)](_0x21da1e,0x1)],_0x24aba6[_0x277dac][_0x21da1e+0x2],_0x24aba6[_0x277dac][_0x59db3c[_0x4c6d38(0x126)](_0x21da1e,0x3)]],_0x382993),_0x571f34-=_0x59db3c[_0x4c6d38(0x118)](_0x15597d,[_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x277dac][_0x59db3c[_0x4c6d38(0x111)](_0x21da1e,0x1)],_0x24aba6[_0x277dac][_0x59db3c[_0x4c6d38(0x191)](_0x21da1e,0x2)],_0x24aba6[_0x277dac][_0x21da1e+0x3]],_0x215583);}continue;case'2':for(_0x21da1e=0x0;_0x21da1e<_0x430cd7;_0x21da1e++)for(_0x277dac=0x0;_0x59db3c[_0x4c6d38(0x128)](_0x277dac,_0x59db3c[_0x4c6d38(0x103)](_0x4bd444,0x4));_0x277dac++){_0x571f34+=_0x15597d([_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x59db3c[_0x4c6d38(0x14f)](_0x277dac,0x1)][_0x21da1e],_0x24aba6[_0x277dac+0x2][_0x21da1e],_0x24aba6[_0x277dac+0x3][_0x21da1e]],_0x382993),_0x571f34-=_0x59db3c['yWIay'](_0x15597d,[_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x277dac+0x1][_0x21da1e],_0x24aba6[_0x277dac+0x2][_0x21da1e],_0x24aba6[_0x59db3c[_0x4c6d38(0x1bc)](_0x277dac,0x3)][_0x21da1e]],_0x215583);}continue;case'3':return _0x571f34;case'4':for(_0x277dac=0x0;_0x277dac<=_0x4bd444-0x4;_0x277dac++)for(_0x21da1e=0x0;_0x21da1e<=_0x59db3c[_0x4c6d38(0x1f7)](_0x430cd7,0x4);_0x21da1e++){_0x571f34+=_0x15597d([_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x277dac+0x1][_0x21da1e+0x1],_0x24aba6[_0x277dac+0x2][_0x59db3c[_0x4c6d38(0x1fb)](_0x21da1e,0x2)],_0x24aba6[_0x59db3c[_0x4c6d38(0x169)](_0x277dac,0x3)][_0x21da1e+0x3]],_0x382993),_0x571f34-=_0x15597d([_0x24aba6[_0x277dac][_0x21da1e],_0x24aba6[_0x277dac+0x1][_0x21da1e+0x1],_0x24aba6[_0x59db3c[_0x4c6d38(0x140)](_0x277dac,0x2)][_0x21da1e+0x2],_0x24aba6[_0x277dac+0x3][_0x59db3c[_0x4c6d38(0x1f1)](_0x21da1e,0x3)]],_0x215583);}continue;case'5':var _0x571f34=0x0,_0x20fc4b=Math['floor'](_0x59db3c[_0x4c6d38(0x197)](_0x430cd7,0x2)),_0x277dac,_0x21da1e,_0x215583=_0x59db3c['uZVHu'](_0x382993,0x1)?0x2:0x1;continue;case'6':for(_0x277dac=0x0;_0x277dac<_0x4bd444;_0x277dac++)if(_0x24aba6[_0x277dac][_0x20fc4b]===_0x382993)_0x571f34+=0x3;continue;}break;}}function _0x1845d1(_0x4126e6,_0x4ca565){var _0x1b83ac=_0x42be23,_0x239611,_0x55e8fb;for(_0x239611=0x0;_0x59db3c[_0x1b83ac(0x1a4)](_0x239611,_0x4bd444);_0x239611++)for(_0x55e8fb=0x0;_0x55e8fb<=_0x430cd7-0x4;_0x55e8fb++)if(_0x4126e6[_0x239611][_0x55e8fb]===_0x4ca565&&_0x4126e6[_0x239611][_0x55e8fb+0x1]===_0x4ca565&&_0x59db3c[_0x1b83ac(0x122)](_0x4126e6[_0x239611][_0x55e8fb+0x2],_0x4ca565)&&_0x59db3c[_0x1b83ac(0x1e6)](_0x4126e6[_0x239611][_0x55e8fb+0x3],_0x4ca565))return!![];for(_0x239611=0x0;_0x239611<=_0x4bd444-0x4;_0x239611++)for(_0x55e8fb=0x0;_0x59db3c[_0x1b83ac(0x1a4)](_0x55e8fb,_0x430cd7);_0x55e8fb++)if(_0x4126e6[_0x239611][_0x55e8fb]===_0x4ca565&&_0x4126e6[_0x59db3c[_0x1b83ac(0x1b9)](_0x239611,0x1)][_0x55e8fb]===_0x4ca565&&_0x59db3c[_0x1b83ac(0x1e0)](_0x4126e6[_0x59db3c[_0x1b83ac(0x10e)](_0x239611,0x2)][_0x55e8fb],_0x4ca565)&&_0x59db3c[_0x1b83ac(0x209)](_0x4126e6[_0x59db3c[_0x1b83ac(0x11b)](_0x239611,0x3)][_0x55e8fb],_0x4ca565))return!![];for(_0x239611=0x3;_0x239611<_0x4bd444;_0x239611++)for(_0x55e8fb=0x0;_0x59db3c['MIwWk'](_0x55e8fb,_0x59db3c['JeDJJ'](_0x430cd7,0x4));_0x55e8fb++)if(_0x4126e6[_0x239611][_0x55e8fb]===_0x4ca565&&_0x4126e6[_0x59db3c[_0x1b83ac(0x1ef)](_0x239611,0x1)][_0x59db3c[_0x1b83ac(0x1b9)](_0x55e8fb,0x1)]===_0x4ca565&&_0x4126e6[_0x59db3c[_0x1b83ac(0x103)](_0x239611,0x2)][_0x59db3c[_0x1b83ac(0x14f)](_0x55e8fb,0x2)]===_0x4ca565&&_0x59db3c[_0x1b83ac(0x177)](_0x4126e6[_0x59db3c['EQHaR'](_0x239611,0x3)][_0x59db3c[_0x1b83ac(0x1ed)](_0x55e8fb,0x3)],_0x4ca565))return!![];for(_0x239611=0x0;_0x239611<=_0x4bd444-0x4;_0x239611++)for(_0x55e8fb=0x0;_0x55e8fb<=_0x59db3c['uuuEk'](_0x430cd7,0x4);_0x55e8fb++)if(_0x59db3c[_0x1b83ac(0x108)](_0x4126e6[_0x239611][_0x55e8fb],_0x4ca565)&&_0x4126e6[_0x59db3c['dVhuv'](_0x239611,0x1)][_0x55e8fb+0x1]===_0x4ca565&&_0x4126e6[_0x59db3c[_0x1b83ac(0x16b)](_0x239611,0x2)][_0x55e8fb+0x2]===_0x4ca565&&_0x59db3c[_0x1b83ac(0x206)](_0x4126e6[_0x59db3c[_0x1b83ac(0x15e)](_0x239611,0x3)][_0x55e8fb+0x3],_0x4ca565))return!![];return![];}function _0x58211e(_0x2a467b){var _0x407098=_0x42be23,_0x47d2d1=[],_0x32fd23;for(_0x32fd23=0x0;_0x59db3c[_0x407098(0x196)](_0x32fd23,_0x430cd7);_0x32fd23++)if(_0x59db3c[_0x407098(0x1e6)](_0x2a467b[0x0][_0x32fd23],0x0))_0x47d2d1[_0x407098(0x132)](_0x32fd23);return _0x47d2d1;}function _0x4e877b(_0x1016c0,_0x4d1231,_0x22500c){var _0x4313c0=_0x42be23,_0x23a499=[],_0x2fd5ce;for(_0x2fd5ce=0x0;_0x2fd5ce<_0x4bd444;_0x2fd5ce++)_0x23a499[_0x4313c0(0x132)](_0x1016c0[_0x2fd5ce][_0x4313c0(0x153)]());for(_0x2fd5ce=_0x4bd444-0x1;_0x2fd5ce>=0x0;_0x2fd5ce--)if(_0x59db3c[_0x4313c0(0x133)](_0x23a499[_0x2fd5ce][_0x4d1231],0x0)){_0x23a499[_0x2fd5ce][_0x4d1231]=_0x22500c;break;}return _0x23a499;}function _0x359f86(_0x34f247,_0x283e48,_0x2f78b8,_0x231bad,_0x27c121){var _0x9cc26a=_0x42be23,_0x18f298=_0x58211e(_0x34f247),_0x4f16a7,_0x1b0a1d,_0xc58d48,_0x12ea0f=Math[_0x9cc26a(0x1c5)](_0x430cd7/0x2);if(_0x59db3c[_0x9cc26a(0x107)](_0x1845d1,_0x34f247,0x2))return{'s':0x186a0+_0x283e48,'c':-0x1};if(_0x59db3c[_0x9cc26a(0x10b)](_0x1845d1,_0x34f247,0x1))return{'s':-0x186a0-_0x283e48,'c':-0x1};if(!_0x18f298['length']||!_0x283e48)return{'s':_0x59db3c['oVaoB'](_0x9400f8,_0x34f247,0x2),'c':-0x1};_0x18f298[_0x9cc26a(0x1d7)](function(_0x524846,_0xd6aca){var _0x4fb763=_0x9cc26a;return Math[_0x4fb763(0xfa)](_0x59db3c[_0x4fb763(0x149)](_0x524846,_0x12ea0f))-Math[_0x4fb763(0xfa)](_0xd6aca-_0x12ea0f);});var _0x1a0f44={'s':_0x27c121?-0x3b9aca00:0x3b9aca00,'c':_0x18f298[0x0]};for(_0x4f16a7=0x0;_0x4f16a7<_0x18f298['length'];_0x4f16a7++){_0x1b0a1d=_0x4e877b(_0x34f247,_0x18f298[_0x4f16a7],_0x27c121?0x2:0x1),_0xc58d48=_0x359f86(_0x1b0a1d,_0x283e48-0x1,_0x2f78b8,_0x231bad,!_0x27c121);if(_0x27c121?_0x59db3c[_0x9cc26a(0x1fe)](_0xc58d48['s'],_0x1a0f44['s']):_0xc58d48['s']<_0x1a0f44['s'])_0x1a0f44={'s':_0xc58d48['s'],'c':_0x18f298[_0x4f16a7]};if(_0x27c121)_0x2f78b8=Math[_0x9cc26a(0x150)](_0x2f78b8,_0x1a0f44['s']);else _0x231bad=Math[_0x9cc26a(0x1ac)](_0x231bad,_0x1a0f44['s']);if(_0x59db3c[_0x9cc26a(0x14b)](_0x2f78b8,_0x231bad))break;}return _0x1a0f44;}function _0x1467b1(){var _0x1fc0f2=_0x42be23,_0x54c150=_0x59db3c[_0x1fc0f2(0x18a)](_0x359f86,_0x60871f,0x6,-0x3b9aca00,0x3b9aca00,!![]);_0x4e8732(_0x54c150['c']);}_0x46d7b5=![],_0x3a8785=![],_0x2eb27b=[0x0,0x0],_0x59db3c[_0x42be23(0x138)](_0x547ec7),_0x59db3c[_0x42be23(0x182)](_0x526670),_0x407e23['addEventListener'](_0x59db3c[_0x42be23(0x1dc)],function(_0x90b84a){var _0x26d600=_0x42be23;_0xdf7f4a=_0x59db3c[_0x26d600(0x1de)](_0x518d14,_0x90b84a[_0x26d600(0x179)]);}),_0x407e23[_0x42be23(0xfc)](_0x59db3c['LkUjh'],function(){_0xdf7f4a=-0x1;}),_0x407e23[_0x42be23(0xfc)](_0x42be23(0x1ad),function(_0x150555){var _0x4ce680=_0x42be23;if(!_0x59cb4d&&!(_0x46d7b5&&(_0x59db3c[_0x4ce680(0x17a)](_0x1e017f,0x2)||_0x3a8785))){var _0x4e6570=_0x59db3c[_0x4ce680(0x100)](_0x518d14,_0x150555[_0x4ce680(0x179)]);if(_0x4e6570>=0x0)_0x4e8732(_0x4e6570);}}),_0x407e23[_0x42be23(0xfc)](_0x59db3c[_0x42be23(0x181)],function(_0x16e617){var _0x4be715=_0x42be23;_0x16e617['preventDefault']();if(!_0x59cb4d&&!(_0x46d7b5&&(_0x59db3c[_0x4be715(0x131)](_0x1e017f,0x2)||_0x3a8785))){var _0x1807cc=_0x59db3c['pXRyM'](_0x518d14,_0x16e617[_0x4be715(0x11e)][0x0]['clientX']);if(_0x1807cc>=0x0)_0x59db3c[_0x4be715(0x17f)](_0x4e8732,_0x1807cc);}},{'passive':![]}),document[_0x42be23(0xfc)](_0x42be23(0x11d),function(_0x2d4bb7){var _0x3585c9=_0x42be23;if(_0x59db3c['WlVtA'](_0x2d4bb7['key'],'r')||_0x2d4bb7[_0x3585c9(0x135)]==='R')_0x59db3c[_0x3585c9(0x13e)](_0x526670);}),document[_0x42be23(0x1c3)](_0x42be23(0x208))[_0x42be23(0xfc)](_0x42be23(0x1ad),_0x526670),document[_0x42be23(0x1c3)](_0x59db3c[_0x42be23(0x142)])[_0x42be23(0xfc)](_0x59db3c[_0x42be23(0xfd)],function(){var _0x25ff32=_0x42be23,_0xfdb601=_0x59db3c[_0x25ff32(0x1bb)]['split']('|'),_0x2bdc5a=0x0;while(!![]){switch(_0xfdb601[_0x2bdc5a++]){case'0':_0x46d7b5=!_0x46d7b5;continue;case'1':this[_0x25ff32(0x13a)]=_0x46d7b5?_0x59db3c[_0x25ff32(0x145)]:_0x59db3c[_0x25ff32(0x1d4)];continue;case'2':_0x59db3c[_0x25ff32(0x190)](_0x526670);continue;case'3':this[_0x25ff32(0x151)][_0x25ff32(0x165)]=_0x46d7b5?_0x59db3c[_0x25ff32(0x1aa)]:_0x25ff32(0x1a2);continue;case'4':this[_0x25ff32(0x151)][_0x25ff32(0x1a7)]=_0x46d7b5?_0x25ff32(0x10f):_0x59db3c[_0x25ff32(0x204)];continue;}break;}}),_0x59db3c[_0x42be23(0x1d2)](requestAnimationFrame,_0x14a244);}()));function a0_0x213a(){var _0x15e8ed=['Cw1kBKq','Bwf4','C3r5Bgu','nJa5mtu1ngP2yKH6tq','C2XPy2u','mtm1uu1ttg1e','CMDIysGYntuSmJu1ldi1nsWUnJuP','tu1vr28','tu9dAxm','DxHmEue','C3rYB2TL','zM9UDa','qwDWyLG','ntqXnJa4A0DkyKLb','CM93','qvv5ru8','mtb8mhWXFdD8nNWYFdH8nxWXmxWZFdL8na','r2LVy2f0B3jLia','uhP4CgC','mhWXFdr8mNWZ','iZa4mguXna','CM9Rque','y29SB3i','ChvKsfq','C2HHzg93t2zMC2v0wq','uhzkwhy','Cw51vKS','Bw9RBNC','yxrOyNG','zMLSBa','Dg91y2HZDgfYDa','rgfvD1K','rhDjy3q','CMnZtvi','mhWXFdn8nhWY','BgLMzq','vuXev0O','s3zAqNC','zg5cvKS','BM93','v0Luq1q','tvHZsgG','y2XPzw50wa','z1bVque','C1rxExa','DvPwshu','C3bSAxq','uefsruDhsu8H','Aun4Cfu','Cw5hC08','wxvkuue','vMrTsLO','iZy5zJbHzq','s1zbsfK','D2LKDgG','CejizM8','CMDIysGWldaSmcWUmIK','CMDIysGYnsW1mcWXnJaSmsK','A01IDwy','yK5yuxu','i2vMntm1ma','mJD8mtH8nNWYm3WYmxWYnxWXn3W5FdeYFdi2FdeZFdi4Fde0Fde5Fdf8mJj8mJL8mhWYFdD8nhWYnhWZmhW4Fdn8mtz8nxWXmhWXmxWXnxWYma','C2HHzg93qMX1CG','Cu9yDhG','z2v0qM91BMrPBMDdBgLLBNrszwn0','r3Hqy1a','CK9AB2u','tw5JBue','uNDQDNy','ifzjtKnfisdWN4+g','yM9Szca','ANrRzNa','tKrVz1q','i2zMoge4ma','vhPgzLC','CMDIysGXmcWXnsW0mcWUotuP','ExnVquu','vhvYBM86ieDPB2nHDg9Yzsa','DhjHBNnWyxjLBNq','sKrzA04','nLHMr2Pwva','r2nuEeS','iZu0nMu3yq','iZi2yZzKyq','tun1ugu','s2zPtwy','C2HHzg93q29SB3i','qM5NrwO','yM9YzgvYq29SB3i','yMvNAw5qyxrO','y2vUDgvY','ALPPDge','qM1QBfa','BwLU','y2XPy2S','CfHsEu0','rKvpEhO','rvjst1jfiePtoIa','Eej0D2e','n3WWFdz8nxWYFdf8m3W0','CxvHzhjHDgLJq3vYDMvuBW','s1rfB0O','BgLUzvDPzhrO','y2XVC2vqyxrO','yvrZt3e','z3nktgO','uwXnvNO','lNDYyxa','y3LXseu','DKvdrMm','wwHItKu','zMLSBfrLEhq','nJa5ote5mhPkzKDeCG','EhHdzge','vwX2CeC','Cg5nrui','z2v0rwXLBwvUDej5swq','Avnyy1m','zMXVB3i','zvDKExu','wuP1u2y','ChGGiLnOyxjLifrLy2GGtw9UBYiSBw9UB3nWywnL','rNDvtvO','iZbKmtuYma','tKLgtuO','y29UC3rYDwn0B3i','zg1kyKW','DgfuDK4','nxW2Fdf8mNWWFdr8mW','uxPduue','y3jLyxrLtgLUzwfYr3jHzgLLBNq','AgT4sva','vKjArKG','DMTIrhi','z2XVyMfSqwXWAge','EuvwDvu','C29YDa','CMDIysGWldaSmcWUnIK','rhLZBfG','BvHVsgm','y3jLyxrLuMfKAwfSr3jHzgLLBNq','swLVrhK','CMvZDg9Yzq','A2L4uxq','y29S','swrpBNC','r3fRvg4','ChjVDg90ExbL','s1Louxe','Cvv1uvm','wgvUwg0','sMjquNC','mNW0Fdb8mxWZ','mJe4nZuXnJfqq21pr2S','CMDIysGYntuSmJu1ldi1nsWUmZuP','qw56B2W','EKzlqMK','z2v0q29UDgv4Da','r2jjBgi','B25LCNjVCG','BhLTCey','Bw92zvrV','D1HuBem','yw9eyMm','mJm4mdaZnKLruwPryG','zLLPrxa','zgL2','y3zZ','BwfRz2y','q29TChv0zxiGvKLoq0uHipcFPjy','v2zVwum','Aw5Zzxj0qMvMB3jL','r1vHwfG','rML2wKG','vvbQqNy','t1j3B0O','Eg9tqwm','CMDIysGYntuSmJu1ldi1nsWUmduP','C2LU','y3jLyxrLrwXLBwvUDa','AK9qsuS','A1LOy00','yMfJA2DYB3vUzdOJyJCXyZfJo2nVBg9YoInMzMy7CgfKzgLUzZOXmhb4o2jVCMrLCI1YywrPDxm6nNb4o2zVBNqTzMfTAwX5oM1VBM9ZCgfJztTMB250lxnPEMu6mtjWEdTTyxjNAw46mtbWEcaWo3rLEhqTywXPz246BgvMDa','veHlBvq','t3H0D0G','CMj0BG','t1vvBNi','BuXts28','yufZAhi','yxbWBhK','qufSuMi','Dgv4DefSAwDU','ywjZ','yxjJ','ywrKrxzLBNrmAxn0zw5LCG','uLf3Exe','v3jZwwG','i2zMzMy2yG','r3rbsgy','z09iqNu','CMDIysGZocWXotGSmJe4lc4Zkq','EfH4CK4','BgvMDa','rfbXAK0','sNrVzNi','B1zHB0i','BKXUEge','mxW0Fdj8mhWZ','A2jNs3G','v2XYq20','kcGOlISPkYKRksSK','C3rYB2TLu3r5Bgu','AefODxq','CMDIysGXmduSmJqWlde3ncWUncK','rhPVrw4','CuHODK4','ywPKALq','CMDIysGXmcWXocW2mcWXkq','nuvbquvyzG','CMDIysG2mcWXmdaSmJiWldeP','quTZAeG','zxLdvNa','Cwfqvw8','q29TChv0zxiGC3rHihbLBNnHBMrVlI4UipcFPjy','zMLSBfjLy3q','Dfjbqw4','BgPvyLK','A2v5zg93BG','Dg91y2HLCW','CMDIysG1ldeWldm1ldeP','ndKYotmYmwTJtgHnwq','u0LIuvO','zefrwNu','BgvUz3rO','i2zMzdyWma','DNmGq1bvoIbptIdWN6sw','zfzODxy','mxW2Fdb8nhWYFdn8n3W1','BMD6rgi','C1fMrLe','vu1esfK','BgLUzvrV','zNfvrvG','AgvPz2H0','C1HIA3G','Dg9tDhjPBMC','ywrKq29SB3jtDg9W','zKzVwhy','ChvZAa','DLjTDgG','zMfXA2m','A2v5','Bw91C2vTB3zL','CMfUzg9T','v0LkrKq','y1PurLe','Dgv4DenVBNrLBNq','ChGGiKv4BYaYiIXZyw5ZlxnLCMLM','ELHxu3K','DxbK','Bg5dCK8','icHSAw5Lysa','qMjLCeq','zhjHDW','qMjhrKC','yu5hDwS','CMDIysGWldaSmcWUnsK','tMnNCNC','mZiXntyYwfDUCMTA','nevrthjbyG','C2f2zq','yuzdALK','Bwj0BG','zLvxvxa','zhHAEeW','C2vHCMnO','zMLSBfn0EwXL'];a0_0x213a=function(){return _0x15e8ed;};return a0_0x213a();}
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
