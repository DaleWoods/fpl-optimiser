/**
 * Builders for synthetic FPL API payloads.
 *
 * The FPL API is not reachable from CI, and pinning tests to a real recording would make them
 * drift with the season. These builders produce payloads in the API's real *shape* - including
 * its habit of sending numbers as strings - so schema handling, ingestion and the optimiser can
 * all be exercised deterministically.
 */

export interface FakeTeamSpec {
  id: number;
  name: string;
  short_name: string;
  attack?: number;
  defence?: number;
}

export interface FakePlayerSpec {
  id: number;
  web_name: string;
  team: number;
  /** element_type id: 1 GKP, 2 DEF, 3 MID, 4 FWD in the default position set. */
  element_type: number;
  now_cost: number;
  status?: string;
  chance_of_playing_next_round?: number | null;
  news?: string;
  form?: number;
  total_points?: number;
  minutes?: number;
  starts?: number;
  goals_scored?: number;
  assists?: number;
  clean_sheets?: number;
  goals_conceded?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
  selected_by_percent?: number;
  expected_goals?: number;
  expected_assists?: number;
  expected_goals_conceded?: number;
  defensive_contribution?: number;
  transfers_in_event?: number;
  transfers_out_event?: number;
}

export const DEFAULT_ELEMENT_TYPES = [
  { id: 1, singular_name_short: 'GKP', singular_name: 'Goalkeeper', plural_name: 'Goalkeepers', squad_select: 2, squad_min_play: 1, squad_max_play: 1, element_count: 80 },
  { id: 2, singular_name_short: 'DEF', singular_name: 'Defender', plural_name: 'Defenders', squad_select: 5, squad_min_play: 3, squad_max_play: 5, element_count: 220 },
  { id: 3, singular_name_short: 'MID', singular_name: 'Midfielder', plural_name: 'Midfielders', squad_select: 5, squad_min_play: 2, squad_max_play: 5, element_count: 250 },
  { id: 4, singular_name_short: 'FWD', singular_name: 'Forward', plural_name: 'Forwards', squad_select: 3, squad_min_play: 1, squad_max_play: 3, element_count: 90 },
];

/** The API sends most derived numbers as strings; mimic that so coercion is genuinely tested. */
const s = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : String(n));

export function fakeTeam(spec: FakeTeamSpec) {
  const attack = spec.attack ?? 1100;
  const defence = spec.defence ?? 1100;
  return {
    id: spec.id,
    code: 100 + spec.id,
    name: spec.name,
    short_name: spec.short_name,
    strength: 3,
    strength_overall_home: attack,
    strength_overall_away: attack - 30,
    strength_attack_home: attack,
    strength_attack_away: attack - 40,
    strength_defence_home: defence,
    strength_defence_away: defence - 40,
    pulse_id: spec.id,
  };
}

export function fakePlayer(spec: FakePlayerSpec) {
  return {
    id: spec.id,
    code: 200000 + spec.id,
    web_name: spec.web_name,
    first_name: 'Test',
    second_name: spec.web_name,
    team: spec.team,
    element_type: spec.element_type,

    now_cost: spec.now_cost,
    cost_change_start: 0,
    cost_change_event: 0,

    status: spec.status ?? 'a',
    chance_of_playing_this_round: spec.chance_of_playing_next_round ?? null,
    chance_of_playing_next_round: spec.chance_of_playing_next_round ?? null,
    news: spec.news ?? '',
    news_added: spec.news ? '2026-08-18T09:00:00Z' : null,

    form: s(spec.form ?? 3),
    points_per_game: s(spec.total_points !== undefined ? spec.total_points / 5 : 4),
    total_points: spec.total_points ?? 40,
    selected_by_percent: s(spec.selected_by_percent ?? 5),
    ep_this: s(4),
    ep_next: s(4),

    minutes: spec.minutes ?? 450,
    starts: spec.starts ?? 5,
    goals_scored: spec.goals_scored ?? 0,
    assists: spec.assists ?? 0,
    clean_sheets: spec.clean_sheets ?? 0,
    goals_conceded: spec.goals_conceded ?? 0,
    saves: spec.saves ?? 0,
    bonus: spec.bonus ?? 0,
    bps: spec.bps ?? 0,
    yellow_cards: 0,
    red_cards: 0,

    expected_goals: s(spec.expected_goals ?? 0),
    expected_assists: s(spec.expected_assists ?? 0),
    expected_goal_involvements: s((spec.expected_goals ?? 0) + (spec.expected_assists ?? 0)),
    expected_goals_conceded: s(spec.expected_goals_conceded ?? 0),
    defensive_contribution: s(spec.defensive_contribution ?? 0),
    transfers_in_event: spec.transfers_in_event ?? 0,
    transfers_out_event: spec.transfers_out_event ?? 0,
  };
}

