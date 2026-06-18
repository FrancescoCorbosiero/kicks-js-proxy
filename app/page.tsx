"use client";

import { useMemo } from "react";
import Link from "next/link";
import { SAMPLE_CONFIG, RUN_HISTORY } from "@/lib/sample";
import { buildAllPlans, statsFor, type PlanItemX } from "@/lib/engine";
import { money, pct, relTime } from "@/lib/format";
import { Counter, Delta, Bars, Avatar, ActionBadge } from "@/components/ui";
import {
  IconBolt,
  IconDiff,
  IconLock,
  IconSpark,
  IconArrowUp,
  IconChevron,
  IconCheck,
  IconWarn,
} from "@/components/icons";

export default function OverviewPage() {
  const plans = useMemo(() => buildAllPlans(SAMPLE_CONFIG), []);
  const stats = useMemo(() => statsFor(plans), [plans]);

  const movers = useMemo(() => {
    const items: PlanItemX[] = [];
    for (const p of plans) for (const it of p.items) if (it.action === "update" && it.deltaPercent != null) items.push(it);
    return items.sort((a, b) => Math.abs(b.deltaPercent!) - Math.abs(a.deltaPercent!)).slice(0, 6);
  }, [plans]);

  const actionTotal = stats.update + stats.create + stats.noop + stats.skip;
  const seg = (n: number) => `${(n / actionTotal) * 100}%`;

  return (
    <div className="page">
      {/* KPI tiles */}
      <div className="stat-grid">
        <Stat icon={<IconDiff />} label="Updates queued" tint="rgba(106,169,255,.5)" value={stats.update} foot={`across ${stats.products} products`} />
        <Stat icon={<IconSpark />} label="New listings" tint="rgba(79,214,168,.5)" value={stats.create} foot="not yet on store" />
        <Stat icon={<IconLock />} label="Held for review" tint="rgba(244,193,82,.55)" value={stats.held} foot={`> ${SAMPLE_CONFIG.apply.requireApprovalAboveDeltaPercent}% Δ guardrail`} />
        <Stat
          icon={<IconArrowUp />}
          label="Avg price delta"
          tint="rgba(200,242,80,.5)"
          render={<><Delta value={stats.avgDelta} /></>}
          foot={`${stats.variants} variants evaluated`}
        />
        <Stat
          icon={<IconBolt />}
          label="Repricing exposure"
          tint="rgba(200,242,80,.4)"
          render={<span className="stat-val mono"><span className="unit">€</span><Counter value={Math.round(stats.exposure)} /></span>}
          foot="sum of proposed prices"
        />
      </div>

      {/* Activity + breakdown */}
      <div className="two-col">
        <div className="card">
          <div className="card-head">
            <h3>Repricing activity</h3>
            <span className="sub">updates applied · last 5 runs</span>
            <div className="grow" />
            <span className="badge badge-ok"><span className="dot" /> healthy</span>
          </div>
          <div className="card-pad">
            <Bars data={[...RUN_HISTORY].reverse().map((r) => r.updated)} />
            <div className="row between" style={{ marginTop: 14 }}>
              <Trend label="Updated" value={RUN_HISTORY[0].updated} foot={`vs ${RUN_HISTORY[1].updated} prev`} up />
              <Trend label="Skipped" value={RUN_HISTORY[0].skipped} foot="thin liquidity" />
              <Trend label="Failed" value={RUN_HISTORY[0].failed} foot="last run" good />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Action mix</h3>
            <span className="sub">this plan</span>
          </div>
          <div className="card-pad col" style={{ gap: 16 }}>
            <div className="stack" aria-hidden>
              <span style={{ width: seg(stats.update), background: "var(--info)" }} title={`Update ${stats.update}`} />
              <span style={{ width: seg(stats.create), background: "var(--down)" }} title={`Create ${stats.create}`} />
              <span style={{ width: seg(stats.noop), background: "var(--ink-3)" }} title={`No change ${stats.noop}`} />
              <span style={{ width: seg(stats.skip), background: "var(--line-strong)" }} title={`Skip ${stats.skip}`} />
            </div>
            <Legend rows={[
              { c: "var(--info)", k: "Update", v: stats.update },
              { c: "var(--down)", k: "Create", v: stats.create },
              { c: "var(--ink-3)", k: "No change", v: stats.noop },
              { c: "var(--line-strong)", k: "Skip (rule/liquidity)", v: stats.skip },
            ]} />
          </div>
        </div>
      </div>

      {/* Top movers */}
      <div className="card">
        <div className="card-head">
          <h3>Biggest movers</h3>
          <span className="sub">largest proposed deltas in this plan</span>
          <div className="grow" />
          <Link href="/plan" className="btn btn-sm btn-ghost">Open plan <IconChevron style={{ width: 15, height: 15 }} /></Link>
        </div>
        <div className="tablewrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Product</th>
                <th>Size</th>
                <th className="num">Current</th>
                <th className="num">Proposed</th>
                <th className="num">Δ</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {movers.map((it) => (
                <tr key={it.stockxVariantId + it.title}>
                  <td>
                    <div className="row">
                      <Avatar label={it.image} />
                      <div className="col">
                        <span style={{ fontWeight: 600 }}>{it.title}</span>
                        <span className="muted" style={{ fontSize: 12 }}>{it.brand}</span>
                      </div>
                    </div>
                  </td>
                  <td className="mono">{it.sizeLabel}</td>
                  <td className="num mono">{money(it.currentPrice)}</td>
                  <td className="num mono" style={{ fontWeight: 650 }}>{money(it.proposedPrice)}</td>
                  <td className="num"><Delta value={it.deltaPercent} /></td>
                  <td><ActionBadge action={it.action} held={it.held} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent runs */}
      <div className="card">
        <div className="card-head">
          <h3>Recent runs</h3>
          <div className="grow" />
          <Link href="/history" className="btn btn-sm btn-ghost">All history <IconChevron style={{ width: 15, height: 15 }} /></Link>
        </div>
        <div className="col">
          {RUN_HISTORY.map((r) => (
            <div key={r.id} className="row between" style={{ padding: "13px 18px", borderBottom: "1px solid var(--line)" }}>
              <div className="row">
                <span className={`toast-ico ${r.status === "ok" ? "" : ""}`} style={{ width: 30, height: 30, borderRadius: 9, display: "grid", placeItems: "center", background: r.status === "ok" ? "color-mix(in oklab, var(--down) 16%, transparent)" : "color-mix(in oklab, var(--warn) 18%, transparent)", color: r.status === "ok" ? "var(--down)" : "var(--warn)" }}>
                  {r.status === "ok" ? <IconCheck style={{ width: 16, height: 16 }} /> : <IconWarn style={{ width: 16, height: 16 }} />}
                </span>
                <div className="col">
                  <span style={{ fontWeight: 600 }}>{r.id} · <span className="muted" style={{ fontWeight: 400 }}>{r.trigger}</span></span>
                  <span className="muted" style={{ fontSize: 12 }}>{r.scanned} scanned · {r.updated} updated · {r.held} held</span>
                </div>
              </div>
              <span className="muted mono" style={{ fontSize: 12.5 }}>{relTime(r.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon, label, value, foot, tint, render,
}: {
  icon: React.ReactNode; label: string; value?: number; foot: string; tint: string; render?: React.ReactNode;
}) {
  return (
    <div className="stat" style={{ ["--tint" as string]: tint }}>
      <div className="stat-top">
        <span className="stat-ico">{icon}</span>
        {label}
      </div>
      {render ?? <div className="stat-val mono"><Counter value={value ?? 0} /></div>}
      <div className="stat-foot">{foot}</div>
    </div>
  );
}

function Trend({ label, value, foot, up, good }: { label: string; value: number; foot: string; up?: boolean; good?: boolean }) {
  return (
    <div className="col">
      <span className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</span>
      <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: good && value === 0 ? "var(--down)" : undefined }}>
        <Counter value={value} />
      </span>
      <span className="muted" style={{ fontSize: 11.5 }}>{foot}</span>
    </div>
  );
}

function Legend({ rows }: { rows: { c: string; k: string; v: number }[] }) {
  return (
    <div className="col" style={{ gap: 9 }}>
      {rows.map((r) => (
        <div key={r.k} className="row between">
          <span className="row" style={{ gap: 9 }}>
            <span className="dot" style={{ color: r.c, width: 9, height: 9 }} />
            <span style={{ fontSize: 13 }}>{r.k}</span>
          </span>
          <span className="mono" style={{ fontWeight: 650 }}>{r.v}</span>
        </div>
      ))}
    </div>
  );
}
