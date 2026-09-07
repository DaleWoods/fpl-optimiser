-- Transfers you have told the app you actually made, for a gameweek it cannot see yet.
--
-- The public API only returns your picks for a gameweek that has already STARTED
-- (entry.current_event). So from the moment one gameweek ends until the next kicks off - which
-- is most of the week, and all of the time you spend planning - the app is looking at last
-- week's team. Advice built on it silently assumes you still own players you sold days ago.
--
-- Ticking a suggested transfer records it here, and it is applied on top of the last real squad
-- until the API catches up. Deliberately an overlay, never a replacement: once the API returns
-- picks that cover the gameweek, those are the truth and these rows simply stop matching.
CREATE TABLE confirmed_transfer (
  entry_id       INTEGER NOT NULL,
  event_id       INTEGER NOT NULL,          -- the gameweek the transfer was made FOR
  out_player_id  INTEGER NOT NULL REFERENCES player (id),
  in_player_id   INTEGER NOT NULL REFERENCES player (id),
  noted_at       INTEGER NOT NULL,

  PRIMARY KEY (entry_id, event_id, out_player_id)
);

CREATE INDEX idx_confirmed_transfer_entry ON confirmed_transfer (entry_id, event_id);