export function fakeEvent(id: number, overrides: Record<string, unknown> = {}) {
  // GW1 deadline 21 Aug 2026 18:30 BST, then weekly.
  const base = Date.parse('2026-08-21T17:30:00Z');
  return {
    id,
    name: `Gameweek ${id}`,
    deadline_time: new Date(base + (id - 1) * 7 * 24 * 3600 * 1000).toISOString(),
    is_current: false,
    is_next: false,
    is_previous: false,
    finished: false,
    data_checked: false,
    average_entry_score: 0,
    highest_score: null,
    ...overrides,
  };
}

export function fakeFixture(
  id: number,
  eventId: number | null,
  teamH: number,
  teamA: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    event: eventId,
    team_h: teamH,
    team_a: teamA,
    kickoff_time: eventId === null ? null : fakeEvent(eventId).deadline_time,
    team_h_difficulty: 3,
    team_a_difficulty: 3,
    team_h_score: null,
    team_a_score: null,
    started: false,
    finished: false,
    ...overrides,
  };
}

export interface FakeBootstrapOptions {
  teams?: FakeTeamSpec[];
  players?: FakePlayerSpec[];
  events?: ReturnType<typeof fakeEvent>[];
}

export function fakeBootstrap(options: FakeBootstrapOptions = {}) {
  const teams = (options.teams ?? defaultTeams()).map(fakeTeam);
  const players = (options.players ?? defaultPlayers(options.teams ?? defaultTeams())).map(fakePlayer);
  const events =
    options.events ??
    [fakeEvent(1, { is_next: true, is_current: false }), fakeEvent(2), fakeEvent(3)];
  return {
    events,
    teams,
    element_types: DEFAULT_ELEMENT_TYPES,
    elements: players,
    total_players: 9000000,
    game_settings: {},
    phases: [],
  };
}

export function defaultTeams(count = 4): FakeTeamSpec[] {
  const names = [
    ['Alpha FC', 'ALP', 1300, 1300],
    ['Beta United', 'BET', 1150, 1150],
    ['Gamma City', 'GAM', 1050, 1050],
    ['Delta Town', 'DEL', 950, 900],
    ['Epsilon Rovers', 'EPS', 1000, 1000],
    ['Zeta Athletic', 'ZET', 1100, 1050],
  ] as const;
  return names.slice(0, count).map(([name, short, attack, defence], index) => ({
    id: index + 1,
    name,
    short_name: short,
    attack,
    defence,
  }));
}

/** A small but legal player pool: enough of every position to build a valid 15 under budget. */
export function defaultPlayers(teams: FakeTeamSpec[] = defaultTeams()): FakePlayerSpec[] {
  const players: FakePlayerSpec[] = [];
  let id = 1;
  const perTeam: Array<[number, number, number]> = [
    // [element_type, count, base price in tenths]
    [1, 2, 45],
    [2, 5, 45],
    [3, 5, 55],
    [4, 3, 60],
  ];

  for (const team of teams) {
    for (const [elementType, count, basePrice] of perTeam) {
      for (let n = 0; n < count; n += 1) {
        players.push({
          id,
          web_name: `${team.short_name}-${['GK', 'DF', 'MD', 'FW'][elementType - 1]}${n + 1}`,
          team: team.id,
          element_type: elementType,
          now_cost: basePrice + n * 5,
          form: 3 + (n % 3),
          total_points: 30 + n * 5,
          minutes: 450,
          starts: 5,
        });
        id += 1;
      }
    }
  }
  return players;
}

export function fakeEntry(teamId: number, overrides: Record<string, unknown> = {}) {
  return {
    id: teamId,
    name: 'Test Team',
    player_first_name: 'Test',
    player_last_name: 'Manager',
    summary_overall_points: 0,
    summary_overall_rank: null,
    last_deadline_bank: 5,
    last_deadline_value: 1000,
    last_deadline_total_transfers: 0,
    current_event: null,
    ...overrides,
  };
}

export function fakePicks(playerIds: number[], overrides: Record<string, unknown> = {}) {
  return {
    active_chip: null,
    automatic_subs: [],
    entry_history: {
      event: 1,
      points: 0,
      total_points: 0,
      rank: null,
      bank: 5,
      value: 1000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 0,
    },
    picks: playerIds.map((element, index) => ({
      element,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
    })),
    ...overrides,
  };
}

export function fakeElementSummary(playerId: number, matches: Array<Record<string, unknown>> = []) {
  return {
    fixtures: [],
    history_past: [],
    history: matches.map((match, index) => ({
      element: playerId,
      fixture: 100 + index,
      round: index + 1,
      opponent_team: 2,
      was_home: index % 2 === 0,
      kickoff_time: fakeEvent(index + 1).deadline_time,
      minutes: 90,
      total_points: 2,
      goals_scored: 0,
      assists: 0,
      clean_sheets: 0,
      goals_conceded: 1,
      saves: 0,
      bonus: 0,
      bps: 15,
      yellow_cards: 0,
      red_cards: 0,
      starts: 1,
      value: 50,
      expected_goals: '0.1',
      expected_assists: '0.1',
      expected_goal_involvements: '0.2',
      expected_goals_conceded: '1.2',
      defensive_contribution: '4',
      ...match,
    })),
  };
}
