SELECT id, version, created_at, cwd, parent_session, seed_length, purpose,
       delegation_depth, agent_preset, incarnation, revision
FROM sessions
WHERE id = ?;
