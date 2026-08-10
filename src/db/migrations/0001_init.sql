-- Initial schema.
--
-- Design notes:
--  * Money is INTEGER tenths of a million throughout (the API's now_cost units). Never REAL.
--  * Timestamps are INTEGER unix seconds unless the column name ends in _iso (API strings kept
--    verbatim so an API timezone change can never be silently reinterpreted).
--  * Booleans are INTEGER 0/1.
--  * Every ingested row keeps its raw JSON. The FPL API is unofficial and adds fields between
--    seasons; storing the raw payload means a field we did not model yet is still recoverable
--    from history rather than lost.
--  * Reference data (player, team, position, event, fixture) is upserted to current state.
--    Anything whose history matters (price, form, ownership, availability) is append-only in
--    player_snapshot, so trends stay queryable.

-- ---------------------------------------------------------------------------
-- Ingestion bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL,               -- 'bootstrap-static', 'fixtures', ...
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  ok            INTEGER NOT NULL DEFAULT 0,
  from_cache    INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  note          TEXT
);

CREATE INDEX idx_ingest_run_source_started ON ingest_run (source, started_at DESC);

-- One row per bootstrap-static ingestion. player_snapshot rows hang off it, giving a
-- consistent point-in-time view of the whole player pool.
CREATE TABLE snapshot (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at         INTEGER NOT NULL,
  ingest_run_id    INTEGER REFERENCES ingest_run (id),
  current_event_id INTEGER,
  next_event_id    INTEGER
);

CREATE INDEX idx_snapshot_taken_at ON snapshot (taken_at DESC);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

-- FPL element_types. Positions come from the API, never from config or code.
CREATE TABLE position (
  id                  INTEGER PRIMARY KEY,      -- element_type id
  short_name          TEXT    NOT NULL UNIQUE,  -- GKP / DEF / MID / FWD; the key config rules use
  singular_name       TEXT    NOT NULL,
  plural_name         TEXT,
  squad_select        INTEGER,                  -- how many the API says a squad holds
  squad_min_play      INTEGER,
  squad_max_play      INTEGER,
  element_count       INTEGER,
  updated_at          INTEGER NOT NULL,
  raw_json            TEXT    NOT NULL
);

CREATE TABLE team (
  id                     INTEGER PRIMARY KEY,
  code                   INTEGER,
  name                   TEXT    NOT NULL,
  short_name             TEXT    NOT NULL,
  strength               INTEGER,
  strength_overall_home  INTEGER,
  strength_overall_away  INTEGER,
  strength_attack_home   INTEGER,
  strength_attack_away   INTEGER,
  strength_defence_home  INTEGER,
  strength_defence_away  INTEGER,
  updated_at             INTEGER NOT NULL,
  raw_json               TEXT    NOT NULL
);

-- Gameweeks. Deadlines are always read from here, never assumed.
CREATE TABLE event (
  id                INTEGER PRIMARY KEY,
  name              TEXT,
  deadline_time_iso TEXT,                       -- API string, kept verbatim
  deadline_time     INTEGER,                    -- parsed unix seconds, for querying
  is_current        INTEGER NOT NULL DEFAULT 0,
  is_next           INTEGER NOT NULL DEFAULT 0,
  is_previous       INTEGER NOT NULL DEFAULT 0,
  finished          INTEGER NOT NULL DEFAULT 0,
  data_checked      INTEGER NOT NULL DEFAULT 0,
  average_score     INTEGER,
  highest_score     INTEGER,
  updated_at        INTEGER NOT NULL,
  raw_json          TEXT    NOT NULL
);

CREATE INDEX idx_event_deadline ON event (deadline_time);

