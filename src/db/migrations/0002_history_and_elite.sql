-- Previous-season history and elite-manager ownership.
--
-- Two gaps the first schema left:
--
--  1. Previous seasons. element-summary returns a `history_past` block with per-season totals.
--     At the start of a season it is the only real evidence about a player - this season's
--     stats are all zero - so it is what an opening-gameweek projection should lean on.
--
--  2. What good managers actually own. Overall ownership treats a casual manager's pick the
--     same as a top-1k manager's. Sampling the top of the overall league gives a far better
--     signal, and it is available from the public API.

CREATE TABLE player_season_history (
  player_id                  INTEGER NOT NULL REFERENCES player (id),
  season_name                TEXT    NOT NULL,          -- e.g. '2025/26'
  -- element_code is stable across seasons, unlike player_id, so it is kept for matching.
  element_code               INTEGER,

  start_cost                 INTEGER,                   -- tenths of a million
  end_cost                   INTEGER,
  total_points               INTEGER,
  minutes                    INTEGER,
  starts                     INTEGER,

  goals_scored               INTEGER,
  assists                    INTEGER,
  clean_sheets               INTEGER,
  goals_conceded             INTEGER,
  saves                      INTEGER,
  bonus                      INTEGER,
  bps                        INTEGER,
  yellow_cards               INTEGER,
  red_cards                  INTEGER,

  expected_goals             REAL,
  expected_assists           REAL,
  expected_goal_involvements REAL,
  expected_goals_conceded    REAL,
  defensive_contribution     REAL,

  updated_at                 INTEGER NOT NULL,
  raw_json                   TEXT    NOT NULL,

  PRIMARY KEY (player_id, season_name)
);

CREATE INDEX idx_season_history_player ON player_season_history (player_id);
CREATE INDEX idx_season_history_season ON player_season_history (season_name);

-- A sample of the squads owned by the highest-ranked managers in the overall league.
CREATE TABLE elite_sample (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at   INTEGER NOT NULL,
  event_id      INTEGER NOT NULL,
  league_id     INTEGER NOT NULL,
  managers      INTEGER NOT NULL,        -- how many squads were actually sampled
  note          TEXT
);

CREATE INDEX idx_elite_sample_event ON elite_sample (event_id, captured_at DESC);

CREATE TABLE elite_ownership (
  sample_id     INTEGER NOT NULL REFERENCES elite_sample (id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES player (id),
  owned_by      INTEGER NOT NULL,        -- how many of the sampled managers own them
  started_by    INTEGER NOT NULL,        -- how many start them
  captained_by  INTEGER NOT NULL,
  ownership     REAL    NOT NULL,        -- owned_by / managers, 0..1

  PRIMARY KEY (sample_id, player_id)
);

CREATE INDEX idx_elite_ownership_player ON elite_ownership (player_id);
