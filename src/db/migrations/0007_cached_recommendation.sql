-- The last generated team, kept so that leaving the tab and coming back does not throw it away.
--
-- Generating is deliberately explicit - a team is only worth acting on when it is built from all
-- the evidence at once - but that rule was being applied to *looking* as well as to building, so
-- every visit to My Team demanded the button again and produced the same answer. What actually
-- matters is that the team on screen was built from the data currently on disk. That is a
-- question about the inputs, not about how you arrived at the page, so the inputs are stamped
-- here and the stored page is served until the stamp stops matching.
--
-- One row. Only the most recent generation is ever of interest, and keeping a history here would
-- duplicate the `recommendation` table, which already keeps what was advised for grading.
CREATE TABLE cached_recommendation (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  event_id      INTEGER NOT NULL,
  entry_id      INTEGER,
  model_version TEXT    NOT NULL,
  -- Fingerprint of every input the projections read. Any change invalidates the page.
  data_stamp    TEXT    NOT NULL,
  generated_at  INTEGER NOT NULL,
  payload_json  TEXT    NOT NULL
);
