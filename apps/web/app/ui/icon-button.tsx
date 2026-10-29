"use client";

import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Tip } from "./overlay";

/** Every icon in the frame is one size and one stroke (docs/copy-style.md 「图标」). */
export const ICON = { size: 18, strokeWidth: 1.6, "aria-hidden": true } as const;

/**
 * A button that shows an icon instead of its words (2026-10-28 redesign): the words stay its accessible name and its hover tip, so a
 * screen reader and a pointer both get them, and it is an ordinary button for the keyboard. `tone="primary"` fills it with the accent.
 */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ComponentProps<"button">, "children"> & {
  label: string; icon: ReactNode; tone?: "plain" | "primary" | "alarm"; tip?: boolean;
}>(function IconButton({ label, icon, tone = "plain", tip = true, className = "", type = "button", ...rest }, ref) {
  const button = <button ref={ref} type={type} className={`ds-icon ${className}`.trim()} data-tone={tone} aria-label={label} {...rest}>{icon}</button>;
  return tip ? <Tip content={label}>{button}</Tip> : button;
});
