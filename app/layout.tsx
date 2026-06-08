import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://nibrsai.com"),
  title: "Crime Data Assistant | The Crime Index",
  description: "Ask questions about crime data from 700+ agencies across the U.S. Powered by AI.",
  openGraph: {
    title: "Crime Data Assistant",
    description: "Ask plain-English questions across current, historical, NIBRS, SHR, and hate crime data.",
    url: "https://nibrsai.com",
    siteName: "The Crime Index",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Crime Data Assistant by The Crime Index",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Crime Data Assistant",
    description: "Ask plain-English questions across current, historical, NIBRS, SHR, and hate crime data.",
    images: ["/opengraph-image"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://use.typekit.net" crossOrigin="" />
        <link rel="preconnect" href="https://p.typekit.net" crossOrigin="" />
        <link rel="stylesheet" href="https://use.typekit.net/gqy0ylh.css" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <Script src="https://ahd-analytics.vercel.app/tracker.js" data-site="cda" strategy="afterInteractive" />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
