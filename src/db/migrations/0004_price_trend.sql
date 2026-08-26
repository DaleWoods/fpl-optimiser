-- Net transfers this gameweek, so a player's price trend can be surfaced as a soft, informational
-- signal - "trending up/down in price" - rather than something invented from ownership alone.
-- Comes straight from bootstrap-static, same as every other player_snapshot column.

ALTER TABLE player_snapshot ADD COLUMN transfers_in_event  INTEGER;
ALTER TABLE player_snapshot ADD COLUMN transfers_out_event INTEGER;
