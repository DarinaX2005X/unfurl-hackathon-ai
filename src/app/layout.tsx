import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/manrope";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "Unfurl",
  description: "Learn what you’ve always wanted to.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
