"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Navbar, Page, Link as KLink } from "konsta/react";
import { useI18n } from "@/i18n/provider";
import { blockConfig } from "@/config";
import { railKeyToParam } from "@/lib/vetrina/order";
import { skuKey } from "@/lib/skus";
import type { HomeBlock, RailSummary } from "@/lib/vetrina/types";
import type { VetrinaHome, VetrinaResult } from "@/server/vetrina/service";
import { ErrorState } from "./ErrorState";
import { ChevronLeft, ChevronRight, External, Lock, Pin, Refresh } from "./icons";

/**
 * "La tua homepage": every block of the page in order. Product rails are
 * cards showing what the site shows right now; static blocks are thin rows
 * so the page still reads like the real one.
 */
export function HomeScreen({ result }: { result: VetrinaResult<VetrinaHome> }) {
  const { t } = useI18n();
  const router = useRouter();
  const v = t.vetrina;

  return (
    <Page>
      <Navbar
        large
        transparent
        centerTitle
        title={v.title}
        subtitle={result.ok && result.data.source === "fixture" ? v.demo : undefined}
        left={
          <KLink href="/" component="a" className="gap-0.5">
            <ChevronLeft className="h-5 w-5" />
            {v.backToHub}
          </KLink>
        }
        right={
          <KLink onClick={() => router.refresh()} aria-label={v.refresh}>
            <Refresh className="h-5 w-5" />
          </KLink>
        }
      />

      {!result.ok ? (
        <ErrorState code={result.code} error={result.error} />
      ) : (
        <div className="space-y-3 px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-1">
          <p className="px-1 text-[15px] leading-snug opacity-60">{v.home.intro}</p>
          <a
            href={result.data.home.link}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-1 text-[15px] font-medium text-primary"
          >
            {v.viewSite}
            <External className="h-4 w-4" />
          </a>
          {result.data.home.blocks.map((block) => (
            <HomeRow key={block.path} block={block} locks={result.data.locks} />
          ))}
        </div>
      )}
    </Page>
  );
}

function HomeRow({ block, locks }: { block: HomeBlock; locks: Record<string, number> }) {
  const { t } = useI18n();
  const config = blockConfig(block.name);
  if (config.show === "hidden") return null;

  if (block.kind === "rail" && config.show === "rail") {
    return <RailCard rail={block.rail} locks={locks} />;
  }

  const label = config.label ?? t.vetrina.blocks[block.name] ?? t.vetrina.blocks.other;
  const summary = block.kind === "static" ? block.summary : null;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-black/5 px-4 py-3 text-[15px] dark:border-white/10">
      <span className="min-w-0 flex-1 truncate opacity-70">
        {label}
        {summary?.items != null && <span className="opacity-60"> · {t.vetrina.home.items(summary.items)}</span>}
      </span>
      <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-[12px] opacity-60 dark:bg-white/10">
        {t.vetrina.home.fromSite}
      </span>
    </div>
  );
}

function RailCard({ rail, locks }: { rail: RailSummary; locks: Record<string, number> }) {
  const { t } = useI18n();
  const v = t.vetrina.home;
  const pinned = rail.pin.length;
  const hidden = rail.exclude.length;

  const body = (
    <>
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          {rail.eyebrow && (
            <div className="truncate text-[12px] font-semibold uppercase tracking-wide opacity-50">{rail.eyebrow}</div>
          )}
          <div className="truncate text-[19px] font-bold leading-tight">{rail.title || rail.key}</div>
        </div>
        {rail.editable && <ChevronRight className="h-5 w-5 shrink-0 opacity-30" />}
      </div>

      {rail.products.length === 0 ? (
        <p className="px-4 py-3 text-[15px] opacity-50">{v.empty}</p>
      ) : (
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
          {rail.products.slice(0, 12).map((p, i) => (
            <div key={p.id} className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- the shop's own thumbnail sizes */}
              <img
                src={p.image}
                alt={p.name}
                loading="lazy"
                className="h-[72px] w-[72px] rounded-xl bg-black/[0.04] object-contain dark:bg-white/10"
              />
              <span className="absolute left-1 top-1 rounded-md bg-white/90 px-1 text-[11px] font-semibold tabular-nums text-black shadow-sm">
                {i + 1}
              </span>
              {(locks[skuKey(p.sku)] ?? 0) > 0 && (
                <span className="absolute bottom-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-black/80 text-white">
                  <Lock className="h-3 w-3" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3.5 pt-2 text-[13px] opacity-60">
        <span>{v.inHomepage(Math.min(rail.limit, rail.products.length))}</span>
        {pinned > 0 && (
          <span className="inline-flex items-center gap-1">
            <Pin className="h-3.5 w-3.5 text-amber-600" />
            {v.pinned(pinned)}
          </span>
        )}
        {hidden > 0 && <span>{v.hidden(hidden)}</span>}
        {!rail.editable && <span>{v.fixedList}</span>}
      </div>
    </>
  );

  const card = "block overflow-hidden rounded-2xl bg-white shadow-sm active:opacity-80 dark:bg-[#1c1c1e]";
  return rail.editable ? (
    <Link href={`/vetrina/sezione/${railKeyToParam(rail.key)}`} className={card}>
      {body}
    </Link>
  ) : (
    <div className={card}>{body}</div>
  );
}
