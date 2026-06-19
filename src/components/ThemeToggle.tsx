"use client";

import * as React from "react";
import { useI18n } from "@/i18n/provider";

/** Sun/moon toggle that flips the `.dark` class on <html> and persists it. */
export function ThemeToggle() {
  const { t } = useI18n();
  const [dark, setDark] = React.useState(false);

  React.useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("kx-theme", next ? "dark" : "light");
    } catch {}
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t.header.toggleTheme}
      title={t.header.toggleTheme}
      className="grid h-9 w-9 place-items-center rounded-md border border-line bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
        )}
      </svg>
    </button>
  );
}
