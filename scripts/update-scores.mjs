// MLFL score robot. GitHub runs this every 10 minutes (see .github/workflows/scores.yml).
// It looks for games in data.json that have kicked off but have no final score yet,
// asks ESPN's public scoreboard for them, and writes in any final scores it finds.
// Picks, lines and everything else in data.json are left exactly as they are.
import fs from 'node:fs';

const FILE = process.argv[2] || 'data.json';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const DAY = 86400000;
const now = Date.now();

const key = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ymd = (t) => { const d = new Date(t); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); };

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// Games that started in the last 3 days and are not final yet.
const targets = [];
for (const [n, w] of Object.entries(data.weeks || {})) {
  for (const [gid, g] of Object.entries(w.games || {})) {
    if (g.fin || !g.kick) continue;
    const k = Date.parse(g.kick);
    if (now >= k && now <= k + 3 * DAY) targets.push({ n, gid, g, k });
  }
}
if (!targets.length) { console.log('No games waiting for a final score.'); process.exit(0); }

const from = ymd(Math.min(...targets.map((t) => t.k)) - DAY), to = ymd(Math.max(...targets.map((t) => t.k)) + DAY);
const res = await fetch(`${ESPN}?limit=100&dates=${from}-${to}`, { headers: { 'User-Agent': 'MLFL-score-robot' } });
if (!res.ok) { console.log(`ESPN answered ${res.status}; trying again next run.`); process.exit(0); }
const json = await res.json();

const events = (json.events || []).map((ev) => {
  const c = (ev.competitions || [])[0] || {}, st = ((c.status || ev.status || {}).type) || {}, cs = c.competitors || [];
  const side = (h) => cs.find((x) => x.homeAway === h) || {};
  const names = (x) => { const t = x.team || {}; return [t.name, t.shortDisplayName, t.displayName].filter(Boolean).map(key); };
  const a = side('away'), h = side('home');
  return { away: names(a), home: names(h), sa: parseInt(a.score, 10), sh: parseInt(h.score, 10), completed: !!st.completed };
});
const has = (arr, k) => arr.some((x) => x === k || x.endsWith(k));

let saved = 0;
for (const { n, g } of targets) {
  const A = key(g.away), H = key(g.home);
  let m = events.find((e) => has(e.away, A) && has(e.home, H)), flip = false;
  if (!m) { m = events.find((e) => has(e.away, H) && has(e.home, A)); flip = !!m; }
  if (!m) { console.log(`Week ${n}: ${g.away} vs ${g.home} not found on ESPN.`); continue; }
  if (!m.completed || Number.isNaN(m.sa) || Number.isNaN(m.sh)) { console.log(`Week ${n}: ${g.away} vs ${g.home} not final yet.`); continue; }
  g.sa = flip ? m.sh : m.sa; g.sh = flip ? m.sa : m.sh; g.fin = true; saved++;
  console.log(`Week ${n}: ${g.away} ${g.sa} - ${g.sh} ${g.home} (final)`);
}

if (saved) { fs.writeFileSync(FILE, JSON.stringify(data, null, 1)); console.log(`Saved ${saved} final score(s).`); }
else console.log('Nothing new to save.');
