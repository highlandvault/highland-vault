-- 0008_draws
--
-- Draws, their prizes (one per winner position) and skill questions
-- (ADR-0004, Revision 2 B8, B14 lifecycle, D-1).
--
-- Invariants enforced here, independently of the API:
--   1. A draw belongs to exactly one market, and its currency is pinned to that
--      market by the composite FK (market_id, currency) → markets (id, currency).
--   2. A draw's skill question belongs to the same market: composite FK
--      (skill_question_id, market_id) → skill_questions (id, market_id).
--   3. UNIQUE (id, market_id) is the target for order_items (Phase 5), so an
--      order can never contain another market's draw.
--   4. The slug is unique per market.
--   5. Money is integer minor units; capacity, cap and positions are positive
--      and consistent (cap ≤ capacity, positions ≤ capacity); opens_at < closes_at.
--   6. Status changes follow the lifecycle only:
--        draft → scheduled → live → closed → settled → completed
--        draft | scheduled → cancelled
--      Cancelling a live draw is OPEN (O6) and therefore refused.
--      scheduled → live needs opens_at ≤ now(); live → closed needs closes_at ≤ now().
--   7. Publishing (draft → scheduled) needs a skill question with at least two
--      options and exactly one correct option, one prize for every winner
--      position 1..winner_positions, and a closing time in the future.
--   8. Once a draw leaves draft, its configuration, prizes and skill question
--      are immutable (changing them after publish is a "major configuration
--      change", OPEN O9).
--
-- The ticket pool (Phase 4), settlement (Phase 9) and instant wins (Phase 8)
-- are not part of this migration.

CREATE TABLE skill_questions (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  market_id  uuid        NOT NULL REFERENCES markets (id),
  prompt     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT skill_questions_id_market_key UNIQUE (id, market_id),
  CONSTRAINT skill_questions_prompt_length CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 500)
);

CREATE TRIGGER skill_questions_set_updated_at
  BEFORE UPDATE ON skill_questions
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

CREATE TABLE skill_question_options (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  skill_question_id uuid        NOT NULL REFERENCES skill_questions (id),
  position          smallint    NOT NULL,
  label             text        NOT NULL,
  is_correct        boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT skill_question_options_position_key UNIQUE (skill_question_id, position),
  CONSTRAINT skill_question_options_position_range CHECK (position BETWEEN 1 AND 10),
  CONSTRAINT skill_question_options_label_length CHECK (char_length(btrim(label)) BETWEEN 1 AND 200)
);

-- At most one correct option per question; "at least one" is checked at publish.
CREATE UNIQUE INDEX skill_question_options_one_correct
  ON skill_question_options (skill_question_id) WHERE is_correct;

CREATE TABLE draws (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  market_id          uuid        NOT NULL,
  currency           text        NOT NULL,
  slug               text        NOT NULL,
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  status             text        NOT NULL DEFAULT 'draft',
  ticket_price_minor bigint      NOT NULL,
  total_tickets      integer     NOT NULL,
  max_per_person     integer     NOT NULL,
  winner_positions   smallint    NOT NULL,
  opens_at           timestamptz NOT NULL,
  closes_at          timestamptz NOT NULL,
  skill_question_id  uuid,
  published_at       timestamptz,
  closed_at          timestamptz,
  cancelled_at       timestamptz,
  created_by         uuid        REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT draws_market_currency_fkey
    FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency),
  CONSTRAINT draws_skill_question_same_market_fkey
    FOREIGN KEY (skill_question_id, market_id) REFERENCES skill_questions (id, market_id),
  CONSTRAINT draws_id_market_key UNIQUE (id, market_id),
  CONSTRAINT draws_market_slug_key UNIQUE (market_id, slug),

  CONSTRAINT draws_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 80),
  CONSTRAINT draws_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT draws_description_length CHECK (char_length(description) <= 10000),
  CONSTRAINT draws_status_valid CHECK (
    status IN ('draft', 'scheduled', 'live', 'closed', 'settled', 'completed', 'cancelled')
  ),
  CONSTRAINT draws_ticket_price_positive CHECK (ticket_price_minor > 0),
  CONSTRAINT draws_total_tickets_positive CHECK (total_tickets > 0),
  CONSTRAINT draws_max_per_person_valid CHECK (max_per_person > 0 AND max_per_person <= total_tickets),
  CONSTRAINT draws_winner_positions_valid CHECK (winner_positions > 0 AND winner_positions <= total_tickets),
  CONSTRAINT draws_opens_before_closes CHECK (opens_at < closes_at),
  -- Anything published carries its publication time and a skill question.
  CONSTRAINT draws_published_complete CHECK (
    status IN ('draft', 'cancelled') OR (published_at IS NOT NULL AND skill_question_id IS NOT NULL)
  ),
  CONSTRAINT draws_cancelled_at_consistent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT draws_closed_at_consistent CHECK (
    (status IN ('closed', 'settled', 'completed')) = (closed_at IS NOT NULL)
  )
);

