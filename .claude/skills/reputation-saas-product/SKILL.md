---
name: reputation-saas-product
description: >-
  Product and architecture rules for the NFC-based customer feedback and reputation management SaaS.
  Use this skill whenever working on product decisions, Next.js architecture, Supabase, PostgreSQL,
  authentication, RLS, organizations, locations, NFC cards, feedback collection, public rating pages,
  Google Review flows, dashboards, analytics, notifications, manager workflows, UI/UX, APIs, security,
  testing, refactoring, implementation planning, or any other feature of this SaaS.
---

# Reputation Management SaaS

This project is an NFC-based customer feedback and reputation management SaaS.

Treat the rules in this skill as product requirements, not optional suggestions.

When relevant, also use these installed project skills:

- supabase
- supabase-postgres-best-practices
- vercel-react-best-practices
- shadcn
- frontend-design
- web-design-guidelines
- webapp-testing

If a generic recommendation conflicts with a product requirement defined here, follow this product skill.

# Product Goal

Build a polished SaaS platform for physical businesses to collect first-party customer feedback through NFC cards, understand customer satisfaction, respond to problems, and improve their reputation.

Core customer flow:

1. Customer taps an NFC card.
2. A fast, branded, mobile-first landing page opens.
3. Customer selects a rating from 1 to 5 stars.
4. Customer may provide written feedback.
5. Feedback is stored in the business dashboard.
6. A Google Review CTA is available to the customer.
7. Business users can analyze, manage, respond to, and resolve feedback.

Target customers may include restaurants, hotels, salons, gyms, clinics, retail stores, service businesses, and other physical businesses.

# Critical Rule: Never Implement Review Gating

NEVER implement review gating.

The Google Review CTA must be available regardless of whether the customer selects:

- 1 star
- 2 stars
- 3 stars
- 4 stars
- 5 stars

Never:

- hide Google Review for low ratings
- show Google Review only for positive ratings
- redirect only positive customers to Google
- keep negative customers inside an internal-only feedback flow
- condition Google Review visibility on rating
- condition Google Review visibility on sentiment
- condition Google Review visibility on AI analysis
- create separate positive and negative funnels that suppress public review opportunities
- make the Google Review CTA materially harder to discover for low ratings

Internal first-party feedback and public Google Reviews are separate actions.

Low ratings may trigger internal alerts, prioritization, escalation, manager follow-up, or resolution workflows, but must NEVER reduce or remove the customer's opportunity to leave a Google Review.

Whenever modifying the public rating or review flow, explicitly verify the CTA for all five rating values.

# Core Stack

Prefer:

- Next.js
- TypeScript
- React
- Tailwind CSS
- shadcn/ui
- Supabase PostgreSQL
- Supabase Auth
- Supabase Row Level Security
- Vercel
- Resend

Later, when justified:

- Stripe
- Sentry
- AI feedback analysis, summarization, classification, and insights

Prefer simple and maintainable architecture.

Do not add dependencies, infrastructure, microservices, or abstractions without a clear product need.

# Multi-Tenant Model

Core hierarchy:

Organization
→ Locations
→ NFC Cards
→ Feedback

Users access organizations through memberships.

# Organizations

An organization represents a SaaS customer/business.

Typical fields:

- id
- name
- slug
- branding/settings
- created_at
- updated_at

# Organization Memberships

Use an explicit membership model connecting authenticated users to organizations.

Suggested MVP roles:

- owner
- admin
- manager
- staff

Avoid unnecessary enterprise RBAC during MVP.

# Locations

Each physical location belongs to exactly one organization.

Typical fields:

- id
- organization_id
- name
- address
- google_review_url or Google Place reference
- status
- created_at
- updated_at

An organization can have one or many locations.

Google Review configuration normally belongs to the location.

# NFC Cards

Each NFC card belongs to a location.

Typical fields:

