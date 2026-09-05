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
  { href: "/dashboard", label: "Áttekintés", icon: LayoutDashboard },
  { href: "/dashboard/locations", label: "Helyszínek", icon: MapPin },
  { href: "/dashboard/nfc-cards", label: "NFC kártyák", icon: Nfc },
  { href: "/dashboard/feedback", label: "Vélemények", icon: Inbox },
  { href: "/dashboard/analytics", label: "Elemzés", icon: BarChart3 },
  { href: "/dashboard/settings", label: "Beállítások", icon: Settings },
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
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      // Round-4 R4-05: the current route is exposed to assistive tech via
      // aria-current, not just a visual highlight.
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
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
      {/* Desktop (>= xl): every link's icon AND label always visible.
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
          only, and only at 768/1280) missed it. `xl` (1280px) is the
          first breakpoint with enough room for real-world org names, not
          just the four-character one this was originally eyeballed
          against. */}
      <nav aria-label="Irányítópult navigáció" className="hidden items-center gap-1 xl:flex">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}
      </nav>

      {/* Below xl (round-5 R5-07 -- was lg/1024px, measured to still
          overlap the org name; see the desktop nav's own comment above):
          a labelled menu button opens the same links in a side panel,
          full label always visible there too. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="xl:hidden"
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
                {...item}
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
