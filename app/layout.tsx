import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LabelCheck — TTB Label Verification",
  description:
    "Verify alcohol beverage label images against application data.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
