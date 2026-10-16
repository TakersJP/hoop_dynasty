// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
const UNITS = ['starters', 'bench'];
const UNIT_LABELS = { starters: 'Starting five', bench: 'Second unit' };
const ROSTER_SIZE = SLOTS.length * UNITS.length;
const RESPINS_PER_UNIT = 1;    // each respin button can be used once per unit
const QUALIFY_GAMES = 20;      // players with fewer games for the team sort after everyone else
// Projected record: each player's production is points + rebounds + assists
// per game (steals and blocks weren't recorded before 1973-74, so they're left
// out to keep eras comparable). Team production weights the starters' average
// over the second unit's.
const BENCH_WEIGHT = 0.25;
// Wins curve: a typical draft projects near .500; 82-0 takes production
// beyond what drafting the top scorer on random pulls reaches.
const WINS_MIDPOINT = 34.0;
const WINS_SPREAD = 1.48;
const SAVE_KEY = 'hoop-dynasty-draft-v5';
// Same format, saved under the game's earlier names
const OLD_SAVE_KEYS = ['nba-dynasty-draft-v5', '82and0-draft-v5'];

const SORTS = { ppg: 'PPG', rpg: 'RPG', apg: 'APG', spg: 'SPG', bpg: 'BPG' };

const ERA_COLORS = {
  '1960s': '#c9a227', '1970s': '#e2603b', '1980s': '#d9468f', '1990s': '#8a5cf6',
  '2000s': '#2f8fe0', '2010s': '#20b2a0', '2020s': '#7cc443',
};

// Slot machine timing (ms). The era reel stops first, then the team reel.
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ERA_SPIN_MS = REDUCED_MOTION ? 300 : 2200;
const TEAM_SPIN_MS = REDUCED_MOTION ? 500 : 3300;

function emptyUnit() {
  return Object.fromEntries(SLOTS.map(s => [s, null]));
}

function freshRespins() {
  return Object.fromEntries(UNITS.map(u => [u, { era: RESPINS_PER_UNIT, team: RESPINS_PER_UNIT }]));
}

const state = {
  screen: 'start',         // start | game (not saved: every visit opens on the start screen)
  phase: 'load',           // load (era reel) | ready | spinning | pick | done
  pool: Object.fromEntries(ERAS.map(e => [e, 0])), // era -> 1 if selected for the draft, else 0
  era: null,
  team: null,
  respins: freshRespins(), // unit -> { era, team } respins left
  posFilter: 'ALL',        // pick-list position filter (not saved)
  sortKey: 'ppg',          // pick-list sort (not saved)
  roster: { starters: emptyUnit(), bench: emptyUnit() }, // unit -> slot -> { id, name, pos, years, team, era, ppg, rpg, apg, spg, bpg }
};

function rosterEntries() {
  return UNITS.flatMap(u => SLOTS.map(s => state.roster[u][s]).filter(Boolean));
}

function filledCount() {
  return rosterEntries().length;
}

function openSlots(unit) {
  return SLOTS.filter(s => !state.roster[unit][s]);
}

// Picks fill the starting five first, then the second unit.
function currentUnit() {
  return openSlots('starters').length ? 'starters' : 'bench';
}

// Open slots in the current unit at the player's own positions.
function draftSlots(player) {
  const open = openSlots(currentUnit());
  return player.pos.filter(p => open.includes(p));
}

function production(p) {
  return (p.ppg || 0) + (p.rpg || 0) + (p.apg || 0);
}

// Average points + rebounds + assists per game across a unit's filled slots.
function unitProduction(unit) {
  const filled = SLOTS.filter(s => state.roster[unit][s]);
  if (!filled.length) return null;
  return filled.reduce((sum, s) => sum + production(state.roster[unit][s]), 0) / filled.length;
}

function statLine(p) {
  return `${statText(p.ppg)} PTS · ${statText(p.rpg)} REB · ${statText(p.apg)} AST`;
}

// ---------------------------------------------------------------------------
// Save / restore. A pull's result (era + team) and spent respins are saved the
// moment the pull starts, so refreshing can't reroll it or refund a respin.
// ---------------------------------------------------------------------------
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      phase: state.phase === 'spinning' ? 'pick' : state.phase,
      pool: state.pool, era: state.era, team: state.team,
      respins: state.respins, roster: state.roster,
    }));
  } catch (e) { /* storage unavailable: play without saving */ }
}

