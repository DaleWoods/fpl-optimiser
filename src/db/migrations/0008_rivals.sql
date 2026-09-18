-- A specific rival's squad, gameweek by gameweek.
--
-- Different in kind from elite_ownership, which samples the top of the overall league and asks
-- "what does the consensus own". This is one named manager who keeps beating you, and the useful
-- question is not what he owns but WHERE HE AND THIS MODEL DISAGREE: a player he owns that the
-- model also rates is a pick you have simply missed, while one the model rates poorly is either
-- his edge or his luck, and the two are worth telling apart rather than copying blind.
--
-- Only available once a gameweek has started - the API keeps picks private before that, the same
-- blind spot that applies to your own squad.
CREATE TABLE rival_pick (
  entry_id     INTEGER NOT NULL,
  event_id     INTEGER NOT NULL,
  player_id    INTEGER NOT NULL REFERENCES player (id),
  slot         INTEGER NOT NULL,          -- 1-11 started, 12-15 benched
  multiplier   INTEGER NOT NULL,          -- 0 benched, 1 played, 2 captain, 3 triple captain
  captured_at  INTEGER NOT NULL,

  PRIMARY KEY (entry_id, event_id, player_id)
);

CREATE INDEX idx_rival_pick_event ON rival_pick (event_id, entry_id);

-- Their name and running score, so the page can say who it is and whether they are worth watching.
CREATE TABLE rival_entry (
  entry_id     INTEGER PRIMARY KEY,
  label        TEXT,
  total_points INTEGER,
  updated_at   INTEGER NOT NULL
);
