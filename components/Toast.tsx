"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconBolt, IconWarn } from "./icons";

type ToastKind = "ok" | "info" | "warn";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  msg?: string;
}

const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="toast-ico">
              {t.kind === "ok" ? <IconCheck /> : t.kind === "warn" ? <IconWarn /> : <IconBolt />}
            </span>
            <span className="col">
              <span className="toast-title">{t.title}</span>
              {t.msg && <span className="toast-msg">{t.msg}</span>}
            </span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
