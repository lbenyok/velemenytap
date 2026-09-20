# Platform-owner card management

The owner panel is at **https://velemenytap.com/admin**. It uses the normal
VéleményTap login, but requires a separately provisioned platform-admin role.
An organization's owner/admin membership is not a platform-admin role.

## Owner workflow

1. Sign in with your approved owner account, then open `/admin`.
2. Search by business name and open the customer's business. Lists are paginated;
   use the next/previous links to reach additional customers and cards.
3. Search its cards by name or the UUID at the end of a public card URL.
4. Confirm the business, location and card name. You can open the public page
   without impersonating the customer.
5. Enter an internal reason, then select **Kártya zárolása**.
6. Wait for **Tulajdonos által zárolva**. Refresh the public page: it must show the
   inactive message. A previously opened form also cannot submit after locking.
7. To restore the card, enter a reason and select **Zárolás feloldása**. This restores
   its pre-lock active/inactive state. It does not activate an inactive location.
8. Review the latest 20 lock/unlock actions for that business below the card list.
   Records include the actor's account ID, reason, card ID and Budapest time.

The ordinary customer's card table shows **Szolgáltatói zárolás** while locked and
does not offer activation. Database protections also reject a crafted API request.
The public link, NFC tag and feedback history are preserved. The physical NFC
chip remains readable; the software stops accepting feedback through its link.
Other cards remain unaffected. This panel does not provide account impersonation,
refunds, subscription cancellation, bulk customer suspension or remote NFC rewriting.

The admin panel is independent of the platform owner's own organization or billing
status. A shortcut appears above the regular dashboard navigation for platform
admins who have dashboard access. Otherwise use `/admin` directly.

## Deployment and initial owner access

Apply `20260920160000_platform_card_admin.sql` before deploying code that selects
the new columns. It is additive and compatible with existing public feedback
paths: a locked card has the existing `status = inactive`, so no replacement of
the previously reviewed submission or lookup functions is necessary.

The narrow migration script verifies the target project and all 51 baseline
migration versions, then applies the SQL and migration ledger record in one
transaction. Without `--apply` it only performs a preflight:

```text
node scripts/apply-platform-admin-migration.mjs <environment-file> <project-ref> --apply
```

The initial owner must already have a confirmed account. Verify the intended
email with the owner before granting cross-customer access. The grant script
checks the exact email in Supabase Auth and stores the resulting immutable UID:

```text
node scripts/grant-platform-admin.mjs <environment-file> <project-ref> <confirmed-owner-email>
node scripts/grant-platform-admin.mjs <environment-file> <project-ref> <confirmed-owner-email> --grant
```

Never run the second command for a guessed account. This is not a customer-facing
signup option. No user can self-grant by editing profile metadata or submitting
an organization-admin role. Registry writes require a trusted database/service
operator. To revoke access, remove the specific UID from `platform_admins` using
an authorized operator connection. The next page/action checks the registry again;
revocation does not automatically unlock previously locked cards.

## Enforcement and concurrency

- Every admin page and server action verifies the signed-in user with Auth and
  then checks the server-managed UID registry before creating a service client.
- Registry RLS exposes only the current user's own membership; ordinary users
  cannot insert/update/delete it or read audit records.
- The lock RPC is executable only by service_role. It checks the actor against
  the registry again, takes a shared registry lock and a card row lock, compares
  the expected state, then writes the lock and audit record atomically.
- Tenant updates cannot change platform-lock columns, card ID or public URL.
  A locked card cannot become active, including through a direct table update.
- Unlock restores the state captured at lock time. Stale admin tabs receive a
  conflict rather than silently reversing a newer operation.
- Existing public submission takes the same card row lock and checks status:
  submissions completed before the lock remain; submissions after it fail.
- No tenant read policies on other businesses were widened.

## Rollback

Do not simply drop the lock columns while cards are locked. The existing
application can continue serving their inactive state while this release is
rolled back. Resolve or intentionally retain outstanding locks with an authorized
operator first. Preserve the audit history. Removing a platform-admin grant is
the immediate way to revoke an operator's panel access.

## Verification (2026-09-20)

659 unit tests passed; changed-file lint and TypeScript checks passed. The two
platform-admin browser/database tests passed against the isolated Supabase
project, including self-grant/metadata forgery, cross-tenant locking, stale public
forms, protected identity fields, stale admin state, revoked admin access,
audit history, and restoration of both active and inactive cards. The two existing
remote-card-management tests also passed on rerun. An initial browser timeout
was not reproduced; a reproducible stale-state RPC timeout was corrected by
using a non-serialization error code for a business-state conflict.

The additive migration was applied to production on 2026-09-20 (52 migrations).
Owner access still requires the explicitly confirmed login; deployment alone
does not make any existing business owner a platform administrator.