-- Player identity only. Everything that moves lives in player_snapshot.
CREATE TABLE player (
  id           INTEGER PRIMARY KEY,             -- element id
  code         INTEGER,                         -- stable across seasons
  web_name     TEXT    NOT NULL,
  first_name   TEXT,
  second_name  TEXT,
  team_id      INTEGER NOT NULL REFERENCES team (id),
  position_id  INTEGER NOT NULL REFERENCES position (id),
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_player_team ON player (team_id);
CREATE INDEX idx_player_position ON player (position_id);

CREATE TABLE fixture (
  id                INTEGER PRIMARY KEY,
  event_id          INTEGER REFERENCES event (id),   -- null for unscheduled fixtures
  team_h            INTEGER NOT NULL REFERENCES team (id),
  team_a            INTEGER NOT NULL REFERENCES team (id),
  kickoff_time_iso  TEXT,
  kickoff_time      INTEGER,
  team_h_difficulty INTEGER,
  team_a_difficulty INTEGER,
  team_h_score      INTEGER,
  team_a_score      INTEGER,
  started           INTEGER NOT NULL DEFAULT 0,
  finished          INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  raw_json          TEXT    NOT NULL
);

CREATE INDEX idx_fixture_event ON fixture (event_id);
CREATE INDEX idx_fixture_teams ON fixture (team_h, team_a);
CREATE INDEX idx_fixture_kickoff ON fixture (kickoff_time);

-- ---------------------------------------------------------------------------
-- Time series
-- ---------------------------------------------------------------------------

-- Append-only. One row per player per bootstrap ingestion: price, availability, form,
-- ownership and season totals as they stood at that moment.
CREATE TABLE player_snapshot (
  snapshot_id                   INTEGER NOT NULL REFERENCES snapshot (id) ON DELETE CASCADE,
  player_id                     INTEGER NOT NULL REFERENCES player (id),
  taken_at                      INTEGER NOT NULL,

  now_cost                      INTEGER NOT NULL,   -- tenths of a million
  cost_change_start             INTEGER,
  cost_change_event             INTEGER,

  status                        TEXT    NOT NULL,   -- a/d/i/s/u/n
  chance_of_playing_this_round  INTEGER,            -- null means "API said nothing"
  chance_of_playing_next_round  INTEGER,
  news                          TEXT,
  news_added_iso                TEXT,

  form                          REAL,
  points_per_game               REAL,
  total_points                  INTEGER,
  selected_by_percent           REAL,
  ep_this                       REAL,
  ep_next                       REAL,

  minutes                       INTEGER,
  starts                        INTEGER,
  goals_scored                  INTEGER,
  assists                       INTEGER,
  clean_sheets                  INTEGER,
  goals_conceded                INTEGER,
  saves                         INTEGER,
  bonus                         INTEGER,
  bps                           INTEGER,
  yellow_cards                  INTEGER,
  red_cards                     INTEGER,

  -- Optional/newer API fields. Null when the API does not supply them; the model degrades
  -- gracefully rather than treating an absent stat as zero.
  expected_goals                REAL,
  expected_assists              REAL,
  expected_goal_involvements    REAL,
  expected_goals_conceded       REAL,
  defensive_contribution        REAL,

  raw_json                      TEXT    NOT NULL,

  PRIMARY KEY (snapshot_id, player_id)
);

CREATE INDEX idx_player_snapshot_player_time ON player_snapshot (player_id, taken_at DESC);
CREATE INDEX idx_player_snapshot_taken_at ON player_snapshot (taken_at DESC);

-- Per-player per-fixture history from element-summary. The basis of every form calculation.
CREATE TABLE player_fixture_history (
  player_id                  INTEGER NOT NULL REFERENCES player (id),
  fixture_id                 INTEGER NOT NULL,
  event_id                   INTEGER,
  opponent_team_id           INTEGER,
  was_home                   INTEGER,
  kickoff_time_iso           TEXT,
  kickoff_time               INTEGER,

  minutes                    INTEGER,
  total_points               INTEGER,
  goals_scored               INTEGER,
  assists                    INTEGER,
  clean_sheets               INTEGER,
  goals_conceded             INTEGER,
  saves                      INTEGER,
  bonus                      INTEGER,
  bps                        INTEGER,
  yellow_cards               INTEGER,
  red_cards                  INTEGER,
  starts                     INTEGER,
  value                      INTEGER,            -- price at the time, tenths of a million

  expected_goals             REAL,
  expected_assists           REAL,
  expected_goal_involvements REAL,
  expected_goals_conceded    REAL,
  defensive_contribution     REAL,

  updated_at                 INTEGER NOT NULL,
  raw_json                   TEXT    NOT NULL,

  PRIMARY KEY (player_id, fixture_id)
);

CREATE INDEX idx_pfh_player_kickoff ON player_fixture_history (player_id, kickoff_time DESC);
CREATE INDEX idx_pfh_event ON player_fixture_history (event_id);

-- Detected changes between consecutive snapshots: price moves, status flips, fresh news.
CREATE TABLE change_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at  INTEGER NOT NULL,
  player_id    INTEGER NOT NULL REFERENCES player (id),
  kind         TEXT    NOT NULL,                -- 'price' | 'status' | 'news' | 'chance'
  before_value TEXT,
  after_value  TEXT,
  note         TEXT
);

