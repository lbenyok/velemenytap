import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Az oldal nem található — VéleményTap" };

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold tracking-tight">Az oldal nem található</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Ez az oldal nem létezik, vagy időközben elköltözött.
      </p>
      <Button render={<Link href="/" />} nativeButton={false}>
        Vissza a kezdőlapra
      </Button>
    </div>
  );
}
