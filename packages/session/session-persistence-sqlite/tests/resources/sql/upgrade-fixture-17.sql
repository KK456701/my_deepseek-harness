INSERT INTO persistence_state VALUES (1, 'c0c5cf85-6903-47e0-812d-3166fd37df1b');
INSERT INTO sessions VALUES ('root', 0, 1, NULL, NULL, NULL, NULL, 0, NULL, 'c0c5cf85-6903-47e0-812d-3166fd37df1b', 7);
INSERT INTO sessions VALUES ('child', 0, 2, NULL, 'root', 1, 'subagent', 1, NULL, 'c0c5cf85-6903-47e0-812d-3166fd37df1b', 2);
INSERT INTO events VALUES ('root', 0, 'text-chunks', 1, '{"turn":1,"step":1,"index":0,"dt":[1,1],"texts":["你","好","！"]}', NULL, NULL, 0);
