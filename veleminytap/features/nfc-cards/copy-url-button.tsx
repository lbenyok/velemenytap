"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard API can be unavailable (permissions, insecure
          // context); the URL is still visible/openable, so this is
          // non-fatal.
        }
      }}
    >
      {copied ? "Másolva" : "Link másolása"}
    </Button>
  );
}
