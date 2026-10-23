-- Chips you have told the app you played, for a gameweek it cannot see yet.
--
-- The same blind spot as confirmed_transfer, and it bites harder. Chip usage reaches this app
-- only through the entry-history endpoint, which - like picks - says nothing about a gameweek
-- that has not started. So for the whole week between playing a Wildcard and the deadline
-- passing, the chips page carries on recommending the chip you have already spent, and the
-- squad advice carries on from the fifteen you no longer own.
--
-- An overlay, never a replacement, exactly as confirmed_transfer is: once the API reports the
-- chip, that is the truth and this row is merged away rather than counted twice.
CREATE TABLE played_chip (
  entry_id  INTEGER NOT NULL,
  event_id  INTEGER NOT NULL,          -- the gameweek the chip was played IN
  chip      TEXT    NOT NULL,          -- the API's own code: wildcard / freehit / 3xc / bboost
  noted_at  INTEGER NOT NULL,

  PRIMARY KEY (entry_id, event_id, chip)
);

CREATE INDEX idx_played_chip_entry ON played_chip (entry_id);
