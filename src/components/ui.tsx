"use client";

import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** Simple mode hides technical detail (models, traces, scopes, fingerprints) for non-technical users. */
const SimpleCtx = createContext(false);
export const SimpleModeProvider = SimpleCtx.Provider;
export function useSimpleMode() {
  return useContext(SimpleCtx);
}
/** Renders its children only in technical mode. */
export function Technical({ children }: { children: ReactNode }) {
  return useSimpleMode() ? null : <>{children}</>;
}

export function Card({ children, className, title, subtitle, actions }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx("rounded-xl border border-line bg-panel p-4 shadow-[0_1px_0_rgba(0,0,0,0.02)]", className)}>
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES = {
  neutral: "bg-panel-2 text-muted border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  mongo: "bg-mongo-soft text-mongo border-transparent",
  voyage: "bg-voyage-soft text-voyage border-transparent",
  local: "bg-local-soft text-local border-transparent",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "neutral", className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const color = { neutral: "bg-muted", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", mongo: "bg-mongo", voyage: "bg-voyage", local: "bg-local" }[tone];
  return <span aria-hidden className={cx("inline-block h-2 w-2 rounded-full", color)} />;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; busy?: boolean };

export function Button({ variant = "secondary", size = "sm", busy, className, children, disabled, ...rest }: BtnProps) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90 border-transparent dark:text-[#0c1018]",
    secondary: "bg-panel text-ink border-line hover:bg-panel-2",
    ghost: "bg-transparent text-muted border-transparent hover:bg-panel-2 hover:text-ink",
    danger: "bg-panel text-danger border-line hover:bg-danger-soft",
  }[variant];
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        styles,
        className,
      )}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner() {
  return <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-xs text-muted">{children}</div>}
    </div>
  );
}

export function SectionHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent";

interface Toast {
  id: number;
  text: string;
  tone: Tone;
}
const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = "neutral") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cx("pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg", TONES[t.tone], "bg-panel")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Minimal markdown for briefings: **bold** headings and "- " bullets. Renders text only (no HTML injection). */
export function MiniMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        return (
          <div key={i}>
            {lines.map((line, j) => {
              const heading = line.match(/^\*\*(.+)\*\*$/);
              if (heading) return <h4 key={j} className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{heading[1]}</h4>;
              const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
              const content = renderInline(bullet ? bullet[1] : line);
              return bullet ? (
                <p key={j} className="flex gap-2">
                  <span className="text-muted">•</span>
                  <span>{content}</span>
                </p>
              ) : (
                <p key={j}>{content}</p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function renderInline(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>));
}
