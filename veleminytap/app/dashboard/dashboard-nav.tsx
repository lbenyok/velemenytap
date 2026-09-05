"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MapPin,
  Nfc,
  Inbox,
  BarChart3,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Áttekintés", icon: LayoutDashboard },
  { href: "/dashboard/locations", label: "Helyszínek", icon: MapPin },
  { href: "/dashboard/nfc-cards", label: "NFC kártyák", icon: Nfc },
  { href: "/dashboard/feedback", label: "Vélemények", icon: Inbox },
  { href: "/dashboard/analytics", label: "Elemzés", icon: BarChart3 },
  { href: "/dashboard/settings", label: "Beállítások", icon: Settings },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        // Exact match for "/dashboard" itself (every other route also
        // starts with it), prefix match for the rest.
        const active =
          href === "/dashboard" ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-4" strokeWidth={2} />
            <span className="hidden lg:inline">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
