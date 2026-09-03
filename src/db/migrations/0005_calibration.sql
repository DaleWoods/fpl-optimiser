-- What the model learned from its own error, per position.
--
-- The accuracy tables have always measured bias per position and nothing has ever read it. This
-- is what does: a bounded multiplicative correction, recomputed as gameweeks are graded.
--
-- Stamped with the model version it was measured against, because a factor learned from
-- heuristic-0.15.0's mistakes says nothing useful about heuristic-0.17.0 - silently carrying it
-- over would be correcting a model that no longer exists. A version bump therefore resets the
-- learning, which is intended rather than a gap.
CREATE TABLE calibration_factor (
  model_version   TEXT    NOT NULL,
  position        TEXT    NOT NULL,
  factor          REAL    NOT NULL,   -- multiplier applied to xPts; 1.0 is no correction
  observed_bias   REAL    NOT NULL,   -- mean signed error it was derived from, positive = high
  sample_players  INTEGER NOT NULL,   -- graded projections behind it
  gameweeks       INTEGER NOT NULL,   -- graded gameweeks behind it
  computed_at     INTEGER NOT NULL,

  PRIMARY KEY (model_version, position)
);

-- The projection before any calibration was applied.
--
-- This is what the next correction is measured against. The calibrated xpts beside it stays the
-- number the Accuracy page grades, because that is the number the page actually showed and so
-- the honest record of what was advised. Measuring a correction against already-corrected output
-- would make a working correction look unnecessary and revert it, and the model would oscillate
-- between corrected and uncorrected forever.
ALTER TABLE projection ADD COLUMN xpts_uncalibrated REAL;
