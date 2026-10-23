-- Set-piece duty, as each club publishes it: 1 is first choice, null means not on the list.
--
-- Free in bootstrap-static all along, and read by nothing. It matters most where the match
-- history cannot help: a player's expected goals already contain the penalties he has taken, so
-- for a settled taker this adds little - but for one who has just been given the job, his own
-- record understates him and goes on understating him for weeks, which is precisely the window
-- a transfer gets decided in.
--
-- Stored per snapshot rather than per player because it changes during a season, and a replay
-- of an earlier gameweek must see what was true then rather than what is true now.
ALTER TABLE player_snapshot ADD COLUMN penalties_order INTEGER;
ALTER TABLE player_snapshot ADD COLUMN direct_freekicks_order INTEGER;
ALTER TABLE player_snapshot ADD COLUMN corners_order INTEGER;
