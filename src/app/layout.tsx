import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "kicks-js-proxy",
  description: "StockX → WooCommerce repricing & sync",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-6">
            <a href="/" className="text-sm font-semibold">
              kicks-js-proxy
            </a>
            <span className="text-neutral-300">/</span>
            <nav className="flex gap-4 text-sm text-neutral-600">
              <a href="/preview" className="hover:text-neutral-900">
                Preview
              </a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