function restore() {
  try {
    const saved = JSON.parse([SAVE_KEY, ...OLD_SAVE_KEYS].map(k => localStorage.getItem(k)).find(Boolean) || 'null');
    if (!saved || !saved.roster || !saved.pool) return;
    if (saved.phase === 'pick' && !(DATA[saved.era] && DATA[saved.era][saved.team])) return;
    // Each era is in or out (older saves could load an era several times).
    for (const e of ERAS) state.pool[e] = saved.pool[e] > 0 ? 1 : 0;
    for (const u of UNITS) for (const s of SLOTS) {
      const entry = (saved.roster[u] && saved.roster[u][s]) || null;
      // Take positions from the current data so rule changes reach drafted players.
      const fresh = entry && DATA[entry.era] && DATA[entry.era][entry.team]
        && DATA[entry.era][entry.team].find(p => p.id === entry.id);
      state.roster[u][s] = entry && fresh ? { ...entry, pos: fresh.pos } : entry;
    }
    for (const u of UNITS) for (const k of ['era', 'team']) {
      const left = saved.respins && saved.respins[u] && saved.respins[u][k];
      state.respins[u][k] = Math.min(RESPINS_PER_UNIT, Math.max(0, left | 0));
    }
    state.era = saved.era;
    state.team = saved.team;
    // Saves from before the start/load screens used 'build' for "ready to pull".
    const phase = saved.phase === 'build' ? (totalSlots() ? 'ready' : 'load') : saved.phase;
    state.phase = ['load', 'ready', 'pick', 'done'].includes(phase) ? phase : 'load';
  } catch (e) { /* corrupt or unavailable save: start fresh */ }
}

function hasProgress() {
  return state.phase !== 'load' || totalSlots() > 0 || filledCount() > 0;
}

// New draft: clear everything and go to the era reel.
function resetDraft() {
  state.roster = { starters: emptyUnit(), bench: emptyUnit() };
  ERAS.forEach(e => state.pool[e] = 0);
  state.era = state.team = null;
  state.respins = freshRespins();
  state.phase = 'load';
  state.screen = 'game';
  render();
  window.scrollTo({ top: 0 });
}

const $ = sel => document.querySelector(sel);
const main = $('#main');

function totalSlots() {
  return ERAS.reduce((n, e) => n + state.pool[e], 0);
}

// The era reel: one symbol per selected era, so each is equally likely.
function buildSlots() {
  return ERAS.filter(e => state.pool[e]);
}

// ---------------------------------------------------------------------------
// Roster: two units of PG–C. A player stays in the unit they were drafted to
// and can only occupy one of their own positions. Moving onto a filled slot
// swaps the two players, so it's allowed only if the other player can also
// play the slot being vacated. Moves are allowed any time except mid-pull.
// ---------------------------------------------------------------------------
function canMove(unit, fromSlot, toSlot) {
  const p = state.roster[unit][fromSlot];
  const other = state.roster[unit][toSlot];
  return p.pos.includes(toSlot) && (!other || other.pos.includes(fromSlot));
}

function movePlayer(unit, fromSlot, toSlot) {
  if (!canMove(unit, fromSlot, toSlot)) return;
  const a = state.roster[unit][fromSlot];
  state.roster[unit][fromSlot] = state.roster[unit][toSlot];
  state.roster[unit][toSlot] = a;
  render();
}

function moveButton(unit, slot, toSlot) {
  const other = state.roster[unit][toSlot];
  const ok = state.phase !== 'spinning' && canMove(unit, slot, toSlot);
  const title = ok ? `Move to ${toSlot}${other ? ` (swap with ${other.name})` : ''}`
    : other ? `${other.name} can't play ${slot}` : '';
  return `<button class="chip natural" data-move="${unit}|${slot}|${toSlot}" ${ok ? '' : 'disabled'} title="${title}">${toSlot}</button>`;
}

