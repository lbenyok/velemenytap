"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="hu">
      <body>
        <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Hiba történt.</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Értesítést kaptunk róla, és már vizsgáljuk. Kérjük, próbáld újra.
          </p>
          <Button onClick={reset}>Újrapróbálkozás</Button>
        </div>
      </body>
    </html>
  );
}
