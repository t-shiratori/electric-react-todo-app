-- Create todos table
CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  task TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Insert sample data
INSERT INTO todos (task, completed) VALUES
  ('Learn Electric SQL', false),
  ('Build a todo app', false),
  ('Deploy to production', false);
