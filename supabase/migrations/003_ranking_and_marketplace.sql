-- ==================== RANKING POINTS ====================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ranking_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS followers_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS following_count INTEGER NOT NULL DEFAULT 0;

-- Add placement column to players table
ALTER TABLE players ADD COLUMN IF NOT EXISTS placement TEXT; -- 'gold', 'silver', 'bronze', 'fourth'

-- Must drop first because the return type changed (added ranking_points column)
DROP FUNCTION IF EXISTS get_leaderboard();

-- Recreate leaderboard function with ranking_points
CREATE OR REPLACE FUNCTION get_leaderboard()
RETURNS TABLE(
  user_id UUID,
  display_name TEXT,
  avatar_url TEXT,
  games_played BIGINT,
  wins BIGINT,
  win_rate NUMERIC,
  ranking_points INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pr.id AS user_id,
    pr.display_name,
    pr.avatar_url,
    COUNT(DISTINCT g.id) AS games_played,
    COUNT(DISTINCT g.id) FILTER (WHERE g.winner = pl.color) AS wins,
    ROUND(
      COUNT(DISTINCT g.id) FILTER (WHERE g.winner = pl.color)::NUMERIC
      / NULLIF(COUNT(DISTINCT g.id), 0) * 100, 1
    ) AS win_rate,
    pr.ranking_points
  FROM profiles pr
  JOIN players pl ON pl.user_id = pr.id
  JOIN games g ON g.id = pl.game_id AND g.status = 'finished'
  GROUP BY pr.id, pr.display_name, pr.avatar_url, pr.ranking_points
  ORDER BY pr.ranking_points DESC, wins DESC, win_rate DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==================== MARKETPLACE ====================

-- User-created content (board themes, piece skins)
CREATE TABLE IF NOT EXISTS marketplace_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  item_type TEXT NOT NULL, -- 'board_theme', 'piece_skin', 'board_set'
  preview_url TEXT,
  asset_data JSONB,
  price INTEGER NOT NULL DEFAULT 0, -- 0 = free, otherwise ranking points cost
  downloads INTEGER NOT NULL DEFAULT 0,
  rating NUMERIC(3,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User purchases/downloads
CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  item_id UUID REFERENCES marketplace_items(id) ON DELETE CASCADE,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, item_id)
);

-- Ratings/reviews
CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  item_id UUID REFERENCES marketplace_items(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, item_id)
);

-- Social: direct messages
CREATE TABLE IF NOT EXISTS direct_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  receiver_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Social: follows
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  following_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

-- Social: activity feed
CREATE TABLE IF NOT EXISTS activity_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL, -- 'published_item', 'won_game', 'reviewed_item', 'followed_user'
  target_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== RLS ====================
ALTER TABLE marketplace_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_feed ENABLE ROW LEVEL SECURITY;

-- Public read for approved marketplace items
CREATE POLICY "Approved items are public" ON marketplace_items
  FOR SELECT USING (status = 'approved');

-- Creators can see their own items (any status)
CREATE POLICY "Creators see own items" ON marketplace_items
  FOR SELECT USING (creator_id = auth.uid());

-- Authenticated users can insert items
CREATE POLICY "Users can create items" ON marketplace_items
  FOR INSERT WITH CHECK (creator_id = auth.uid());

-- Users can read their own messages
CREATE POLICY "Users read own messages" ON direct_messages
  FOR SELECT USING (sender_id = auth.uid() OR receiver_id = auth.uid());

-- Users can send messages
CREATE POLICY "Users send messages" ON direct_messages
  FOR INSERT WITH CHECK (sender_id = auth.uid());

-- Follows are public
CREATE POLICY "Follows are public" ON follows FOR SELECT USING (true);
CREATE POLICY "Users manage own follows" ON follows
  FOR INSERT WITH CHECK (follower_id = auth.uid());

-- Activity feed is public
CREATE POLICY "Feed is public" ON activity_feed FOR SELECT USING (true);

-- Reviews are public
CREATE POLICY "Reviews are public" ON marketplace_reviews FOR SELECT USING (true);
CREATE POLICY "Users create reviews" ON marketplace_reviews
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Purchases private to user
CREATE POLICY "Users see own purchases" ON marketplace_purchases
  FOR SELECT USING (user_id = auth.uid());

-- Indexes
CREATE INDEX IF NOT EXISTS idx_marketplace_items_status ON marketplace_items(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_creator ON marketplace_items(creator_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_receiver ON direct_messages(receiver_id, read);
CREATE INDEX IF NOT EXISTS idx_activity_feed_user ON activity_feed(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_ranking ON profiles(ranking_points DESC);

-- ==================== RPC HELPER FUNCTIONS ====================

-- Increment follower count for a user
CREATE OR REPLACE FUNCTION increment_followers(target_user UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles
  SET followers_count = COALESCE(followers_count, 0) + 1
  WHERE id = target_user;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment following count for a user
CREATE OR REPLACE FUNCTION increment_following(target_user UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles
  SET following_count = COALESCE(following_count, 0) + 1
  WHERE id = target_user;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Decrement follower count (for unfollow)
CREATE OR REPLACE FUNCTION decrement_followers(target_user UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles
  SET followers_count = GREATEST(COALESCE(followers_count, 0) - 1, 0)
  WHERE id = target_user;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Decrement following count (for unfollow)
CREATE OR REPLACE FUNCTION decrement_following(target_user UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles
  SET following_count = GREATEST(COALESCE(following_count, 0) - 1, 0)
  WHERE id = target_user;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
