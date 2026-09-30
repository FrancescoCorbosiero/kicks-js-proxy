"use client";

import * as React from "react";
import { Sheet } from "react-modal-sheet";
import { Button, Segmented, SegmentedButton } from "konsta/react";
import { useI18n } from "@/i18n/provider";
import { FIELD_SPECS, fieldProblem, type FieldProblem } from "@/lib/vetrina/fields";
import type { FieldValues } from "@/lib/vetrina/types";
import { SEGMENTED_COLORS } from "./segmented";
import { useSheetMount } from "./sheet-mount";

/**
 * A block's texts and look, in a bottom sheet: one input per editable field
 * (the config picks them, the plugin's rules check them as you type), the
 * section's size for a rail, and a preview of the section header. The same
 * sheet applies to the rail editor's draft or saves a block straight away —
 * `onSubmit` decides.
 */
export function FieldsSheet({
  open,
  title,
  blockName,
  fieldKeys,
  values,
  limit,
  preview = false,
  submitLabel,
  busyLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  blockName: string;
  /** The fields shown, in order. */
  fieldKeys: string[];
  values: FieldValues;
  /** Rails: the section's size, when the customer may change it. */
  limit?: { value: number; max: number };
  /** Draw the section header as the site will (rails). */
  preview?: boolean;
  submitLabel: string;
  busyLabel?: string;
  /** True closes the sheet. */
  onSubmit: (values: FieldValues, limit?: number) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const s = t.vetrina.section;
  const mountPoint = useSheetMount();
  const [draft, setDraft] = React.useState<FieldValues>(values);
  const [size, setSize] = React.useState(limit?.value ?? 1);
  const [busy, setBusy] = React.useState(false);

  // Every opening starts from the values as they are now.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(values);
      setSize(limit?.value ?? 1);
    }
    wasOpen.current = open;
  }, [open, values, limit?.value]);

  const problems: Record<string, FieldProblem | null> = {};
  for (const field of fieldKeys) problems[field] = fieldProblem(blockName, field, draft[field] ?? "");
  const blocked = Object.values(problems).some(Boolean);

  async function submit() {
    if (blocked || busy) return;
    setBusy(true);
    try {
      if (await onSubmit(draft, limit ? size : undefined)) onClose();
    } finally {
      setBusy(false);
    }
  }

  const set = (field: string, value: string) => setDraft((prev) => ({ ...prev, [field]: value }));

  return (
    <Sheet isOpen={open} onClose={onClose} detent="content" avoidKeyboard mountPoint={mountPoint}>
      <Sheet.Container className="!bg-[#f2f2f7] dark:!bg-[#1c1c1e]">
        <Sheet.Header />
        <Sheet.Content>
          <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
            <h2 className="text-[20px] font-bold leading-tight">{title}</h2>

            {preview && <SectionPreview values={draft} label={s.preview} />}

            <div className="mt-4 flex flex-col gap-4">
              {fieldKeys.map((field) => (
                <FieldInput
                  key={field}
                  blockName={blockName}
                  field={field}
                  value={draft[field] ?? ""}
                  problem={problems[field]}
                  onChange={(value) => set(field, value)}
                />
              ))}
              {fieldKeys.includes("buttonText") && fieldKeys.includes("buttonUrl") && (
                <p className="-mt-2 text-[13px] opacity-60">{s.noButton}</p>
              )}
              {limit && <SizeStepper value={size} max={limit.max} onChange={setSize} />}
            </div>

            <div className="mt-6 flex gap-3">
              <Button large rounded clear className="flex-1" onClick={onClose}>
                {s.cancel}
              </Button>
              <Button large rounded className="flex-[2]" disabled={blocked || busy} onClick={() => void submit()}>
                {busy && busyLabel ? busyLabel : submitLabel}
              </Button>
            </div>
          </div>
        </Sheet.Content>
      </Sheet.Container>
      <Sheet.Backdrop onTap={onClose} />
    </Sheet>
  );
}

const inputClass =
  "w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[16px] outline-none placeholder:opacity-40 focus:border-black/30 dark:border-white/15 dark:bg-white/10 dark:focus:border-white/40";

