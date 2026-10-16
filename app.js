// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
const UNITS = ['starters', 'bench'];
const UNIT_LABELS = { starters: 'Starting five', bench: 'Second unit' };
const ROSTER_SIZE = SLOTS.length * UNITS.length;
const MAX_PER_ERA = 10;
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
const SAVE_KEY = 'nba-dynasty-draft-v5';
const OLD_SAVE_KEY = '82and0-draft-v5'; // same format, saved before the rename

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
  phase: 'build',          // build | spinning | pick | done
  pool: Object.fromEntries(ERAS.map(e => [e, 0])),
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
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || localStorage.getItem(OLD_SAVE_KEY));
    if (!saved || !saved.roster || !saved.pool) return;
    if (saved.phase === 'pick' && !(DATA[saved.era] && DATA[saved.era][saved.team])) return;
    for (const e of ERAS) state.pool[e] = Math.min(MAX_PER_ERA, Math.max(0, saved.pool[e] | 0));
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
    state.phase = ['build', 'pick', 'done'].includes(saved.phase) ? saved.phase : 'build';
  } catch (e) { /* corrupt or unavailable save: start fresh */ }
}

function resetDraft() {
  state.roster = { starters: emptyUnit(), bench: emptyUnit() };
  ERAS.forEach(e => state.pool[e] = 0);
  state.era = state.team = null;
  state.respins = freshRespins();
  state.phase = 'build';
  render();
}

const $ = sel => document.querySelector(sel);
const main = $('#main');

function totalSlots() {
  return ERAS.reduce((n, e) => n + state.pool[e], 0);
}

// Expand the pool into reel symbols. Smooth weighted round-robin keeps
// duplicate selections as separate symbols, interleaved with other eras.
function buildSlots() {
  const total = totalSlots();
  const credit = Object.fromEntries(ERAS.map(e => [e, 0]));
  const slots = [];
  for (let i = 0; i < total; i++) {
    let best = null;
    for (const e of ERAS) {
      credit[e] += state.pool[e];
      if (state.pool[e] && (best === null || credit[e] > credit[best])) best = e;
    }
    credit[best] -= total;
    slots.push(best);
  }
  return slots;
}

function pct(n, total) {
  return total ? Math.round((n / total) * 100) : 0;
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
  $('#newBtn').hidden = n === 0 && state.phase === 'build' && !totalSlots();
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
function render() {
  save();
  renderRoster();
  if (state.phase === 'done') return renderFinal();

  const locked = state.phase !== 'build';
  const total = totalSlots();

  main.innerHTML = `
    <div class="stage">
      <div class="card">
        <h2>Load the era reel</h2>
        <p class="hint">Each selection adds one symbol to the era reel. Add an era more than once to raise its odds.</p>
        <div class="add-row">
          ${ERAS.map(e => `<button data-add="${e}" ${locked || state.pool[e] >= MAX_PER_ERA ? 'disabled' : ''}>${e.slice(2)} +</button>`).join('')}
        </div>
        <div class="era-list">
          ${ERAS.map(e => {
            const n = state.pool[e];
            const p = pct(n, total);
            return `<div class="era-row" data-era="${e}">
              <span class="swatch" style="background:${ERA_COLORS[e]}"></span>
              <span class="era-name">${e}</span>
              <span class="stepper">
                <button data-sub="${e}" ${locked || !n ? 'disabled' : ''} aria-label="Remove ${e}">−</button>
                <span class="count ${n ? 'on' : ''}">×${n}</span>
                <button data-add="${e}" ${locked || n >= MAX_PER_ERA ? 'disabled' : ''} aria-label="Add ${e}">+</button>
              </span>
              <input type="range" class="slider" data-slide="${e}" min="0" max="${MAX_PER_ERA}" step="1" value="${n}"
                style="--c:${ERA_COLORS[e]};--fill:${(n / MAX_PER_ERA) * 100}%" ${locked ? 'disabled' : ''} aria-label="${e} symbols">
              <span class="pct ${n ? '' : 'zero'}">${p}%</span>
            </div>`;
          }).join('')}
        </div>
        <div class="total">
          <span>${total} symbol${total === 1 ? '' : 's'} on the era reel</span>
          <button class="btn-ghost" id="clearBtn" ${locked || !total ? 'disabled' : ''}>Clear all</button>
        </div>
      </div>

      <div class="card machine-card">
        ${machineHTML()}
      </div>
    </div>
    <div class="players card" id="players" ${state.phase === 'pick' ? '' : 'hidden'}>${playersHTML()}</div>
  `;

  main.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    state.pool[b.dataset.add] = Math.min(MAX_PER_ERA, state.pool[b.dataset.add] + 1);
    render();
  });
  // While dragging, update the builder in place (a full render would replace
  // the slider mid-drag); re-render once the drag is released.
  main.querySelectorAll('[data-slide]').forEach(r => {
    r.oninput = () => { state.pool[r.dataset.slide] = +r.value; updateBuilder(); };
    r.onchange = () => {
      render();
      main.querySelector(`[data-slide="${r.dataset.slide}"]`).focus(); // keep keyboard control
    };
  });
  main.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { state.pool[b.dataset.sub]--; render(); });
  $('#clearBtn').onclick = () => { ERAS.forEach(e => state.pool[e] = 0); render(); };
  bindMachine();
  bindPlayers();
}

// Refresh counts, odds and the idle era reel without rebuilding the builder's DOM.
function updateBuilder() {
  const total = totalSlots();
  for (const e of ERAS) {
    const n = state.pool[e];
    const row = main.querySelector(`.era-row[data-era="${e}"]`);
    const count = row.querySelector('.count');
    count.textContent = `×${n}`;
    count.classList.toggle('on', n > 0);
    const pctEl = row.querySelector('.pct');
    pctEl.textContent = `${pct(n, total)}%`;
    pctEl.classList.toggle('zero', !n);
    row.querySelector('[data-sub]').disabled = !n;
    row.querySelector('[data-add]').disabled = n >= MAX_PER_ERA;
    main.querySelector(`.add-row [data-add="${e}"]`).disabled = n >= MAX_PER_ERA;
    row.querySelector('.slider').style.setProperty('--fill', `${(n / MAX_PER_ERA) * 100}%`);
  }
  main.querySelector('.total span').textContent = `${total} symbol${total === 1 ? '' : 's'} on the era reel`;
  $('#clearBtn').disabled = $('#pullBtn').disabled = !total;
  setStrip($('#eraStrip'), idleEraSymbols(), 0);
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
    if (!others.length) return 'Load another era to respin';
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
      <div class="marquee"><span class="bulbs"></span>NBA Dynasty<span class="bulbs"></span></div>
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
      : `<button class="btn-primary" id="pullBtn" ${state.phase !== 'build' || !total ? 'disabled' : ''}>Pull</button>`}`;
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
// The era symbol is picked uniformly from the weighted strip, so each era's
// odds equal its share of symbols (among the eras still eligible); the
// spinning reels are then animated onto exactly the picked results.
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
    // Several loops of the weighted strip, landing on the picked symbol.
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
  state.phase = filledCount() >= ROSTER_SIZE ? 'done' : 'build';
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
  if (confirm('Start a new draft? Your current picks will be cleared.')) resetDraft();
};
restore();
render();
