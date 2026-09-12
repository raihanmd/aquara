import type { Metadata } from "next";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import { WalletProvider } from "@/components/wallet-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";
import { Toaster } from "sonner";

const SITE_NAME = "Aquara";
const SITE_DESCRIPTION =
  "Aquara watches your 1inch Aqua strategies on Base and rotates dead capital into live top earners. Delegate once with a scoped key. You keep custody.";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: {
    default: `${SITE_NAME} - Autonomous 1inch Aqua Position Manager`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "1inch Aqua",
    "Base",
    "liquidity management",
    "DeFi agent",
    "position rotation",
    "concentrated liquidity",
    "EIP-7702",
    "Calibur",
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  robots: { index: true, follow: true },
  icons: { icon: "/favicon.ico" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} - Autonomous 1inch Aqua Position Manager`,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: `${SITE_NAME} - Autonomous 1inch Aqua Position Manager`,
    description: SITE_DESCRIPTION,
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
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
