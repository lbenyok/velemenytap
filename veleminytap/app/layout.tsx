import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils";

// latin-ext is required for Hungarian diacritics (ő, ű) used throughout
// this product's own business/location names — the base latin subset
// silently falls back to a system font for those glyphs instead of
// erroring, which is easy to miss in review.
const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="hu"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
