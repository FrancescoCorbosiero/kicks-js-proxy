import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { I18nProvider } from "@/i18n/provider";
import { getServerDictionary } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return {
    title: t.meta.title,
    description: t.meta.description,
    // Installed from the phone's "Add to Home Screen", the Hub opens full
    // screen like an app (see app/manifest.ts for the start page).
    appleWebApp: { capable: true, title: "Store Hub", statusBarStyle: "default" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // lets the Vetrina paint under the notch / home indicator
};

// Apply the saved theme before paint to avoid a flash of the wrong scheme.
const themeScript = `(function(){try{var t=localStorage.getItem('kx-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

/**
 * The document shell only. Each area brings its own chrome: the operator
 * tabs live in (admin)/layout.tsx, the Vetrina's app shell in
 * (vetrina)/vetrina/layout.tsx.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale } = await getServerDictionary();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