CREATE INDEX idx_change_log_detected ON change_log (detected_at DESC);
CREATE INDEX idx_change_log_player ON change_log (player_id, detected_at DESC);

-- ---------------------------------------------------------------------------
-- The manager's own team
-- ---------------------------------------------------------------------------

CREATE TABLE manager_state (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id               INTEGER NOT NULL,
  captured_at            INTEGER NOT NULL,
  event_id               INTEGER,
  bank                   INTEGER,               -- tenths of a million
  team_value             INTEGER,               -- tenths of a million
  total_points           INTEGER,
  overall_rank           INTEGER,
  -- Free transfers are not exposed by the public API; this is either derived from history or
  -- supplied manually. free_transfers_source records which, so advice can say how it knows.
  free_transfers         INTEGER,
  free_transfers_source  TEXT,                  -- 'derived' | 'manual' | 'unknown'
  chips_available_json   TEXT,
  chips_used_json        TEXT,
  raw_json               TEXT
);

CREATE INDEX idx_manager_state_entry_time ON manager_state (entry_id, captured_at DESC);

CREATE TABLE squad_pick (
  manager_state_id INTEGER NOT NULL REFERENCES manager_state (id) ON DELETE CASCADE,
  player_id        INTEGER NOT NULL REFERENCES player (id),
  slot             INTEGER NOT NULL,            -- 1-15, API pick order (1-11 start, 12-15 bench)
  multiplier       INTEGER NOT NULL DEFAULT 1,  -- 0 benched, 1 playing, 2 captain, 3 triple
  is_captain       INTEGER NOT NULL DEFAULT 0,
  is_vice_captain  INTEGER NOT NULL DEFAULT 0,
  -- Purchase and selling price need an authenticated endpoint. Null when unknown; the
  -- transfer engine then says so instead of inventing a budget.
  purchase_price   INTEGER,
  selling_price    INTEGER,
  price_source     TEXT,                        -- 'api' | 'derived' | 'manual' | 'unknown'

  PRIMARY KEY (manager_state_id, player_id)
);

CREATE INDEX idx_squad_pick_state_slot ON squad_pick (manager_state_id, slot);

-- ---------------------------------------------------------------------------
-- Model output (auditability: every projection and recommendation is kept)
-- ---------------------------------------------------------------------------

CREATE TABLE projection (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id                INTEGER NOT NULL REFERENCES player (id),
  event_id                 INTEGER NOT NULL,
  model_version            TEXT    NOT NULL,
  created_at               INTEGER NOT NULL,
  xpts                     REAL    NOT NULL,     -- after availability weighting
  xpts_raw                 REAL    NOT NULL,     -- before availability weighting
  availability_probability REAL    NOT NULL,
  expected_minutes         REAL,
  fixture_count            INTEGER NOT NULL DEFAULT 1,
  confidence               TEXT,                 -- 'high' | 'medium' | 'low'
  breakdown_json           TEXT    NOT NULL      -- per-component contributions, for explanations
);

CREATE UNIQUE INDEX idx_projection_unique
  ON projection (player_id, event_id, model_version, created_at);
CREATE INDEX idx_projection_event ON projection (event_id, created_at DESC);

CREATE TABLE recommendation (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     INTEGER NOT NULL,
  event_id       INTEGER NOT NULL,
  entry_id       INTEGER,
  kind           TEXT    NOT NULL,               -- 'xi' | 'transfer' | 'captain' | 'bench'
  model_version  TEXT    NOT NULL,
  summary        TEXT    NOT NULL,               -- plain English
  detail_json    TEXT    NOT NULL,
  data_taken_at  INTEGER                         -- staleness of the data behind the advice
);

CREATE INDEX idx_recommendation_event ON recommendation (event_id, created_at DESC);
