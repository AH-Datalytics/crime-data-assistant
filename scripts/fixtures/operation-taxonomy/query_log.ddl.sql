CREATE TABLE query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        question TEXT,
        sql TEXT,
        rows INTEGER,
        error TEXT,
        ms INTEGER,
        response TEXT
      , tab TEXT, session_id TEXT, guardrails TEXT, model TEXT, routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT, query_guidance TEXT, query_contract TEXT);
CREATE TABLE visitor_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      referrer TEXT,
      referrer_domain TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      landing_page TEXT,
      tab TEXT,
      event TEXT DEFAULT 'pageview',
      screen_width INTEGER,
      user_agent TEXT
    , ip TEXT, city TEXT, region TEXT, country TEXT);
CREATE INDEX idx_visitor_ts ON visitor_log(ts);
CREATE INDEX idx_visitor_referrer ON visitor_log(referrer_domain);
CREATE TABLE shared_charts (
        id TEXT PRIMARY KEY,
        tab TEXT NOT NULL,
        title TEXT,
        sql TEXT NOT NULL,
        chart_config TEXT,
        chart_meta TEXT,
        created_at INTEGER NOT NULL
      );
CREATE TABLE scoreboard_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_ts TEXT NOT NULL,
      host TEXT,
      mode TEXT,
      total INTEGER,
      passed INTEGER,
      failed INTEGER,
      inconclusive INTEGER,
      accuracy REAL,
      failed_ids TEXT,
      inconclusive_ids TEXT,
      json_path TEXT
    );
CREATE TABLE resolver_warning_classification (
        fingerprint TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        warning_code TEXT NOT NULL,
        warning_text TEXT NOT NULL,
        sql_shape TEXT NOT NULL,
        sample_question TEXT,
        sample_sql TEXT,
        sample_session_id TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        classification TEXT NOT NULL DEFAULT 'unclassified',
        whitelist_rule TEXT,
        review_notes TEXT,
        reviewed_at INTEGER
      );
CREATE INDEX idx_resolver_warning_last_seen
        ON resolver_warning_classification(last_seen);
CREATE INDEX idx_resolver_warning_classification
        ON resolver_warning_classification(classification);
CREATE TABLE audit_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_log_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    finding TEXT NOT NULL,
    proposed_fix TEXT,
    status TEXT DEFAULT 'open'
  );
CREATE UNIQUE INDEX idx_audit_findings_unique ON audit_findings (query_log_id, category);