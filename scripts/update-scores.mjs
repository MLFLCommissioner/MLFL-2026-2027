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

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// Games that started in the last 7 days and are not final yet (a week covers Thursday through Monday, with room to catch up).
const targets = [];
// Games kicking off in the next 5 days: keep their current betting line (from ESPN) so the projection
// on the site can compare it with the board's line. Once a game kicks off its line is never touched again.
const upcoming = [];
for (const [n, w] of Object.entries(data.weeks || {})) {
  for (const [gid, g] of Object.entries(w.games || {})) {
    if (g.fin || !g.kick) continue;
    const k = Date.parse(g.kick);
    if (now >= k && now <= k + 7 * DAY) targets.push({ n, gid, g, k });
    else if (now < k && k - now <= 5 * DAY) upcoming.push({ n, gid, g, k });
  }
}
// Futures results: once the conference championships are final, the winners are the AFC and NFC champions;
// once the Super Bowl is final, its winner is the champion. A result the commissioner already entered is never changed.
const AFC = ['Bills','Dolphins','Patriots','Jets','Ravens','Bengals','Browns','Steelers','Texans','Colts','Jaguars','Titans','Broncos','Chiefs','Raiders','Chargers'];
function setFutures() {
  let futs = 0;
  const cfg = data.cfg || (data.cfg = {}), fr = cfg.futuresResult || (cfg.futuresResult = {});
  const winner = (g) => (g && g.fin && g.sa != null && g.sh != null && g.sa !== g.sh) ? (g.sa > g.sh ? g.away : g.home) : null;
  const round = (name) => Object.values(data.weeks || {}).find((w) => w && w.round === name);
  const conf = round('Conference Championships'), sbw = round('Super Bowl');
  for (const g of Object.values((conf && conf.games) || {})) {
    const w = winner(g); if (!w) continue;
    const k = AFC.includes(w) ? 'afc' : 'nfc';
    if (!fr[k]) { fr[k] = w; futs++; console.log(`${k.toUpperCase()} champion: ${w}`); }
  }
  for (const g of Object.values((sbw && sbw.games) || {})) {
    const w = winner(g); if (w && !fr.sb) { fr.sb = w; futs++; console.log(`Super Bowl champion: ${w}`); }
  }
  return futs;
}

if (!targets.length && !upcoming.length) {
  if (setFutures()) fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
  console.log('No games waiting for a final score, and none kicking off soon.'); process.exit(0);
}

