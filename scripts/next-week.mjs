// MLFL next-week robot. GitHub runs this hourly Tuesday to Thursday (see .github/workflows/next-week.yml); it builds the board
// Wednesday from 9 AM Central, or Tuesday from 9 AM in a week with a Wednesday game.
// When the current week is finished and the next week has no games yet, it builds the next week's
// odds board from The Odds API (DraftKings spreads and totals, same as the Commissioner tab button)
// and makes it the current week. If anything is not ready yet it changes nothing and tries again next run.
import fs from 'node:fs';

const FILE = process.argv[2] || 'data.json';
const KEY = (process.env.ODDS_API_KEY || '').trim();
const ROUNDS = ['Wild Card', 'Divisional', 'Conference Championships', 'Super Bowl'];
const HOUR = 3600000;
const now = process.env.MLFL_NOW ? new Date(process.env.MLFL_NOW) : new Date(); // MLFL_NOW is only for testing
const stop = (msg) => { console.log(msg); process.exit(0); };

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const cfg = data.cfg || {}, weeks = data.weeks || (data.weeks = {});
if (cfg.autoWeek === false) stop('Automatic weeks are turned off.');
const cur = Number(cfg.currentWeek);
if (!cur) stop('No current week set.');
if (cur >= 22) stop('The season is over (Super Bowl week is the last one).');

// 0. When: Wednesday from 9 AM Central. In a week whose first game is on Wednesday (like Thanksgiving Eve),
//    it builds on Tuesday from 9 AM instead so players get a full day to pick.
const ct = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
  .formatToParts(now).map((p) => [p.type, p.value]));
const day = ct.weekday, hr = Number(ct.hour);
async function wednesdayGame() {
  // ESPN's free scoreboard for tomorrow's date (Central): any NFL game on it means a Wednesday game.
  const t = new Date(Date.UTC(+ct.year, +ct.month - 1, +ct.day + 1));
  const ymd = t.toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=' + ymd, { headers: { 'User-Agent': 'MLFL-week-robot' } });
    if (!r.ok) return false;
    return ((await r.json()).events || []).length > 0;
  } catch (e) { return false; }
}
if (!['Tue', 'Wed', 'Thu'].includes(day)) stop(`It is ${day}; the robot only builds weeks Tuesday to Thursday.`);
if (day === 'Tue' && hr < 9) stop('Too early on Tuesday.');
if (day === 'Wed' && hr < 9) stop('Waiting for 9 AM Wednesday.');

// 1. Is the current week finished? Every game needs a final score.
//    From Wednesday afternoon, a game that kicked off over 36 hours ago and still has no final
//    (postponed, or ESPN never posted it) no longer holds things up.
const late = (day === 'Wed' && hr >= 14) || day === 'Thu';
const games = Object.values((weeks[cur] && weeks[cur].games) || {});
if (!games.length) stop(`Week ${cur} has no games, so there is nothing to finish.`);
const waiting = games.filter((g) => !(g.fin && g.sa != null && g.sh != null) && !(late && g.kick && now - new Date(g.kick) > 36 * HOUR));
if (waiting.length) stop(`Week ${cur} is not finished yet: ${waiting.map((g) => g.away + ' vs ' + g.home).join(', ')}.`);

// 2. Which week comes next? Weeks 1-18, then the playoff rounds in slots 19-22.
const next = cur + 1;
const round = next >= 19 ? ROUNDS[next - 19] : '';
const label = round || `Week ${next}`;
if (weeks[next] && Object.keys(weeks[next].games || {}).length) stop(`${label} already has games. The commissioner set it up, so nothing to do.`);
if (day === 'Tue' && !(await wednesdayGame())) stop('No game on Wednesday this week, so the board gets built Wednesday at 9 AM.');
if (!KEY) stop('No ODDS_API_KEY secret is set in the repository, so the odds board cannot be built.');

// 3. Get the lines.
let list;
try {
  const url = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=' + encodeURIComponent(KEY) + '&regions=us&markets=spreads,totals&bookmakers=draftkings';
  const res = await fetch(url);
  console.log('Odds API credits left this month:', res.headers.get('x-requests-remaining'));
  if (!res.ok) stop(`The Odds API answered ${res.status}. Trying again next run.`);
  list = await res.json();
} catch (e) { stop('Could not reach The Odds API: ' + e.message); }

// Same rules as parseOdds() on the page: keep games from the first upcoming kickoff through the next Tuesday 1 PM Central.
const mascot = (full) => String(full).trim().split(' ').pop();
const all = (Array.isArray(list) ? list : []).filter((x) => x && x.commence_time && x.home_team && x.away_team && new Date(x.commence_time) > now)
  .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
if (!all.length) stop('The Odds API has no upcoming games yet.');
const first = new Date(all[0].commence_time);
if (first - now > 9 * 24 * HOUR) stop('The next games are more than 9 days away; waiting.');
let d = (9 - first.getUTCDay()) % 7; if (d === 0) d = 7;
const cut = new Date(first); cut.setUTCDate(cut.getUTCDate() + d); cut.setUTCHours(18, 0, 0, 0);
const board = {};
all.filter((x) => new Date(x.commence_time) < cut).forEach((x, i) => {
  let sp = null, tot = null; const bm = x.bookmakers && x.bookmakers[0];
  if (bm) {
    const s = (bm.markets || []).find((m) => m.key === 'spreads'), t = (bm.markets || []).find((m) => m.key === 'totals');
    const ho = s && s.outcomes.find((o) => o.name === x.home_team); if (ho && typeof ho.point === 'number') sp = ho.point;
    const ov = t && t.outcomes.find((o) => o.name === 'Over'); if (ov && typeof ov.point === 'number') tot = ov.point;
  }
  const id = String(x.id || ('g' + i)).replace(/[^A-Za-z0-9]/g, '') || ('g' + i);
  board[id] = { o: i, away: mascot(x.away_team), home: mascot(x.home_team), awayFull: x.away_team, homeFull: x.home_team, apiId: x.id || '', kick: new Date(x.commence_time).toISOString(), sp, tot, sa: null, sh: null, fin: false };
});
const ids = Object.keys(board);

// 4. Sanity checks. Lines can be missing early in the week; wait for them unless it is getting late.
const noLine = ids.filter((id) => board[id].sp == null || board[id].tot == null);
if (noLine.length && !late) stop(`${noLine.length} game(s) have no line yet; trying again next run.`);
if (!round && ids.length < 10) stop(`Only ${ids.length} games found for ${label}; waiting for the full slate.`);

// 5. Save the new week and make it current.
weeks[next] = Object.assign({}, weeks[next] || {}, { n: next, open: true, round, games: board });
cfg.currentWeek = next;
data.cfg = cfg;
fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
console.log(`${label} is set up with ${ids.length} games and is now the current week.`);
for (const id of ids) { const g = board[id]; console.log(`  ${g.away} @ ${g.home}  ${g.sp ?? '-'} / ${g.tot ?? '-'}  ${g.kick}`); }