function renderRoster() {
  const n = filledCount();
  const done = n >= ROSTER_SIZE;
  $('#roundTag').textContent = done ? 'Draft complete' : `Round ${n + 1} of ${ROSTER_SIZE} · ${UNIT_LABELS[currentUnit()]}`;
  $('#roster').innerHTML = UNITS.map(unit => {
    const prod = unitProduction(unit);
    const drafting = !done && currentUnit() === unit;
    return `<section class="unit ${drafting ? 'drafting' : ''}">
      <div class="unit-head"><h3>${UNIT_LABELS[unit]}</h3>${drafting ? '<span class="now">Drafting</span>' : ''}${prod === null ? '' : `<span>${prod.toFixed(1)} PTS+REB+AST per player</span>`}</div>
      <div class="roster-row">
        ${SLOTS.map(slot => {
          const p = state.roster[unit][slot];
          if (!p) return `<div class="slot"><div class="n">${slot}</div></div>`;
          return `<div class="slot filled">
            <div class="n">${slot}</div>
            <div class="p">${p.name}</div>
            <div class="t">${p.team} · ${p.era}</div>
            <div class="line">${statLine(p)}</div>
            <div class="move">
              ${p.pos.length > 1
                ? p.pos.map(s => s === slot ? `<span class="chip here">${s}</span>` : moveButton(unit, slot, s)).join('')
                : `<span class="only">${slot} only</span>`}
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>`;
  }).join('');
  $('#roster').querySelectorAll('[data-move]').forEach(b => b.onclick = () => movePlayer(...b.dataset.move.split('|')));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// Screens, in order: start → load the era reel (once per draft) → slot machine
// (pull, pick, repeat) → final record. The roster appears from the slot
// machine on.
function render() {
  save();
  const atMachine = state.screen === 'game' && state.phase !== 'load';
  $('#roster').hidden = !atMachine;
  $('#headerRight').hidden = !atMachine;
  if (atMachine) renderRoster();
  if (state.screen === 'start') return renderStart();
  if (state.phase === 'load') return renderLoad();
  if (state.phase === 'done') return renderFinal();
  renderMachine();
}

function renderStart() {
  const resume = hasProgress();
  main.innerHTML = `
    <div class="card start">
      <p class="tagline">Draft a ten-man roster from 65 years of NBA history and chase an 82–0 season.</p>
      <ol class="steps">
        <li><b>Load the era reel</b> — pick which decades can come up in your draft.</li>
        <li><b>Pull the slot machine</b> — it lands on an era and a team.</li>
        <li><b>Draft a player</b> from that team's roster, by their real stats. Repeat for your starting five, then your bench.</li>
      </ol>
      <div class="start-actions">
        ${resume
          ? `<button class="btn-primary" id="continueBtn">Continue draft</button>
             <button class="btn-ghost" id="startBtn">Start a new game</button>`
          : '<button class="btn-primary" id="startBtn">Start game</button>'}
      </div>
    </div>`;
  if (resume) $('#continueBtn').onclick = () => { state.screen = 'game'; render(); };
  $('#startBtn').onclick = () => {
    if (!resume || confirm('Start a new game? Your saved draft will be cleared.')) resetDraft();
  };
}

// Each checked era goes on the reel once, so every picked era is equally likely.
function renderLoad() {
  const total = totalSlots();
  main.innerHTML = `
    <div class="card solo">
      <h2>Load the era reel</h2>
      <p class="hint">Check the eras you want in your draft. Each one is equally likely to come up, and this reel is used for your whole draft.</p>
      <div class="era-picks">
        ${ERAS.map(e => `<label class="era-pick" style="--c:${ERA_COLORS[e]}">
            <input type="checkbox" data-era="${e}" ${state.pool[e] ? 'checked' : ''}>
            <span class="swatch" style="background:${ERA_COLORS[e]}"></span>
            <span class="era-name">${e}</span>
          </label>`).join('')}
      </div>
      <div class="total">
        <span>${total ? `${total} era${total === 1 ? '' : 's'} selected` : 'No eras selected'}</span>
        <span class="bulk">
          <button class="btn-ghost" id="allBtn" ${total === ERAS.length ? 'disabled' : ''}>Select all</button>
          <button class="btn-ghost" id="clearBtn" ${!total ? 'disabled' : ''}>Clear</button>
        </span>
      </div>
      <button class="btn-primary" id="toMachineBtn" ${!total ? 'disabled' : ''}>Continue to slot machine</button>
    </div>`;

  main.querySelectorAll('[data-era]').forEach(box => box.onchange = () => {
    state.pool[box.dataset.era] = box.checked ? 1 : 0;
    render();
    main.querySelector(`[data-era="${box.dataset.era}"]`).focus(); // keep keyboard focus after re-render
  });
  $('#allBtn').onclick = () => { ERAS.forEach(e => state.pool[e] = 1); render(); };
  $('#clearBtn').onclick = () => { ERAS.forEach(e => state.pool[e] = 0); render(); };
  $('#toMachineBtn').onclick = () => {
    if (!totalSlots()) return;
    state.phase = 'ready';
    render();
    window.scrollTo({ top: 0 });
  };
}

function renderMachine() {
  const eras = ERAS.filter(e => state.pool[e]).join(' · ');
  main.innerHTML = `
    <div class="card machine-card solo">
      ${machineHTML()}
      <p class="hint reel-odds">Your eras: ${eras}</p>
    </div>
    <div class="players card" id="players" ${state.phase === 'pick' ? '' : 'hidden'}>${playersHTML()}</div>`;
  bindMachine();
  bindPlayers();
}

// ---------------------------------------------------------------------------
// Slot machine: an era reel and a team reel behind a payline. Each reel is a
// vertical strip of symbols; it stops with the chosen symbol on the payline.
// ---------------------------------------------------------------------------
function eraSymbol(era) {
  return `<div class="sym"><span class="era-pill" style="--c:${ERA_COLORS[era]}">${era}</span></div>`;
}

function teamSymbol(team) {
  return `<div class="sym team-sym">${team}</div>`;
}

function idleEraSymbols() {
  const slots = buildSlots();
  return slots.length ? slots.map(eraSymbol) : ['<div class="sym empty-sym">—</div>'];
}

// Fill a reel strip and park symbol `index` on the payline (middle row).
function setStrip(strip, symbols, index) {
  strip.style.transition = 'none';
  strip.innerHTML = symbols.join('');
  strip.style.setProperty('--at', index);
}

// Why a respin is unavailable, or '' if it can be used now.
function respinBlocker(kind) {
  if (!state.respins[currentUnit()][kind]) return `Used for the ${UNIT_LABELS[currentUnit()].toLowerCase()}`;
  if (kind === 'era') {
    const others = buildSlots().filter(e => e !== state.era);
    if (!others.length) return 'Only one era in your draft';
    if (!others.some(e => DATA[e][state.team])) return `${state.team} didn't play in your other eras`;
  }
  return '';
}

function respinButton(kind) {
  const blocker = respinBlocker(kind);
  const left = state.respins[currentUnit()][kind];
  return `<button class="btn-respin" id="respin-${kind}" ${blocker ? 'disabled' : ''}>
      ↻ Respin ${kind}
      <span>${blocker || `${left} left for the ${UNIT_LABELS[currentUnit()].toLowerCase()}`}</span>
    </button>`;
}

function machineHTML() {
  const pulled = state.phase === 'pick';
  const total = totalSlots();
  return `<div class="machine ${pulled ? 'win' : ''}" id="machine">
      <div class="marquee"><span class="bulbs"></span>Hoop Dynasty<span class="bulbs"></span></div>
      <div class="reels">
        <div class="reel reel-era"><div class="strip" id="eraStrip"></div></div>
        <div class="reel reel-team"><div class="strip" id="teamStrip"></div></div>
        <div class="payline" aria-hidden="true"></div>
      </div>
    </div>
    <div class="result" id="result" aria-live="polite">
      ${pulled ? `<div class="era">${state.era}</div><div class="team">${state.team}</div>` : ''}
    </div>
    ${pulled
      ? `<div class="respins">${respinButton('era')}${respinButton('team')}</div>
         <p class="hint respin-note">A new era keeps the team (only eras it played in). A new team keeps the era.</p>`
      : `<button class="btn-primary" id="pullBtn" ${state.phase !== 'ready' || !total ? 'disabled' : ''}>Pull</button>`}`;
}

function bindMachine() {
  if (state.phase === 'pick') {
    setStrip($('#eraStrip'), [eraSymbol(state.era)], 0);
    setStrip($('#teamStrip'), [teamSymbol(state.team)], 0);
  } else {
    setStrip($('#eraStrip'), idleEraSymbols(), 0);
    setStrip($('#teamStrip'), ['<div class="sym empty-sym">?</div>'], 0);
  }
  if ($('#pullBtn')) $('#pullBtn').onclick = () => pull('new');
  if ($('#respin-era')) $('#respin-era').onclick = () => respin('era');
  if ($('#respin-team')) $('#respin-team').onclick = () => respin('team');
}

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function spinStrip(strip, symbols, stop, ms) {
  setStrip(strip, symbols, 0);
  strip.getBoundingClientRect(); // commit the start position before animating
  strip.style.transition = `transform ${ms}ms cubic-bezier(.15,.75,.2,1)`;
  strip.style.setProperty('--at', stop);
}

// mode 'new': fresh pull of both reels.
// mode 'era': same team, new era (never the current one, and only eras the
//             team played in). Only the era reel spins.
// mode 'team': same era, new team (never the current one). Only the team reel spins.
// The era is picked uniformly from the selected eras (among those still
// eligible); the spinning reels are then animated onto exactly the picked results.
function pull(mode) {
  const slots = buildSlots();
  const spinEra = mode !== 'team';
  const spinTeam = mode !== 'era';
  let eraIndex = 0;
  if (spinEra) {
    const eligible = slots.map((e, i) => i).filter(i => mode === 'new'
      || (slots[i] !== state.era && DATA[slots[i]][state.team]));
    eraIndex = randomItem(eligible);
    state.era = slots[eraIndex];
  }
  if (spinTeam) {
    const teams = Object.keys(DATA[state.era]).filter(t => mode !== 'team' || t !== state.team);
    state.team = randomItem(teams);
  }
  state.posFilter = 'ALL';
  state.sortKey = 'ppg';
  state.phase = 'spinning';
  render();

  if (spinEra) {
    // Several loops of the era strip, landing on the picked symbol.
    const loops = Math.max(4, Math.ceil(30 / slots.length));
    const symbols = Array.from({ length: loops + 1 }, () => slots).flat().map(eraSymbol);
    spinStrip($('#eraStrip'), symbols, loops * slots.length + eraIndex, ERA_SPIN_MS);
  } else {
    setStrip($('#eraStrip'), [eraSymbol(state.era)], 0);
  }
  // Team reel: teams from every era blur past, ending on the picked team.
  let doneMs = ERA_SPIN_MS;
  if (spinTeam) {
    const allTeams = [...new Set(ERAS.flatMap(e => Object.keys(DATA[e])))];
    const teamSymbols = [...shuffled(allTeams).slice(0, 28), state.team, ...shuffled(allTeams).slice(0, 2)].map(teamSymbol);
    doneMs = spinEra ? TEAM_SPIN_MS : ERA_SPIN_MS;
    spinStrip($('#teamStrip'), teamSymbols, 28, doneMs);
  } else {
    setStrip($('#teamStrip'), [teamSymbol(state.team)], 0);
  }

  if (matchMedia('(max-width: 820px)').matches) {
    $('#machine').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  setTimeout(() => {
    state.phase = 'pick';
    render();
    $('#players').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, doneMs + 150);
}

function respin(kind) {
  if (respinBlocker(kind)) return;
  state.respins[currentUnit()][kind]--;
  pull(kind);
}

// ---------------------------------------------------------------------------
// Player list: everyone who played for the franchise that decade, sortable by
// per-game stats (highest first), filterable by position.
// ---------------------------------------------------------------------------
function bindPlayers() {
  main.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    state.posFilter = b.dataset.filter;
    refreshPlayers();
  });
  main.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
    state.sortKey = b.dataset.sort;
    refreshPlayers();
  });
  main.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => pickPlayer(+b.dataset.pick, b.dataset.slot));
}

