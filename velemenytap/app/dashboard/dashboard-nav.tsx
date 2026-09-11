"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  MapPin,
  Nfc,
  Inbox,
  BarChart3,
  Settings,
  CreditCard,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Áttekintés", icon: LayoutDashboard, tourTarget: "nav-overview" },
  { href: "/dashboard/locations", label: "Helyszínek", icon: MapPin, tourTarget: "nav-locations" },
  { href: "/dashboard/nfc-cards", label: "NFC kártyák", icon: Nfc, tourTarget: "nav-nfc-cards" },
  { href: "/dashboard/feedback", label: "Vélemények", icon: Inbox, tourTarget: "nav-feedback" },
  { href: "/dashboard/analytics", label: "Elemzés", icon: BarChart3, tourTarget: "nav-analytics" },
  // No tourTarget -- the onboarding tour (features/onboarding-tour/tour-steps.ts)
  // predates billing and deliberately isn't being extended with a billing
  // step as part of this merge; omitting it here just means this link
  // renders with no data-tour attribute, which the tour never looks for.
  { href: "/dashboard/billing", label: "Számlázás", icon: CreditCard, tourTarget: undefined },
  { href: "/dashboard/settings", label: "Beállítások", icon: Settings, tourTarget: "nav-settings" },
] as const;

function isActive(pathname: string, href: string): boolean {
  // Exact match for "/dashboard" itself (every other route also starts
  // with it), prefix match for the rest.
  return href === "/dashboard" ? pathname === href : pathname.startsWith(href);
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  onNavigate,
  tourTarget,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onNavigate?: () => void;
  /** Only set for the desktop copy of this link -- see the desktop <nav>'s
   * own comment below for why the mobile Sheet's copy deliberately never
   * gets one. */
  tourTarget?: string;
}) {
  return (
    <Link
      href={href}
      // Round-4 R4-05: the current route is exposed to assistive tech via
      // aria-current, not just a visual highlight.
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      data-tour={tourTarget}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {/* Decorative -- the visible text label is the link's accessible
          name (round-4 R4-05); the icon must never be announced on its
          own or duplicate that name. */}
      <Icon className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}

export function DashboardNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Desktop (>= 2xl): every link's icon AND label always visible.
          Round-4 R4-05 found the previous version hid the label below
          `lg` entirely, leaving six icon-only links with no accessible
          name at tablet widths -- fixed by never hiding it once shown.
          The breakpoint moved from `md` to `lg` in round 4 (768px still
          overflowed the row with the wordmark/org-name/logout also
          present), and round 5 (R5-07) found `lg` (1024px) *itself*
          still wasn't enough: measured directly, the nav's own six links
          render to ~846px wide starting after the wordmark, which
          collides with the org-name column starting around ~732px at
          1024px -- flexbox doesn't clip an overflowing sibling by
          default, so this doesn't show up as a scrollbar (`scrollWidth`
          staying equal to the viewport), only as actual visual overlap,
          which is why the previous e2e coverage (checking scrollWidth
          only, and only at 768/1280) missed it.

          Found again during an independent review, after billing added a
          seventh link: `xl` (1280px) stopped being enough the moment that
          link existed. Measured directly with real bounding boxes
          (getBoundingClientRect, not scrollWidth, which -- same flexbox
          reason as above -- still reported zero overflow at 1280px even
          with a real, visible ~25px overlap between the nav and the org
          name): at 1280px the nav's own right edge landed at x=967.5
          while the org name's left edge started at x=942.7. 1366px (a
          very common laptop width) leaves only ~29px of margin -- too
          thin to trust against a longer real-world org name or a
          different font-metrics environment. `2xl` (1536px) was the
          first *standard* Tailwind breakpoint measured with a
          comfortable margin (~199px) rather than the tightest one that
          happens to pass today; matches this project's own established
          preference (R5-07's own reasoning, above) for a simple, robust
          breakpoint over a narrowly-tuned custom one. */}
      <nav aria-label="Irányítópult navigáció" className="hidden items-center gap-1 2xl:flex">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}
      </nav>

      {/* The tour only ever looks for a data-tour target in THIS nav, never
          the mobile Sheet's copy below -- both render the same NAV_ITEMS,
          so if both carried the attribute, document.querySelector's "first
          match in document order" would depend on Base UI's own portal
          mount timing for the Sheet's content rather than anything this
          code controls. The Sheet's copy is stripped of tourTarget just
          below for exactly this reason -- a step whose target lives only
          below `2xl` correctly finds nothing and renders as a plain
          centered step instead. */}

      {/* Below 2xl (moved here from xl/1280px after billing added a
          seventh link -- see the desktop nav's own comment above for the
          measurements; before that, round-5 R5-07 moved it from
          lg/1024px): a labelled menu button opens the same links in a
          side panel, full label always visible there too. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="2xl:hidden"
              aria-label="Menü megnyitása"
            />
          }
        >
          <Menu className="size-5" aria-hidden="true" />
        </SheetTrigger>
        <SheetContent side="left" className="w-72">
          <SheetHeader>
            <SheetTitle>Menü</SheetTitle>
          </SheetHeader>
          <nav aria-label="Irányítópult navigáció" className="flex flex-col gap-1 px-4">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isActive(pathname, item.href)}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