- id
- organization_id
- location_id
- public_identifier
- display_name
- status
- created_at
- updated_at

Do not expose sequential internal database IDs in public URLs.

Use a safe public identifier.

Support multiple NFC cards per location.

This allows future analytics by:

- table
- room
- employee
- counter
- entrance
- placement
- campaign

Cards should support active/inactive state.

# Feedback

Feedback should reference:

- organization
- location
- NFC card
- rating
- optional feedback text
- status
- created_at
- updated_at

Rating must be constrained to values from 1 through 5.

Suggested MVP statuses:

- new
- in_progress
- resolved

Avoid building a complicated CRM workflow during MVP.

# Manager Workflow

Authorized dashboard users may:

- read feedback
- filter feedback
- change feedback status
- add internal notes or responses
- mark feedback resolved

Unless customer communication is explicitly implemented, manager responses are internal dashboard information.

# Security and Tenant Isolation

This is a multi-tenant SaaS.

Tenant isolation is a critical security boundary.

Organization A must NEVER be able to access Organization B's:

- locations
- NFC cards
- feedback
- memberships
- analytics
- notifications
- manager responses
- settings

Do not rely only on frontend filtering.

Use PostgreSQL Row Level Security for tenant-owned data.

For every tenant-owned table:

1. determine organization ownership
2. enable RLS
3. create appropriate policies
4. verify authorized access
5. verify cross-tenant reads fail
6. verify cross-tenant mutations fail
7. add indexes needed by RLS predicates and common queries

Prefer explicit and understandable RLS policies.

Treat cross-tenant data leakage as a critical severity bug.

Never expose the Supabase service role key in browser/client code.

Never expose privileged secrets through:

- NEXT_PUBLIC variables
- client bundles
- source control
- logs
- public API responses

Privileged operations belong server-side.

# Public NFC Landing Page

Public NFC landing pages intentionally work without authentication.

Customers must not need to:

- create an account
- sign in
- provide an email
- install an application

Target flow:

Tap NFC
→ page loads
→ select rating
→ optionally write feedback
→ submit
→ confirmation
→ Google Review CTA

Optimize primarily for mobile.

Prioritize:

- fast loading
- large touch targets
- obvious star selection
- minimal steps
- comfortable feedback input
- minimal scrolling
- clear submission confirmation
- clear Google Review CTA

Public access must NOT mean broad anonymous database permissions.

Prefer a narrowly scoped, validated server-side submission path such as:

- Next.js Server Action
- Route Handler/API endpoint
- secure Supabase RPC
- equivalent server-side mechanism

Validate:

- NFC public identifier
- card existence
- active card status
- associated organization
- associated location
- rating range
- feedback length
- input shape

Consider abuse prevention before production:

- rate limiting
- request throttling
- server-side validation
- bot protection when justified

Do not add excessive friction for legitimate customers.

# Google Review Integration

Use the Google Review destination belonging to the NFC card's location.

Never fabricate a Google Review URL.

Never automatically submit a Google Review.

The customer must intentionally choose to open Google and publish a review.

Handle missing or invalid Google Review configuration gracefully.

Do not report a Google Review CTA click as a completed Google Review unless the system can actually verify review completion.

Keep internal feedback analytics and Google Review analytics conceptually separate.

# Negative Feedback

Low ratings may trigger:

- prominent dashboard treatment
- unread indicators
- email alerts
- manager follow-up
- escalation
- resolution tracking

But:

NEGATIVE FEEDBACK MUST NEVER ALTER GOOGLE REVIEW AVAILABILITY.

# Dashboard MVP

Core dashboard areas should include:

## Overview

Useful metrics:

- total feedback
- average internal rating
- rating distribution
- feedback volume over time
- unresolved feedback
- recent feedback

Prioritize actionable metrics over vanity metrics.

## Feedback Inbox

Support:

- newest-first listing
- rating
- feedback text
- location
- NFC card source
- timestamp
- status
- filtering
- resolution workflow