CREATE INDEX draws_market_status_idx ON draws (market_id, status, closes_at);
CREATE INDEX draws_lifecycle_due_idx ON draws (status, opens_at, closes_at)
  WHERE status IN ('scheduled', 'live');

CREATE TRIGGER draws_set_updated_at
  BEFORE UPDATE ON draws
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

CREATE TABLE draw_prizes (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  draw_id     uuid        NOT NULL REFERENCES draws (id),
  position    smallint    NOT NULL,
  title       text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- One prize per winner position.
  CONSTRAINT draw_prizes_draw_position_key UNIQUE (draw_id, position),
  CONSTRAINT draw_prizes_position_positive CHECK (position >= 1),
  CONSTRAINT draw_prizes_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT draw_prizes_description_length CHECK (char_length(description) <= 2000)
);

CREATE TRIGGER draw_prizes_set_updated_at
  BEFORE UPDATE ON draw_prizes
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

-- Why a draw cannot be published yet (empty array = publishable), evaluated for
-- the given values, so the publish trigger can check the row as it will be
-- written. The single definition shared by the trigger and the API.
CREATE FUNCTION hv_draw_publish_blockers(
  p_draw_id uuid,
  p_skill_question_id uuid,
  p_winner_positions smallint,
  p_closes_at timestamptz
) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN p_skill_question_id IS NULL THEN 'skill_question_missing' END,
    CASE WHEN p_skill_question_id IS NOT NULL AND (
           (SELECT count(*) FROM skill_question_options o WHERE o.skill_question_id = p_skill_question_id) < 2
        OR (SELECT count(*) FROM skill_question_options o
             WHERE o.skill_question_id = p_skill_question_id AND o.is_correct) <> 1
         ) THEN 'skill_question_incomplete' END,
    CASE WHEN (SELECT count(*) FROM draw_prizes p WHERE p.draw_id = p_draw_id) <> p_winner_positions
           OR EXISTS (SELECT 1 FROM draw_prizes p WHERE p.draw_id = p_draw_id AND p.position > p_winner_positions)
         THEN 'prizes_incomplete' END,
    CASE WHEN p_closes_at <= now() THEN 'closes_at_in_past' END
  ], NULL);
$$;

-- Blockers for a stored draw.
CREATE FUNCTION hv_draw_publish_blockers(p_draw_id uuid) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT hv_draw_publish_blockers(d.id, d.skill_question_id, d.winner_positions, d.closes_at)
    FROM draws d
   WHERE d.id = p_draw_id;
$$;

