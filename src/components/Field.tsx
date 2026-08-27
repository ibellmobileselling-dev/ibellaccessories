import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Field = forwardRef<HTMLInputElement, Props>(function Field(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  return (
    <label className="flex flex-col gap-1 text-[12px]" htmlFor={id}>
      {label && <span className="text-muted-foreground font-medium">{label}</span>}
      <input
        ref={ref}
        id={id}
        className={cn(
          "h-8 px-2 border rounded bg-background outline-none focus:border-primary focus:ring-1 focus:ring-primary",
          error && "border-destructive",
          className,
        )}
        onWheel={(e) => {
          if (rest.type === "number") e.currentTarget.blur();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !(e.target as HTMLInputElement).form) return;
          if (e.key === "Enter") {
            e.preventDefault();
            const form = (e.target as HTMLInputElement).form;
            if (!form) return;
            const focusables = Array.from(
              form.querySelectorAll<HTMLElement>("input, select, textarea, button"),
            ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
            const idx = focusables.indexOf(e.target as HTMLElement);
            const next = e.shiftKey ? focusables[idx - 1] : focusables[idx + 1];
            next?.focus();
          }
          rest.onKeyDown?.(e);
        }}
        {...rest}
      />
      {error ? (
        <span className="text-destructive">{error}</span>
      ) : (
        hint && <span className="text-muted-foreground">{hint}</span>
      )}
    </label>
  );
});