Useful filters:

- rating
- location
- status
- date range

## Locations

Allow management of:

- location name
- address
- Google Review destination
- NFC cards
- feedback metrics

## NFC Cards

Allow users to:

- view cards
- identify the associated location
- activate/deactivate cards
- copy or open public NFC URLs
- distinguish multiple cards within the same location

## Analytics

Prioritize:

- feedback volume over time
- average rating trend
- rating distribution
- location comparisons
- NFC card performance
- resolved vs unresolved feedback

Do not build a full BI platform during MVP.

# Notifications

Important or negative feedback may trigger:

- dashboard notifications
- email through Resend
- future integrations

Notification behavior must never change the Google Review CTA.

Avoid excessive notifications.

# UI and UX

The product should feel like a premium modern SaaS, not a generic AI-generated admin template.

Prioritize:

- clean typography
- strong visual hierarchy
- consistent spacing
- restrained card usage
- useful whitespace
- responsive layouts
- polished mobile customer flow
- polished desktop dashboard
- clear loading states
- clear empty states
- useful error states

Avoid:

- excessive gradients
- unnecessary rounded floating cards
- giant marketing headings inside operational dashboard screens
- excessive animation
- decorative clutter
- random icon usage
- inconsistent spacing

Use shadcn/ui where appropriate, but do not force every UI element into a Card.

Design around the user's actual task.

# Accessibility

Use semantic HTML.

Use accessible form labels.

Preserve keyboard navigation.

Preserve visible focus states.

Do not communicate important meaning only through color.

Use sufficiently large mobile touch targets.

Use accessible dialogs, menus, forms, and notifications.

# Validation

Treat all client input as untrusted.

Validate server-side.

Use client-side validation to improve UX, not as a security boundary.

Use database constraints for critical invariants.

Examples:

- rating between 1 and 5
- foreign keys
- NOT NULL where appropriate
- uniqueness where appropriate

Do not rely only on TypeScript types for data integrity.

# Database Practices

Prefer normalized relational design unless denormalization has a demonstrated benefit.

Use:

- migrations
- foreign keys
- consistent timestamps
- appropriate identifiers
- database constraints
- indexes based on actual query patterns

Likely important query dimensions:

- organization_id
- location_id
- nfc_card_id
- rating
- status
- created_at

Consider RLS performance when adding indexes.

Never manually mutate production database structure when a migration should exist.

# Next.js Architecture

Use modern Next.js patterns.

Prefer Server Components where appropriate.

Use Client Components only where interactivity or browser APIs require them.

Perform privileged operations server-side.

Keep client bundles small.

Avoid unnecessary global state.

Prefer feature-oriented organization where useful.

Do not create abstractions before the project needs them.

Follow the existing repository structure if it is already coherent.

# Suggested Feature Areas

Possible feature organization:

features/
  auth/
  organizations/
  locations/
  nfc-cards/
  feedback/
  analytics/
  notifications/

Do not reorganize the entire repository without a clear reason.

# MVP Priorities

Build approximately in this order:

1. authentication
2. organizations and memberships
3. locations
4. NFC cards
5. public NFC landing page
6. feedback submission
7. feedback inbox
8. statuses and resolution
9. negative-feedback notifications
10. basic analytics
11. Google Review CTA
12. production deployment

Do not prematurely build:

- complex AI agents
- advanced CRM
- automation builders
- enterprise RBAC
- native mobile applications
- unnecessary microservices
- elaborate gamification
- unnecessary integrations

Build the core feedback loop extremely well first.

# Resend

Use Resend for transactional email.

Likely MVP use cases:

- organization invitations
- important negative-feedback alerts
- critical account communication

Do not spam users.

# Stripe

Stripe is a later-stage feature unless explicitly requested.

When implemented:

- the organization owns the subscription
- subscription state is server-authoritative
- verify webhook signatures
- make webhook processing idempotent
- never trust client-reported subscription state