function refreshPlayers() {
  $('#players').innerHTML = playersHTML();
  bindPlayers();
}

function statText(v) {
  return v === null ? '—' : v.toFixed(1);
}

function playersHTML() {
  if (state.phase !== 'pick') return '';
  const taken = new Set(rosterEntries().map(p => p.id));
  const players = DATA[state.era][state.team];
  const unit = currentUnit();
  const open = openSlots(unit);
  const key = state.sortKey;
  const shown = players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => state.posFilter === 'ALL' || p.pos.includes(state.posFilter))
    // Highest first. Players under QUALIFY_GAMES with the team come after everyone
    // else (like Basketball-Reference's leaderboard minimums), and players without
    // the stat (pre-1973 steals/blocks) go last.
    .sort((a, b) => ((b.p.games >= QUALIFY_GAMES) - (a.p.games >= QUALIFY_GAMES))
      || ((b.p[key] ?? -1) - (a.p[key] ?? -1)) || (b.p.games - a.p.games));
  return `<div class="players-head">
      <h2>Choose a player — ${state.team}, ${state.era}</h2>
    </div>
    <div class="list-controls">
      <div class="filters" role="group" aria-label="Sort by">
        <span class="label">Sort</span>
        ${Object.entries(SORTS).map(([k, label]) => `<button class="chip ${key === k ? 'here' : ''}" data-sort="${k}">${label}</button>`).join('')}
      </div>
      <div class="filters" role="group" aria-label="Filter by position">
        <span class="label">Position</span>
        ${['ALL', ...SLOTS].map(f => `<button class="chip ${state.posFilter === f ? 'here' : ''} ${open.includes(f) ? 'natural' : ''}" data-filter="${f}">${f === 'ALL' ? 'All' : f}</button>`).join('')}
      </div>
    </div>
    <p class="hint">Drafting the <b>${UNIT_LABELS[unit].toLowerCase()}</b> — open spots: ${open.join(', ')}.
      ${players.length} players appeared for this franchise in the ${state.era}; stats are per-game averages with this team that decade (Basketball-Reference).
      Players with fewer than ${QUALIFY_GAMES} games for the team are listed after the rest.</p>
    <div class="player-grid">
      ${shown.map(({ p, i }) => {
        const isTaken = taken.has(p.id);
        const slots = draftSlots(p);
        return `<div class="player ${isTaken || !slots.length ? 'is-taken' : ''}">
          <div class="player-head">
            <span>
              <span class="pname">${p.name}</span>
              <span class="ppos">${p.pos.join(' / ')} · ${p.years} · ${p.games} G</span>
            </span>
          </div>
          <div class="stats">
            ${STAT_KEYS.map(k => `<span class="${key === k ? 'sorted' : ''}"><b>${statText(p[k])}</b>${SORTS[k]}</span>`).join('')}
          </div>
          ${isTaken ? '<span class="taken">Already on your roster</span>'
            : slots.length ? `<div class="place">${slots.map(slot => `<button class="natural" data-pick="${i}" data-slot="${slot}"
                aria-label="Draft ${p.name} at ${slot}">Draft · ${slot}</button>`).join('')}</div>`
            : `<span class="taken">No open ${p.pos.join('/')} spot</span>`}
        </div>`;
      }).join('') || '<p class="hint">No players at this position.</p>'}
    </div>`;
}

