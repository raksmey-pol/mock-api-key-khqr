import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mekong — Small joys. Simple payments.",
  description: "A thoughtful little mock store with Bakong KHQR checkout, webhook payment updates, and MD5 polling.",
};

const checkoutHost = (() => {
  const value = process.env.CHECKOUT_HOST?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
})();

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {checkoutHost && (
          <Script
            src={`${checkoutHost}/checkout.js`}
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}