function FieldInput({
  blockName,
  field,
  value,
  problem,
  onChange,
}: {
  blockName: string;
  field: string;
  value: string;
  problem: FieldProblem | null;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const s = t.vetrina.section;
  const rule = FIELD_SPECS[blockName]?.[field];
  const id = `field-${field}`;
  const label = s.fields[field] ?? field;
  const max = rule?.max ?? 0;
  const used = [...value.trim()].length;

  if (rule?.type === "enum") {
    return (
      <div>
        <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wide opacity-60">{label}</span>
        <Segmented strong rounded colors={SEGMENTED_COLORS}>
          {(rule.options ?? []).map((option) => (
            <SegmentedButton key={option} active={value === option} onClick={() => onChange(option)}>
              {s.backgrounds[option] ?? option}
            </SegmentedButton>
          ))}
        </Segmented>
      </div>
    );
  }

  // Long texts (a subtitle, a message) get a box; a link is always one line.
  const long = rule?.type === "text" && max > 150;
  const message =
    problem === "too_long"
      ? s.problems.too_long(max)
      : problem
        ? (s.problems[problem] as string)
        : null;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-[13px] font-semibold uppercase tracking-wide">
        <span className="opacity-60">{label}</span>
        {max > 0 && rule?.type === "text" && used > max * 0.8 && (
          <span className={`tabular-nums normal-case ${used > max ? "text-red-600 dark:text-red-400" : "opacity-60"}`}>
            {used}/{max}
          </span>
        )}
      </label>
      {long ? (
        <textarea
          id={id}
          rows={3}
          value={value}
          placeholder={s.placeholders[field] ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} resize-none`}
        />
      ) : (
        <input
          id={id}
          type={rule?.type === "url" ? "url" : "text"}
          inputMode={rule?.type === "url" ? "url" : "text"}
          autoCapitalize={rule?.type === "url" ? "none" : "sentences"}
          autoCorrect={rule?.type === "url" ? "off" : "on"}
          enterKeyHint="done"
          value={value}
          placeholder={s.placeholders[field] ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}
      {message && <p className="mt-1 text-[13px] text-red-600 dark:text-red-400">{message}</p>}
    </div>
  );
}

function SizeStepper({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  const { t } = useI18n();
  const s = t.vetrina.section;
  const step = (delta: number) => onChange(Math.min(max, Math.max(1, value + delta)));
  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wide opacity-60">{s.limit}</span>
      <div className="flex items-center gap-3">
        <Button rounded tonal inline className="!h-11 !w-11 !px-0 text-[22px]" aria-label={s.fewer} disabled={value <= 1} onClick={() => step(-1)}>
          −
        </Button>
        <span className="min-w-12 text-center text-[22px] font-semibold tabular-nums">{value}</span>
        <Button rounded tonal inline className="!h-11 !w-11 !px-0 text-[22px]" aria-label={s.more} disabled={value >= max} onClick={() => step(1)}>
          +
        </Button>
      </div>
      <p className="mt-1.5 text-[13px] opacity-60">{s.limitHint(value)}</p>
    </div>
  );
}

/** The section header as the site draws it (block golden-hive/shortcode-wrapper). */
function SectionPreview({ values, label }: { values: FieldValues; label: string }) {
  const background = values.backgroundColor ?? "white";
  const dark = background === "black";
  const surface = dark ? "bg-[#111] text-white" : background === "gray" ? "bg-[#f5f5f5] text-[#111]" : "bg-white text-[#111]";
  const showButton = (values.buttonText ?? "").trim() !== "" && (values.buttonUrl ?? "").trim() !== "";
  return (
    <div className="mt-4">
      <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wide opacity-60">{label}</span>
      <div className={`rounded-2xl border border-black/10 px-4 py-5 text-center dark:border-white/15 ${surface}`}>
        {(values.eyebrow ?? "").trim() !== "" && (
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-60">{values.eyebrow}</div>
        )}
        {(values.title ?? "").trim() !== "" && <div className="mt-1 text-[22px] font-extrabold leading-tight">{values.title}</div>}
        <div className="mt-3 flex justify-center gap-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className={`h-14 w-14 rounded-xl ${dark ? "bg-white/15" : "bg-black/[0.06]"}`} />
          ))}
        </div>
        {showButton && (
          <span className={`mt-3 inline-block rounded-full px-4 py-1.5 text-[13px] font-semibold ${dark ? "bg-white text-[#111]" : "bg-[#111] text-white"}`}>
            {values.buttonText}
          </span>
        )}
      </div>
    </div>
  );
}
