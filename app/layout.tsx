import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crime Data Assistant | The Crime Index",
  description: "Ask questions about crime data from 700+ agencies across the U.S. Powered by AI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="https://use.typekit.net/gqy0ylh.css" />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
