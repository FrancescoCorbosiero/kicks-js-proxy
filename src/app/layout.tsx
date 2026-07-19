import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { MainNav } from "@/components/MainNav";
import { I18nProvider } from "@/i18n/provider";
import { getServerDictionary } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return { title: t.meta.title, description: t.meta.description };
}

// Apply the saved theme before paint to avoid a flash of the wrong scheme.
const themeScript = `(function(){try{var t=localStorage.getItem('kx-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, t } = await getServerDictionary();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">
        <I18nProvider initialLocale={locale}>
          <header className="sticky top-0 z-30 border-b border-line bg-bg/72 backdrop-blur-xl">
            <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
              <a href="/" className="group flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-accent font-extrabold text-accent-fg shadow-[0_6px_18px_-6px] shadow-accent/50 transition-transform group-hover:scale-105">
                  K
                </span>
                <span className="flex flex-col leading-none">
                  <span className="text-[13.5px] font-semibold tracking-tight">kicks-js-proxy</span>
                  <span className="text-[10.5px] font-medium text-faint">StockX → WooCommerce</span>
                </span>
              </a>

              <MainNav />

              <div className="ml-auto flex items-center gap-2">
                <span className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-muted lg:inline-flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-down" />
                  {t.header.internalTool}
                </span>
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
            </div>
          </header>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
