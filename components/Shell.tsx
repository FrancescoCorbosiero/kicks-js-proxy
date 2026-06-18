"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  IconGauge,
  IconRules,
  IconDiff,
  IconHistory,
  IconSettings,
  IconChevron,
  IconSun,
  IconMoon,
  IconSearch,
  IconBolt,
} from "./icons";

const NAV = [
  { href: "/", label: "Overview", icon: IconGauge },
  { href: "/rules", label: "Pricing Rules", icon: IconRules, badge: "5" },
  { href: "/plan", label: "Plan & Apply", icon: IconDiff, badge: "•" },
  { href: "/history", label: "Run History", icon: IconHistory },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

const TITLES: Record<string, { h1: string; sub: string }> = {
  "/": { h1: "Overview", sub: "Live repricing posture across your catalog" },
  "/rules": { h1: "Pricing Rules", sub: "Scoped rules resolve general → specific, per variant" },
  "/plan": { h1: "Plan & Apply", sub: "Preview every price change before it ships" },
  "/history": { h1: "Run History", sub: "Every sync, what moved, and what was held" },
  "/settings": { h1: "Settings", sub: "Source, matching, apply & connections" },
};

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = (localStorage.getItem("kx-theme") as "dark" | "light") || "dark";
    const sb = localStorage.getItem("kx-sidebar") === "1";
    setTheme(saved);
    setCollapsed(sb);
    document.documentElement.dataset.theme = saved;
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("kx-theme", next);
  };
  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("kx-sidebar", next ? "1" : "0");
  };

  const meta = TITLES[pathname] ?? { h1: "Kicks Repricer", sub: "" };

  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <span className="brand-name">
            Kicks Repricer
            <small>StockX → Store</small>
          </span>
        </div>

        <span className="nav-label">Workspace</span>
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item ${active ? "active" : ""}`}
              title={item.label}
            >
              <Icon />
              <span className="nav-text">{item.label}</span>
              {item.badge && <span className="nav-badge">{item.badge}</span>}
            </Link>
          );
        })}

        <div className="sb-foot">
          <button className="sb-collapse" onClick={toggleSidebar} title="Collapse">
            <IconChevron style={{ transform: "rotate(180deg)" }} />
            <span className="nav-text sb-foot-text">Collapse</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="col">
            <h1>{meta.h1}</h1>
            <span className="sub">{meta.sub}</span>
          </div>
          <div className="topbar-spacer" />
          <div className="searchbox">
            <IconSearch style={{ width: 16, height: 16 }} />
            <input placeholder="Search SKU, model, brand…" aria-label="Search" />
            <kbd>⌘K</kbd>
          </div>
          <button className="btn btn-icon btn-ghost" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <Link href="/plan" className="btn btn-primary btn-sm">
            <IconBolt style={{ width: 15, height: 15 }} />
            Run sync
          </Link>
        </header>
        {children}
      </main>
    </div>
  );
}
