#!/usr/bin/env python3
"""Import every NBA player from Basketball-Reference and build data.js.

For each season from 1960-61 to 2025-26 this reads Basketball-Reference's
"per game" table (team, position, games, points, rebounds, ...). Players are
grouped by franchise and decade; their positions and per-game averages with
that franchise that decade come straight from the table. Nothing is entered
by hand, and there are no derived ratings.

The browser can't read Basketball-Reference directly (cross-site requests are
blocked, and it would hit their rate limit on every page load), so this script
does the import and writes the result to data.js for the game to load.

Usage:
    python3 tools/build_data.py [--cache DIR]

Pages are cached in DIR (default tools/.cache). Missing pages are downloaded
4 seconds apart, within Basketball-Reference's rate limit; a full download is
66 pages and takes about 5 minutes.
"""
import argparse
import html
import json
import os
import re
import time
import urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIRST_SEASON, LAST_SEASON = 1960, 2025  # season start years (1960-61 .. 2025-26)
SLOTS = ['PG', 'SG', 'SF', 'PF', 'C']

# Basketball-Reference team code (including former names/cities) -> franchise
FRANCHISE_OF = {
    'ATL': 'ATL', 'STL': 'ATL',
    'BOS': 'BOS',
    'BRK': 'BRK', 'NJN': 'BRK', 'NYN': 'BRK',
    'CHO': 'CHO', 'CHA': 'CHO', 'CHH': 'CHO',
    'CHI': 'CHI', 'CLE': 'CLE', 'DAL': 'DAL', 'DEN': 'DEN', 'DET': 'DET',
    'GSW': 'GSW', 'SFW': 'GSW', 'PHW': 'GSW',
    'HOU': 'HOU', 'SDR': 'HOU',
    'IND': 'IND',
    'LAC': 'LAC', 'SDC': 'LAC', 'BUF': 'LAC',
    'LAL': 'LAL', 'MNL': 'LAL',
    'MEM': 'MEM', 'VAN': 'MEM',
    'MIA': 'MIA', 'MIL': 'MIL', 'MIN': 'MIN',
    'NOP': 'NOP', 'NOH': 'NOP', 'NOK': 'NOP',
    'NYK': 'NYK',
    'OKC': 'OKC', 'SEA': 'OKC',
    'ORL': 'ORL',
    'PHI': 'PHI', 'SYR': 'PHI',
    'PHO': 'PHO', 'POR': 'POR',
    'SAC': 'SAC', 'KCK': 'SAC', 'KCO': 'SAC', 'CIN': 'SAC',
    'SAS': 'SAS', 'TOR': 'TOR',
    'UTA': 'UTA', 'NOJ': 'UTA',
    'WAS': 'WAS', 'WSB': 'WAS', 'CAP': 'WAS', 'BAL': 'WAS', 'CHZ': 'WAS', 'CHP': 'WAS',
}
# Current name of each franchise, used for every decade
FRANCHISE_NAMES = {
    'ATL': 'Atlanta Hawks', 'BOS': 'Boston Celtics', 'BRK': 'Brooklyn Nets', 'CHO': 'Charlotte Hornets',
    'CHI': 'Chicago Bulls', 'CLE': 'Cleveland Cavaliers', 'DAL': 'Dallas Mavericks', 'DEN': 'Denver Nuggets',
    'DET': 'Detroit Pistons', 'GSW': 'Golden State Warriors', 'HOU': 'Houston Rockets', 'IND': 'Indiana Pacers',
    'LAC': 'Los Angeles Clippers', 'LAL': 'Los Angeles Lakers', 'MEM': 'Memphis Grizzlies', 'MIA': 'Miami Heat',
    'MIL': 'Milwaukee Bucks', 'MIN': 'Minnesota Timberwolves', 'NOP': 'New Orleans Pelicans', 'NYK': 'New York Knicks',
    'OKC': 'Oklahoma City Thunder', 'ORL': 'Orlando Magic', 'PHI': 'Philadelphia 76ers', 'PHO': 'Phoenix Suns',
    'POR': 'Portland Trail Blazers', 'SAC': 'Sacramento Kings', 'SAS': 'San Antonio Spurs', 'TOR': 'Toronto Raptors',
    'UTA': 'Utah Jazz', 'WAS': 'Washington Wizards',
}
COMBINED_ROWS = re.compile(r'^(TOT|\dTM)$')  # multi-team season totals; per-team rows are used instead

# Game rule: these players' eligible positions replace the ones listed on
# Basketball-Reference, for every team and decade (keyed by player id).
# LeBron James is the only player who can play all five positions.
POSITION_OVERRIDES = {
    'jamesle01': ['PG', 'SG', 'SF', 'PF', 'C'],  # LeBron James
    'duranke01': ['SG', 'SF', 'PF'],              # Kevin Durant
}

PER_GAME_STATS = {'ppg': 'pts_per_g', 'rpg': 'trb_per_g', 'apg': 'ast_per_g', 'spg': 'stl_per_g', 'bpg': 'blk_per_g'}


