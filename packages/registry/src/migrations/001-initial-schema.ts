export const INITIAL_SCHEMA_VERSION = 1 as const;

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE skills (
  skill_id TEXT NOT NULL PRIMARY KEY,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  current_version_hash TEXT NOT NULL,
  UNIQUE (namespace, name),
  CHECK (skill_id = namespace || '/' || name),
  FOREIGN KEY (skill_id, current_version_hash)
    REFERENCES skill_versions (skill_id, version_hash)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE skill_versions (
  skill_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  l1_status TEXT NOT NULL CHECK (l1_status IN ('AUTHORED', 'MISSING')),
  l2_size_class TEXT NOT NULL CHECK (l2_size_class IN ('NORMAL', 'LARGE', 'OVERSIZED')),
  trust_level TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (trust_level IN ('OWNED', 'EXTERNAL', 'UNKNOWN')),
  PRIMARY KEY (skill_id, version_hash),
  FOREIGN KEY (skill_id)
    REFERENCES skills (skill_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE skill_files (
  skill_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  role TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_kind TEXT NOT NULL CHECK (content_kind IN ('TEXT', 'BINARY')),
  PRIMARY KEY (skill_id, version_hash, path),
  FOREIGN KEY (skill_id, version_hash)
    REFERENCES skill_versions (skill_id, version_hash)
);

CREATE TABLE token_counts (
  blob_hash TEXT NOT NULL,
  estimator_id TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  PRIMARY KEY (blob_hash, estimator_id)
);

CREATE TABLE skill_aliases (
  alias TEXT NOT NULL PRIMARY KEY,
  skill_id TEXT NOT NULL,
  FOREIGN KEY (skill_id)
    REFERENCES skills (skill_id)
);

CREATE TABLE skill_sources (
  source_id INTEGER PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  source_type TEXT NOT NULL,
  local_path TEXT,
  repository TEXT,
  commit_sha TEXT,
  repository_path TEXT,
  FOREIGN KEY (skill_id, version_hash)
    REFERENCES skill_versions (skill_id, version_hash)
);

CREATE INDEX idx_skills_name
  ON skills (name);
CREATE INDEX idx_skill_versions_version_hash
  ON skill_versions (version_hash);
CREATE INDEX idx_skill_files_blob_hash
  ON skill_files (blob_hash);
CREATE INDEX idx_skill_aliases_skill_id
  ON skill_aliases (skill_id);
CREATE INDEX idx_skill_sources_version
  ON skill_sources (skill_id, version_hash);

CREATE VIRTUAL TABLE skill_fts USING fts5(
  skill_id UNINDEXED,
  version_hash UNINDEXED,
  name,
  description,
  domains,
  platforms,
  frameworks,
  triggers,
  aliases,
  tokenize = 'unicode61 remove_diacritics 1'
);
`;
