"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopyFailed(false);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // The Clipboard API is unavailable in an insecure context or
            // when permission is denied. Previously this failed silently,
            // leaving the owner pressing a button that never did anything
            // and no other way to get the URL onto an NFC writer.
            setCopyFailed(true);
          }
        }}
      >
        {copied ? "Másolva" : "Link másolása"}
      </Button>
      {copyFailed ? (
        <div className="max-w-xs space-y-1 text-xs whitespace-normal">
          <p role="status">
            A másolást a böngésző nem engedélyezte. Jelöld ki és másold ki a
            linket:
          </p>
          <input
            aria-label="A kártya nyilvános linkje"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded border border-input bg-background p-2 text-foreground"
          />
        </div>
      ) : null}
    </div>
  );
}
