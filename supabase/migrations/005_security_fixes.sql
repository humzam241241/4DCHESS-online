-- Atomic ranking point deduction for marketplace purchases (prevents race condition)
CREATE OR REPLACE FUNCTION deduct_ranking_points(target_user UUID, amount INT)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE profiles
    SET ranking_points = ranking_points - amount
    WHERE id = target_user AND ranking_points >= amount;
  RETURN FOUND;
END;
$$;

-- Decrement follower/following counters (missing from unfollow flow)
CREATE OR REPLACE FUNCTION decrement_followers(target_user UUID)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE profiles SET followers_count = GREATEST(0, followers_count - 1) WHERE id = target_user;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_following(target_user UUID)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE profiles SET following_count = GREATEST(0, following_count - 1) WHERE id = target_user;
END;
$$;
