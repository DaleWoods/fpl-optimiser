-- Per-gameweek player stats, and the record needed to measure how good the model is.
--
-- The season-history table holds one row per player per season. That is enough to seed an
-- opening-gameweek projection, but it throws away everything interesting: a player who scored
-- all his points in three hauls is not the same as one who scored steadily, and a season total
-- cannot tell them apart. This table keeps the gameweek-by-gameweek detail.
--
-- It is also what makes the model measurable. With actual points per player per gameweek on
-- one side and stored projections on the other, "how wrong were we?" becomes a query.

CREATE TABLE player_gameweek_stat (
  player_id                  INTEGER NOT NULL REFERENCES player (id),
  season_name                TEXT    NOT NULL,          -- e.g. '2025/26'
  gameweek                   INTEGER NOT NULL,

  -- Context
  opponent_name              TEXT,
  was_home                   INTEGER,
  price                      INTEGER,                   -- tenths of a million
  selected_by_percent        REAL,

  -- Playing time and returns
  minutes                    INTEGER,
  total_points               INTEGER,
  goals                      INTEGER,
  assists                    INTEGER,
  clean_sheet                INTEGER,
  goals_conceded             INTEGER,

  -- Underlying
  total_shots                REAL,
  shots_on_target            REAL,
  shots_in_box               REAL,
  chances_created            REAL,
  expected_goals             REAL,
  non_penalty_expected_goals REAL,
  expected_assists           REAL,
  expected_goal_involvements REAL,
  expected_goals_conceded    REAL,
  expected_clean_sheet       REAL,

  -- Defensive contribution inputs (2026/27 DefCon scoring)
  clearances_blocks_interceptions REAL,
  recoveries                 REAL,
  tackles                    REAL,
  defensive_contribution     REAL,

  touches                    REAL,
  touches_opp_box            REAL,

  -- Some sources ship their own projection; keeping it lets ours be compared against it.
  source_expected_points     REAL,

  updated_at                 INTEGER NOT NULL,
  raw_json                   TEXT    NOT NULL,

  PRIMARY KEY (player_id, season_name, gameweek)
);

CREATE INDEX idx_pgs_season_gw ON player_gameweek_stat (season_name, gameweek);
CREATE INDEX idx_pgs_player ON player_gameweek_stat (player_id, season_name, gameweek);

-- What actually happened, per player per gameweek of the CURRENT season. Kept separate from
-- the imported history above because it is the thing projections are scored against, and it
-- can arrive from several places (a weekly stats file, or the API's own per-player history).
CREATE TABLE actual_points (
  player_id     INTEGER NOT NULL REFERENCES player (id),
  event_id      INTEGER NOT NULL,
  points        INTEGER NOT NULL,
  minutes       INTEGER,
  source        TEXT    NOT NULL,                       -- 'csv' | 'element-summary' | 'manual'
  recorded_at   INTEGER NOT NULL,

  PRIMARY KEY (player_id, event_id)
);

CREATE INDEX idx_actual_event ON actual_points (event_id);

-- The manager's own result for a gameweek, so model error and *your* result can be compared.
CREATE TABLE gameweek_result (
  entry_id            INTEGER NOT NULL,
  event_id            INTEGER NOT NULL,
  actual_points       INTEGER,                          -- what you actually scored
  predicted_points    REAL,                             -- what we said the XI would score
  optimal_points      INTEGER,                          -- best legal XI in hindsight
  bench_points        INTEGER,
  transfers_made      INTEGER,
  transfer_cost       INTEGER,
  chip                TEXT,
  note                TEXT,
  recorded_at         INTEGER NOT NULL,

  PRIMARY KEY (entry_id, event_id)
);

CREATE INDEX idx_gw_result_event ON gameweek_result (event_id);
