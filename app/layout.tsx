import type { Metadata } from "next";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import { WalletProvider } from "@/components/wallet-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Aqua EZ",
  description: "AI manager for 1inch Aqua - shared liquidity made easy",
};

export const viewport = {
  maximumScale: 1,
};

const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={`${geist.variable} ${geistMono.variable} ${playfair.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <body className="antialiased">
        <WalletProvider>
          <TooltipProvider>
            <div className="flex h-dvh">
              <div className="flex flex-1 flex-col min-w-0">
                <Toaster
                  position="top-center"
                  theme="light"
                  toastOptions={{
                    className:
                      "!bg-card !text-foreground !border-border/50 !shadow-[var(--shadow-float)]",
                  }}
                />
                {children}
              </div>
            </div>
          </TooltipProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
