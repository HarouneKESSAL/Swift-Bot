CREATE TABLE IF NOT EXISTS exp (
    userID integer PRIMARY KEY,
    XP integer DEFAULT 0,
    level integer DEFAULT 0,
    XPlock text DEFAULT CURRENT_TIMESTAMP
);