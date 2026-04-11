-- Allow NULL dice values on move records.
-- Enochian and AoW games have no dice, and recordMove was inserting NULL
-- into these NOT NULL columns, causing the insert to fail. The game state
-- was still committed by updateGameState (which runs first), leaving the
-- player seeing a "Server error" toast even though the move had persisted
-- — it only became visible after a refresh.
ALTER TABLE moves ALTER COLUMN dice_1 DROP NOT NULL;
ALTER TABLE moves ALTER COLUMN dice_2 DROP NOT NULL;
