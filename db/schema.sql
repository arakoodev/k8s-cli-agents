-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Session table to track active jobs and their owners
CREATE UNLOGGED TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_user_id   TEXT NOT NULL,
    job_name        TEXT NOT NULL UNIQUE,
    pod_name        TEXT,
    pod_ip          TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- JTI table for one-time JWT validation
CREATE UNLOGGED TABLE IF NOT EXISTS token_jti (
    jti             TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jti_expires ON token_jti(expires_at);

-- Opportunistic cleanup trigger on every write
CREATE OR REPLACE FUNCTION prune_expired_rows()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  DELETE FROM token_jti WHERE expires_at < now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_prune_expired_sessions
AFTER INSERT OR UPDATE ON sessions
FOR EACH STATEMENT EXECUTE FUNCTION prune_expired_rows();

CREATE OR REPLACE TRIGGER trigger_prune_expired_jti
AFTER INSERT OR UPDATE ON token_jti
FOR EACH STATEMENT EXECUTE FUNCTION prune_expired_rows();