const has = (arr, k) => arr.some((x) => x === k || x.endsWith(k));
const etDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)).replace(/-/g, '');
const parse = (json) => (json.events || []).map((ev) => {
  const c = (ev.competitions || [])[0] || {}, st = ((c.status || ev.status || {}).type) || {}, cs = c.competitors || [];
  const side = (h) => cs.find((x) => x.homeAway === h) || {};
  const names = (x) => { const t = x.team || {}; return [t.name, t.shortDisplayName, t.displayName].filter(Boolean).map(key); };
  const a = side('away'), h = side('home');
  // Betting line: "details" reads like "LAR -3.5" (the favorite and its spread) or "EVEN"; we keep the home team's spread.
  let mk = null; const od = (c.odds || [])[0];
  if (od) {
    const ab = (x) => String((x.team && x.team.abbreviation) || '').toUpperCase(), d = String(od.details || '').trim();
    let sp = null; const m = d.match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/);
    if (/^even$|^pk$|pick/i.test(d)) sp = 0;
    else if (m) { const v = Number(m[2]); sp = m[1] === ab(h) ? v : m[1] === ab(a) ? -v : null; }
    const tot = typeof od.overUnder === 'number' ? od.overUnder : null;
    if (sp != null || tot != null) mk = { sp, tot };
  }
  return { away: names(a), home: names(h), sa: parseInt(a.score, 10), sh: parseInt(h.score, 10), completed: !!st.completed, mk };
});
let events = [];
// ESPN turns away requests that do not look like a web browser (error 403), so ask like one,
// and try ESPN's other scoreboard addresses if the first says no.
const HOSTS = [ESPN, 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', 'https://cdn.espn.com/core/nfl/scoreboard'];
const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.espn.com/nfl/scoreboard',
  'Origin': 'https://www.espn.com',
};
async function grab(q) {
  for (const host of HOSTS) {
    const url = host + (host.includes('cdn.espn.com') ? (q ? q + '&' : '?') + 'xhr=1' : q);
    try {
      const res = await fetch(url, { headers: HDRS });
      if (!res.ok) { console.log(`ESPN (${new URL(host).host}) answered ${res.status} for "${q || 'this week'}".`); continue; }
      let json = await res.json();
      if (json && json.content && json.content.sbData) json = json.content.sbData; // cdn.espn.com wraps the same data
      const got = parse(json);
      if (got.length || !q) { events = events.concat(got); return; }
    } catch (e) { console.log(`Could not reach ESPN (${new URL(host).host}) for "${q || 'this week'}": ${e.message}`); }
  }
}
const found = (g) => { const A = key(g.away), H = key(g.home); return events.some((e) => (has(e.away, A) && has(e.home, H)) || (has(e.away, H) && has(e.home, A))); };
// This week's scoreboard first; then single game days for anything not on it.
await grab('');
for (const d of [...new Set(targets.concat(upcoming).filter((t) => !found(t.g)).map((t) => etDay(t.g.kick)))]) await grab(`?dates=${d}`);
// Backup: if ESPN gave nothing, ask The Odds API's scores feed (last 3 days), at most once an hour to save credits.
const OKEY = (process.env.ODDS_API_KEY || '').trim();
if (!events.length && OKEY && (process.env.FORCE_ODDS || new Date().getUTCMinutes() < 10)) {
  try {
    const res = await fetch('https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores/?daysFrom=3&apiKey=' + encodeURIComponent(OKEY));
    if (res.ok) {
      const list = await res.json();
      events = list.filter((x) => x.completed && Array.isArray(x.scores)).map((x) => {
        const sc = (t) => parseInt(((x.scores.find((s) => s.name === t) || {}).score), 10);
        return { away: [key(x.away_team)], home: [key(x.home_team)], sa: sc(x.away_team), sh: sc(x.home_team), completed: true };
      });
      console.log(`Used The Odds API scores instead: ${events.length} finished games. Credits left: ${res.headers.get('x-requests-remaining')}`);
    } else console.log(`The Odds API answered ${res.status}.`);
  } catch (e) { console.log('Could not reach The Odds API: ' + e.message); }
}
if (!events.length) { console.log('No scoreboard data; trying again next run.'); process.exit(0); }

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

let lines = 0;
for (const { n, g } of upcoming) {
  const A = key(g.away), H = key(g.home);
  let m = events.find((e) => has(e.away, A) && has(e.home, H)), flip = false;
  if (!m) { m = events.find((e) => has(e.away, H) && has(e.home, A)); flip = !!m; }
  if (!m || !m.mk) continue;
  const sp = m.mk.sp == null ? null : (flip ? -m.mk.sp : m.mk.sp), tot = m.mk.tot;
  const old = g.mk || {};
  if (old.sp === sp && old.tot === tot) continue;
  g.mk = { sp, tot, at: new Date(now).toISOString() }; lines++;
  console.log(`Week ${n}: ${g.away} @ ${g.home} line now ${sp ?? '-'} / ${tot ?? '-'} (board ${g.sp ?? '-'} / ${g.tot ?? '-'})`);
}

const futs = setFutures();

if (saved || lines || futs) { fs.writeFileSync(FILE, JSON.stringify(data, null, 1)); console.log(`Saved ${saved} final score(s), ${lines} line update(s) and ${futs} futures result(s).`); }
else console.log('Nothing new to save.');