Keep billing logic separate from the core feedback domain.

# Privacy

Collect only data needed by the product.

Avoid unnecessarily collecting customer personal data.

Feedback should remain private to authorized organization members unless explicitly required otherwise.

Avoid logging raw sensitive feedback unnecessarily.

# Error Handling

Handle explicitly:

- invalid NFC card
- disabled NFC card
- missing/deleted location
- feedback submission failure
- network failure
- missing Google Review destination
- unauthenticated dashboard access
- unauthorized tenant access
- empty dashboard states

Never fail silently.

Customer-facing errors should be simple and non-technical.

# Implementation Workflow

When implementing or modifying a feature:

1. inspect existing relevant code
2. understand the affected product flow
3. identify tenant/security implications
4. identify database/RLS implications
5. verify that no review gating is introduced
6. reuse coherent existing project patterns
7. implement the smallest complete solution
8. validate inputs
9. handle errors
10. test the affected flow
11. check responsive behavior when UI changes
12. report important architectural decisions or unresolved risks

Avoid speculative abstractions.

# Database Change Workflow

For database changes:

1. inspect current schema
2. create a migration
3. preserve existing data where applicable
4. define foreign keys
5. define constraints
6. enable or update RLS
7. add necessary indexes
8. update database/application TypeScript types
9. update application code
10. test authorized access
11. test unauthorized access
12. test cross-tenant isolation

# Security Checklist

For every data-access feature verify:

- Is authentication required?
- Which organization owns the data?
- How is membership verified?
- Does RLS enforce the same ownership?
- Can an ID belonging to another organization be substituted?
- Does the client receive more data than required?
- Are privileged credentials server-only?
- Are public endpoints narrowly scoped?
- Are inputs validated server-side?

# Review-Gating Regression Test

Whenever public rating/review behavior changes, explicitly test:

1 star → Google Review CTA available
2 stars → Google Review CTA available
3 stars → Google Review CTA available
4 stars → Google Review CTA available
5 stars → Google Review CTA available

The CTA must not become materially harder to discover for lower ratings.

# Testing Priorities

## Public Flow

Test:

- valid NFC card
- invalid NFC card
- disabled NFC card
- ratings 1 through 5
- optional feedback text
- validation errors
- successful submission
- correct organization association
- correct location association
- correct NFC card association
- Google Review CTA availability after every rating

## Tenant Security

Test:

- Organization A can access Organization A data
- Organization A cannot access Organization B data
- direct API/database attempts cannot bypass tenant restrictions
- unauthorized mutations fail

## Dashboard

Test:

- feedback inbox
- filters
- status changes
- resolution
- location filtering
- correct NFC source

## Notifications

Test:

- qualifying negative feedback triggers intended alerts
- positive feedback does not trigger negative-feedback alerts
- notification logic never changes Google Review availability

# Definition of Done

A feature is not complete merely because the UI renders.

Check as applicable:

- functionality works
- TypeScript passes
- server-side validation exists
- database constraints are appropriate
- RLS is correct
- tenant isolation is preserved
- loading states exist
- empty states exist
- errors are handled
- mobile layout works
- accessibility is reasonable
- important flows are tested
- no secrets are exposed
- no review gating was introduced

# Decision Principles

When requirements are ambiguous, prefer the option that is:

1. safer for tenant data
2. simpler for customers
3. easier for business users
4. easier to maintain
5. appropriate for an MVP
6. compatible with future SaaS growth

Do not sacrifice security for developer convenience.

Do not sacrifice customer UX for architectural cleverness.

Do not sacrifice MVP velocity for speculative enterprise requirements.

# Product North Star

Collect feedback quickly
→ understand problems quickly
→ respond quickly
→ improve customer experience
→ build a healthier reputation

Keep the public customer experience neutral and fair regardless of whether feedback is positive or negative.