"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };
const ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
}

function read(): Theme {
  try {
    const t = localStorage.getItem("acc-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** System → light → dark. The choice is a per-browser convenience (localStorage), applied before paint by layout.tsx. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    // Read the saved choice after hydration, in a callback.
    const t = setTimeout(() => setTheme(read()), 0);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => read() === "system" && apply("system");
    mq.addEventListener("change", onChange);
    return () => {
      clearTimeout(t);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  return (
    <button
      type="button"
      className="grid h-7 w-7 place-items-center rounded-lg border border-line text-sm text-muted hover:bg-panel-2 hover:text-ink"
      aria-label={`${LABEL[theme]} (click to change)`}
      title={LABEL[theme]}
      onClick={() => {
        const next = NEXT[theme];
        try {
          if (next === "system") localStorage.removeItem("acc-theme");
          else localStorage.setItem("acc-theme", next);
        } catch {
          // storage unavailable: still apply for this page view
        }
        apply(next);
        setTheme(next);
      }}
    >
      <span aria-hidden>{ICON[theme]}</span>
    </button>
  );
}
