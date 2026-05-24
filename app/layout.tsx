import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Model Thinking Inspector",
  description: "Watch an OpenAI model search, read, and reason — live.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-cl-bg text-cl-slate font-sans antialiased">{children}</body>
    </html>
  );
}