CREATE FUNCTION hv_draws_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  blockers text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a draw is created as draft, not %', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_created_as_draft';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status, NEW.status) IN (
         ('draft', 'scheduled'), ('scheduled', 'live'), ('live', 'closed'),
         ('closed', 'settled'), ('settled', 'completed'),
         ('draft', 'cancelled'), ('scheduled', 'cancelled')
       )
     ) THEN
    RAISE EXCEPTION 'draw status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_status_transition';
  END IF;

  IF OLD.status <> 'draft' AND ROW(
       NEW.market_id, NEW.currency, NEW.slug, NEW.ticket_price_minor, NEW.total_tickets,
       NEW.max_per_person, NEW.winner_positions, NEW.opens_at, NEW.closes_at, NEW.skill_question_id
     ) IS DISTINCT FROM ROW(
       OLD.market_id, OLD.currency, OLD.slug, OLD.ticket_price_minor, OLD.total_tickets,
       OLD.max_per_person, OLD.winner_positions, OLD.opens_at, OLD.closes_at, OLD.skill_question_id
     ) THEN
    RAISE EXCEPTION 'draw "%" is %: its configuration can no longer change', OLD.slug, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_configuration_locked';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'scheduled' THEN
    -- Evaluated for the row as it will be written, not the stored one.
    blockers := hv_draw_publish_blockers(NEW.id, NEW.skill_question_id, NEW.winner_positions, NEW.closes_at);
    IF cardinality(blockers) > 0 THEN
      RAISE EXCEPTION 'draw "%" cannot be published: %', NEW.slug, array_to_string(blockers, ', ')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_publish_requirements',
              DETAIL = array_to_string(blockers, ',');
    END IF;
  END IF;

  IF OLD.status = 'scheduled' AND NEW.status = 'live' AND NEW.opens_at > now() THEN
    RAISE EXCEPTION 'draw "%" cannot go live before it opens', NEW.slug
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_opens_at_not_reached';
  END IF;

  IF OLD.status = 'live' AND NEW.status = 'closed' AND NEW.closes_at > now() THEN
    RAISE EXCEPTION 'draw "%" cannot close before its closing time', NEW.slug
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_closes_at_not_reached';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER draws_guard
  BEFORE INSERT OR UPDATE ON draws
  FOR EACH ROW EXECUTE FUNCTION hv_draws_guard();

-- Prizes change only while their draw is a draft. The draw row is locked so a
-- concurrent publish cannot interleave with a prize change.
CREATE FUNCTION hv_draw_prizes_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  draw_status text;
BEGIN
  SELECT d.status INTO draw_status
    FROM draws d
   WHERE d.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.draw_id ELSE NEW.draw_id END
     FOR SHARE;
  IF TG_OP = 'UPDATE' AND NEW.draw_id <> OLD.draw_id THEN
    RAISE EXCEPTION 'draw_prizes.draw_id is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draw_prizes_draw_immutable';
  END IF;
  IF draw_status <> 'draft' THEN
    RAISE EXCEPTION 'prizes of a % draw cannot change', draw_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_configuration_locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER draw_prizes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON draw_prizes
  FOR EACH ROW EXECUTE FUNCTION hv_draw_prizes_guard();

-- A skill question used by any draw that has left draft is frozen. The using
-- draws are locked so a concurrent publish cannot interleave.
CREATE FUNCTION hv_skill_question_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  question_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'skill_questions' THEN
    question_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP = 'UPDATE' AND NEW.market_id <> OLD.market_id THEN
      RAISE EXCEPTION 'skill_questions.market_id is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_questions_market_immutable';
    END IF;
  ELSE
    question_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.skill_question_id ELSE NEW.skill_question_id END;
    IF TG_OP = 'UPDATE' AND NEW.skill_question_id <> OLD.skill_question_id THEN
      RAISE EXCEPTION 'skill_question_options.skill_question_id is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_question_options_question_immutable';
    END IF;
  END IF;

  PERFORM 1 FROM draws d WHERE d.skill_question_id = question_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM draws d WHERE d.skill_question_id = question_id AND d.status <> 'draft') THEN
    RAISE EXCEPTION 'skill question is used by a published draw and cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draws_configuration_locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER skill_questions_guard
  BEFORE UPDATE OR DELETE ON skill_questions
  FOR EACH ROW EXECUTE FUNCTION hv_skill_question_guard();

CREATE TRIGGER skill_question_options_guard
  BEFORE INSERT OR UPDATE OR DELETE ON skill_question_options
  FOR EACH ROW EXECUTE FUNCTION hv_skill_question_guard();

-- Draws are cancelled, never deleted.
REVOKE DELETE, TRUNCATE ON draws FROM hv_app;

COMMENT ON TABLE draws IS
  'Competitions. One market each (ADR-0004); currency pinned to the market; lifecycle enforced by hv_draws_guard().';
COMMENT ON TABLE draw_prizes IS
  'One prize per winner position (UNIQUE draw_id, position). Frozen once the draw is published.';
COMMENT ON TABLE skill_questions IS
  'Skill questions, owned by a market. Correct answers are never exposed by customer APIs.';
