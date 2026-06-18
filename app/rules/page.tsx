"use client";

import { useMemo, useState } from "react";
import { SAMPLE_CONFIG } from "@/lib/sample";
import { loadProducts, priceVariant } from "@/lib/engine";
import { resolveEffectiveRule, type ScopedPricingRule, type AppConfig } from "@/config";
import { money } from "@/lib/format";
import { Switch } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { IconPlus, IconRules, IconSpark, IconBolt } from "@/components/icons";

export default function RulesPage() {
  const toast = useToast();
  const products = useMemo(() => loadProducts(), []);
  const [rules, setRules] = useState<ScopedPricingRule[]>(() =>
    SAMPLE_CONFIG.pricingRules.map((r) => ({ ...r })),
  );
  const [productIdx, setProductIdx] = useState(0);
  const [variantIdx, setVariantIdx] = useState(0);

  const config: AppConfig = { ...SAMPLE_CONFIG, pricingRules: rules };
  const product = products[productIdx];
  const variant = product.variants[Math.min(variantIdx, product.variants.length - 1)];

  const matched = rules
    .filter((r) => r.enabled)
    .filter((r) => scopeMatches(r.scope, product, variant))
    .sort((a, b) => specificity(a.scope) - specificity(b.scope));

  const effective = resolveEffectiveRule(product, variant, config);
  const priced = effective ? priceVariant(variant, effective) : { price: null as number | null };
  const offer = variant.offers.find((o) => o.deliveryType === (effective?.sourceDeliveryType ?? "standard"));

  const update = (id: string, patch: Partial<ScopedPricingRule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="page">
      <div className="row between wrap">
        <div className="row" style={{ gap: 10 }}>
          <span className="badge"><IconRules style={{ width: 14, height: 14 }} /> {rules.filter((r) => r.enabled).length} active</span>
          <span className="muted" style={{ fontSize: 12.5 }}>Less-specific rules set defaults; more-specific rules override field-by-field.</span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn btn-sm"><IconPlus style={{ width: 15, height: 15 }} /> Add rule</button>
          <button className="btn btn-sm btn-primary" onClick={() => toast({ kind: "ok", title: "Rules saved", msg: "Effective pricing recalculated across the catalog." })}>
            <IconBolt style={{ width: 15, height: 15 }} /> Save rules
          </button>
        </div>
      </div>

      <div className="two-col" style={{ gridTemplateColumns: "1.55fr 1fr", alignItems: "start" }}>
        {/* Rule cards */}
        <div className="col" style={{ gap: 14 }}>
          {rules.map((r) => {
            const active = matched.some((m) => m.id === r.id);
            const winner = matched.length > 0 && matched[matched.length - 1].id === r.id;
            return (
              <div
                className="card card-pad"
                key={r.id}
                style={{
                  borderColor: winner ? "color-mix(in oklab, var(--accent) 45%, var(--line))" : active ? "var(--line-strong)" : "var(--line)",
                  boxShadow: winner ? "0 0 0 1px var(--accent-glow), var(--shadow-2)" : undefined,
                  transition: "border-color .2s, box-shadow .2s",
                }}
              >
                <div className="row between">
                  <div className="row" style={{ gap: 11 }}>
                    <Switch on={r.enabled} onClick={() => update(r.id, { enabled: !r.enabled })} />
                    <div className="col">
                      <span style={{ fontWeight: 650 }}>{r.id}</span>
                      <ScopeChips scope={r.scope} />
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    {winner && <span className="badge badge-ok"><span className="dot" /> winning here</span>}
                    {active && !winner && <span className="badge"><span className="dot" /> matches</span>}
                    <span className="badge" title="specificity">{specificity(r.scope)}★</span>
                  </div>
                </div>

                <div className="rule-grid">
                  <NumField label="Markup" suffix="%" value={r.markupPercent} onChange={(v) => update(r.id, { markupPercent: v })} />
                  <NumField label="Floor" suffix="€" value={r.floor} onChange={(v) => update(r.id, { floor: v })} placeholder="—" />
                  <NumField label="Min asks" value={r.minAsks} onChange={(v) => update(r.id, { minAsks: v })} placeholder="—" />
                  <div className="field">
                    <label>Rounding</label>
                    <select
                      className="select"
                      value={r.rounding?.mode ?? "none"}
                      onChange={(e) => update(r.id, { rounding: { mode: e.target.value as never, increment: r.rounding?.increment } })}
                    >
                      <option value="none">none</option>
                      <option value="integer">integer</option>
                      <option value="charm">charm .99</option>
                      <option value="nearest">nearest</option>
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Live resolver preview */}
        <div className="card" style={{ position: "sticky", top: 84 }}>
          <div className="card-head">
            <IconSpark style={{ color: "var(--accent)" }} />
            <h3>Live resolver</h3>
            <span className="sub">trace one variant</span>
          </div>
          <div className="card-pad col" style={{ gap: 14 }}>
            <div className="field">
              <label>Product</label>
              <select className="select" value={productIdx} onChange={(e) => { setProductIdx(+e.target.value); setVariantIdx(0); }}>
                {products.map((p, i) => <option key={p.stockxId} value={i}>{p.title}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Size variant</label>
              <select className="select" value={variantIdx} onChange={(e) => setVariantIdx(+e.target.value)}>
                {product.variants.map((v, i) => (
                  <option key={v.stockxVariantId} value={i}>
                    {v.sizeLabel} · ask {money(v.offers[0]?.lowestAsk, product.currency)} · {v.offers[0]?.asks ?? 0} asks
                  </option>
                ))}
              </select>
            </div>

            <div className="trace">
              <span className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".08em" }}>Resolution order</span>
              {matched.length === 0 && <span className="muted">No rule matches — variant skipped.</span>}
              {matched.map((m, i) => (
                <div className="trace-row" key={m.id}>
                  <span className="trace-step mono">{i + 1}</span>
                  <span style={{ fontWeight: 600 }}>{m.id}</span>
                  <ScopeChips scope={m.scope} compact />
                  <div className="grow" />
                  {i === matched.length - 1 && <span className="badge badge-ok">effective</span>}
                </div>
              ))}
            </div>

            {effective && (
              <div className="resolved">
                <Row k="Lowest ask" v={money(offer?.lowestAsk, product.currency)} />
                <Row k="Markup" v={`+${effective.markupPercent}%`} />
                {effective.floor != null && <Row k="Floor" v={money(effective.floor, product.currency)} />}
                <Row k="VAT" v={effective.tax.priceIncludesVat ? `+${effective.tax.vatRatePercent}%` : "—"} />
                <Row k="Rounding" v={effective.rounding.mode} />
                <div className="resolved-final">
                  <span>Retail price</span>
                  <span className="mono" style={{ fontSize: 22, fontWeight: 750 }}>{money(priced.price, product.currency)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .rule-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 16px; }
        @media (max-width: 560px){ .rule-grid { grid-template-columns: repeat(2,1fr); } }
        .trace { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--r-md);
          background: var(--surface-2); border: 1px solid var(--line); }
        .trace-row { display: flex; align-items: center; gap: 9px; }
        .trace-step { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
          background: var(--surface); border: 1px solid var(--line); font-size: 11px; color: var(--ink-3); }
        .resolved { display: flex; flex-direction: column; gap: 2px; }
        .resolved-final { display: flex; align-items: center; justify-content: space-between; margin-top: 12px;
          padding-top: 14px; border-top: 1px dashed var(--line-strong); font-weight: 650; }
      `}</style>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row between" style={{ padding: "6px 0", fontSize: 13 }}>
      <span className="muted">{k}</span>
      <span className="mono" style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}

function NumField({
  label, value, onChange, suffix, placeholder,
}: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; suffix?: string; placeholder?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="input-suffix">
        <input
          className="input"
          type="number"
          inputMode="decimal"
          style={{ width: "100%" }}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
    </div>
  );
}

function ScopeChips({ scope, compact }: { scope: ScopedPricingRule["scope"]; compact?: boolean }) {
  const entries = Object.entries(scope).filter(([, v]) => v != null);
  if (entries.length === 0) return <span className="muted" style={{ fontSize: 12 }}>{compact ? "global" : "applies to everything (base rule)"}</span>;
  return (
    <span className="row wrap" style={{ gap: 5, marginTop: compact ? 0 : 3 }}>
      {entries.map(([k, v]) => (
        <span key={k} className="badge" style={{ fontSize: 10.5, padding: "1px 7px" }}>
          {k}:{String(v)}
        </span>
      ))}
    </span>
  );
}

/* Local mirror of the resolver's scope test (display-only). */
function scopeMatches(scope: ScopedPricingRule["scope"], p: { brand: string; sku: string; title: string }, v: { sizeType: string; sizeLabel: string }): boolean {
  if (scope.brand && scope.brand !== p.brand) return false;
  if (scope.sku && scope.sku !== p.sku) return false;
  if (scope.model && !p.title.includes(scope.model)) return false;
  if (scope.sizeType && scope.sizeType !== v.sizeType) return false;
  const sz = parseFloat(v.sizeLabel);
  if (scope.sizeMin != null && !(sz >= scope.sizeMin)) return false;
  if (scope.sizeMax != null && !(sz <= scope.sizeMax)) return false;
  return true;
}
function specificity(scope: object): number {
  return Object.values(scope).filter((x) => x != null).length;
}
