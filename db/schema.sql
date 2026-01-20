CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  headline TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
