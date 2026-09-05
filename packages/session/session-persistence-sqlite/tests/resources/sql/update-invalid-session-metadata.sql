UPDATE sessions
SET delegation_depth = -1, seed_length = -1
WHERE id = ?;
