import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./components.css";
import { Shell } from "@/components/Shell";
import { ToastProvider } from "@/components/Toast";

export const metadata: Metadata = {
  title: "Kicks Repricer — StockX → Store",
  description: "Configurable StockX-to-store repricing. Preview every change before it ships.",
};

export const viewport: Viewport = {
  themeColor: "#0a0c0b",
};

// Set theme before paint to avoid a flash of the wrong color scheme.
const themeScript = `(function(){try{var t=localStorage.getItem('kx-theme')||'dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ToastProvider>
          <Shell>{children}</Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
