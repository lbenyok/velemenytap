"use client"

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"
import { Button } from "@/components/ui/button"

export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="mx-auto flex min-h-72 max-w-lg flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">
        Nem sikerült betölteni az oldalt
      </h1>
      <p className="text-sm text-muted-foreground">
        Átmeneti hiba történhetett. Próbáld újra; ha továbbra sem működik,
        frissítsd az oldalt később.
      </p>
      <Button onClick={reset}>Újrapróbálkozás</Button>
    </div>
  )
}