def fetch(cache, year):
    """Season start year -> cached HTML of that season's per-game table."""
    path = os.path.join(cache, f'{year + 1}_per_game.html')
    if not os.path.exists(path) or os.path.getsize(path) < 100_000:
        url = f'https://www.basketball-reference.com/leagues/NBA_{year + 1}_per_game.html'
        print('downloading', url)
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as r, open(path, 'wb') as f:
            f.write(r.read())
        time.sleep(4)
    return open(path, encoding='utf-8').read()


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_table(text, table_id):
    """Rows of a Basketball-Reference stats table as dicts of data-stat -> text, plus player id."""
    table = text[text.index(f'id="{table_id}"'):]
    table = table[:table.index('</table>')]
    rows = []
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', table, re.S):
        idm = re.search(r'<td[^>]*data-append-csv="([^"]+)"', tr)
        if not idm or 'name_display' not in tr:
            continue
        cells = {k: html.unescape(re.sub(r'<[^>]+>', '', v)).strip()
                 for k, v in re.findall(r'data-stat="(\w+)"[^>]*>(.*?)</t[dh]>', tr, re.S)}
        cells['id'] = idm.group(1)
        rows.append(cells)
    return rows


def parse_season(cache, year):
    """One row per player per team for the season."""
    rows = []
    for r in parse_table(fetch(cache, year), 'per_game_stats'):
        team = r.get('team_name_abbr', '')
        if COMBINED_ROWS.match(team):
            continue
        if team not in FRANCHISE_OF:
            raise SystemExit(f'Unknown team code {team} in {year}')
        g = int(num(r.get('games')) or 0)
        rows.append({
            'id': r['id'], 'name': r['name_display'].rstrip('*'), 'team': team, 'year': year,
            'pos': r.get('pos', ''), 'g': g, 'mp': (num(r.get('mp_per_g')) or 0) * g,
            **{k: num(r.get(col)) for k, col in PER_GAME_STATS.items()},
        })
    return rows


def per_game(seasons, key):
    """Games-weighted average over the seasons that recorded the stat (None if none did)."""
    have = [s for s in seasons if s[key] is not None and s['g']]
    games = sum(s['g'] for s in have)
    return round(sum(s[key] * s['g'] for s in have) / games, 1) if games else None


def positions_from(seasons):
    """Eligible positions: primary by minutes, plus listed or meaningful secondaries."""
    weight = defaultdict(float)
    for s in seasons:
        parts = [p for p in s['pos'].split('-') if p in SLOTS]
        for i, p in enumerate(parts):
            weight[p] += (s['mp'] or 1) * (1 if i == 0 else 0.5)
    if not weight:
        return ['SF']
    ranked = sorted(weight, key=weight.get, reverse=True)
    top = weight[ranked[0]]
    return [p for p in ranked if weight[p] >= 0.25 * top][:2]


def fmt(v):
    return '' if v is None else f'{v:g}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(HERE, '.cache'))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    # (era, franchise) -> player id -> season rows
    groups = defaultdict(lambda: defaultdict(list))
    for year in range(FIRST_SEASON, LAST_SEASON + 1):
        era = f'{year // 10 * 10}s'
        for r in parse_season(args.cache, year):
            groups[(era, FRANCHISE_OF[r['team']])][r['id']].append(r)

    out = {}
    total = 0
    for (era, fr), players in sorted(groups.items()):
        roster = []
        for pid, seasons in players.items():
            ys = sorted(s['year'] for s in seasons)
            roster.append({
                'id': pid, 'name': seasons[-1]['name'],
                'pos': '/'.join(POSITION_OVERRIDES.get(pid) or positions_from(seasons)),
                'years': f'{ys[0]}–{str(ys[-1] + 1)[-2:]}', 'g': sum(s['g'] for s in seasons),
                **{k: per_game(seasons, k) for k in PER_GAME_STATS},
            })
        roster.sort(key=lambda p: (-(p['ppg'] or 0), -p['g']))
        total += len(roster)
        out.setdefault(era, {})[FRANCHISE_NAMES[fr]] = ';'.join(
            '|'.join([p['id'], p['name'], p['pos'], p['years'], str(p['g'])]
                     + [fmt(p[k]) for k in PER_GAME_STATS]) for p in roster)

    with open(os.path.join(ROOT, 'data.js'), 'w', encoding='utf-8') as f:
        f.write('// Generated by tools/build_data.py from Basketball-Reference season tables.\n')
        f.write('// Do not edit by hand: re-run the script to refresh it.\n')
        f.write("const ERAS = ['1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];\n\n")
        f.write('// era -> team (current franchise name) -> "id|name|positions|years|games|ppg|rpg|apg|spg|bpg;..."\n')
        f.write('// Stats are per-game averages with that franchise that decade.\n')
        f.write('// Steals and blocks were first recorded in 1973-74; earlier values are empty.\n')
        f.write('const TEAMS_RAW = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';\n\n')
        f.write('''// Parse into DATA[era][team] = [{ id, name, pos, years, games, ppg, rpg, apg, spg, bpg }].
const STAT_KEYS = ['ppg', 'rpg', 'apg', 'spg', 'bpg'];
const DATA = {};
for (const era of ERAS) {
  DATA[era] = {};
  for (const [team, list] of Object.entries(TEAMS_RAW[era])) {
    DATA[era][team] = list.split(';').map(s => {
      const [id, name, pos, years, games, ...stats] = s.split('|');
      const p = { id, name, pos: pos.split('/'), years, games: +games };
      STAT_KEYS.forEach((k, i) => p[k] = stats[i] === '' ? null : +stats[i]);
      return p;
    });
  }
}
''')
    print(f'{sum(len(v) for v in out.values())} team-eras, {total} player entries')


if __name__ == '__main__':
    main()