function pickPlayer(i, slot) {
  const p = DATA[state.era][state.team][i];
  if (!draftSlots(p).includes(slot)) return; // only an open slot at one of the player's positions
  state.roster[currentUnit()][slot] = {
    id: p.id, name: p.name, pos: p.pos, years: p.years, team: state.team, era: state.era,
    ...Object.fromEntries(STAT_KEYS.map(k => [k, p[k]])),
  };
  state.era = state.team = null;
  state.phase = filledCount() >= ROSTER_SIZE ? 'done' : 'ready';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Final result: project a regular-season record from the lineup's production
// (points + rebounds + assists per game), weighting starters over the bench.
// ---------------------------------------------------------------------------
function renderFinal() {
  const starters = unitProduction('starters');
  const bench = unitProduction('bench');
  const team = starters * (1 - BENCH_WEIGHT) + bench * BENCH_WEIGHT;
  const wins = Math.round(82 / (1 + Math.exp(-(team - WINS_MIDPOINT) / WINS_SPREAD)));
  const perfect = wins === 82;
  main.innerHTML = `
    <div class="card final">
      <h2>Projected record</h2>
      <div class="record ${perfect ? 'perfect' : ''}">${wins}–${82 - wins}</div>
      <div class="sub">PTS + REB + AST per player: starters ${starters.toFixed(1)} · bench ${bench.toFixed(1)}${perfect ? ' · A perfect season.' : ''}</div>
      <p class="hint">Move multi-position players between their positions above — the record updates as you go.</p>
      <button class="btn-primary" id="againBtn" style="max-width:320px">Draft again</button>
    </div>`;
  $('#againBtn').onclick = resetDraft;
}

$('#newBtn').onclick = () => {
  if (confirm('Start a new draft? Your current picks and era reel will be cleared.')) resetDraft();
};
restore();
render();
