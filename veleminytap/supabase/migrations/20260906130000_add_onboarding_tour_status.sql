-- First-time dashboard onboarding tour: server-side persisted state, not
-- localStorage -- must survive a different device/browser, and must be
-- readable server-side so the dashboard layout can decide whether to show
-- it before the client ever renders.
--
-- Scoped to the ORGANIZATION, not the user. Rationale: the tour explains
-- the dashboard's own areas and nudges toward "create your first location"
-- -- that's a fact about whether the ORGANIZATION has been introduced to
-- the product, not about one person's individual familiarity with it. If a
-- future invite flow ships (see DECISIONS.md's "no invite flow yet" note),
-- a newly-invited teammate joining an already-set-up organization should
-- not be told to create a first location that already exists. This also
-- matches the existing convention for other org-level configuration on
-- this table (notification_email, logo_url) -- not per-member.
--
-- Same reasoning as every other status/enum column in this schema
-- (locations.status, nfc_cards.status, feedback.status): a plain text
-- column with an explicit CHECK constraint, not an app-trusted value
-- inside the existing settings jsonb column -- database-level integrity
-- regardless of what the application sends.
alter table public.organizations
  add column onboarding_tour_status text not null default 'not_started'
  check (onboarding_tour_status in ('not_started', 'completed', 'skipped'));

-- Backfill: every organization that already exists at the moment this
-- migration applies must never have the tour appear unprompted the next
-- time someone signs in -- mark them as already past it. This UPDATE (no
-- WHERE clause) only ever touches rows that exist AT THIS INSTANT; the
-- column's own DEFAULT above is what applies to every row inserted after
-- this migration runs (i.e. every organization create_organization_atomic
-- creates from here on), so newly-created organizations remain eligible
-- without this migration needing to know anything about that function.
update public.organizations set onboarding_tour_status = 'completed';
