-- ==================== CHATURAJI — SUPABASE MIGRATION ====================
-- Run this in the Supabase SQL editor or via: supabase db push

-- ==================== PROFILES ====================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT,
  has_lifetime_access BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_status TEXT NOT NULL DEFAULT 'none', -- 'none' | 'active' | 'cancelled'
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create profile on Google sign-in
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ==================== GAMES ====================
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  game_type TEXT NOT NULL DEFAULT 'classic',
  is_ranked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  winner TEXT,
  state JSONB,
  turn_number INTEGER DEFAULT 1
);

-- ==================== PLAYERS ====================
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  color TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  socket_id TEXT,
  connected BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(game_id, color)
);

-- ==================== MOVES ====================
CREATE TABLE IF NOT EXISTS moves (
  id SERIAL PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  player_color TEXT NOT NULL,
  piece_type TEXT NOT NULL,
  from_row INTEGER NOT NULL,
  from_col INTEGER NOT NULL,
  to_row INTEGER NOT NULL,
  to_col INTEGER NOT NULL,
  captured_type TEXT,
  captured_color TEXT,
  dice_1 TEXT NOT NULL,
  dice_2 TEXT NOT NULL,
  notation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== CHAT ====================
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_color TEXT,
  player_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== INDICES ====================
CREATE INDEX IF NOT EXISTS idx_games_code   ON games(code);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);
CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_moves_game   ON moves(game_id);
CREATE INDEX IF NOT EXISTS idx_chat_game    ON chat_messages(game_id);

-- ==================== LEADERBOARD FUNCTION ====================
-- Called via supabase.rpc('get_leaderboard')
CREATE OR REPLACE FUNCTION get_leaderboard()
RETURNS TABLE (
  user_id UUID,
  display_name TEXT,
  avatar_url TEXT,
  games_played BIGINT,
  wins BIGINT,
  win_rate NUMERIC
)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT
    pr.id AS user_id,
    pr.display_name,
    pr.avatar_url,
    COUNT(DISTINCT p.game_id) AS games_played,
    COUNT(DISTINCT CASE WHEN g.winner = p.color THEN p.game_id END) AS wins,
    ROUND(
      COUNT(DISTINCT CASE WHEN g.winner = p.color THEN p.game_id END)::NUMERIC
        / NULLIF(COUNT(DISTINCT p.game_id), 0) * 100,
      1
    ) AS win_rate
  FROM profiles pr
  JOIN players p ON p.user_id = pr.id
  JOIN games g ON p.game_id = g.id
  WHERE g.status = 'finished'
    AND p.user_id IS NOT NULL
  GROUP BY pr.id, pr.display_name, pr.avatar_url
  ORDER BY wins DESC, win_rate DESC
  LIMIT 50;
$$;

-- ==================== ROW LEVEL SECURITY ====================
ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE games         ENABLE ROW LEVEL SECURITY;
ALTER TABLE players       ENABLE ROW LEVEL SECURITY;
ALTER TABLE moves         ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Public read (lobby, game list)
CREATE POLICY "Public read games"   ON games         FOR SELECT USING (true);
CREATE POLICY "Public read players" ON players       FOR SELECT USING (true);
CREATE POLICY "Public read moves"   ON moves         FOR SELECT USING (true);
CREATE POLICY "Public read chat"    ON chat_messages FOR SELECT USING (true);

-- Profiles: everyone can read (leaderboard), only own user can update
CREATE POLICY "Public read profiles"      ON profiles FOR SELECT USING (true);
CREATE POLICY "Users update own profile"  ON profiles FOR UPDATE USING (auth.uid() = id);

-- Backend uses service_role key → bypasses RLS for all writes
