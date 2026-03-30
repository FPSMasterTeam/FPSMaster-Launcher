import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { type ComponentProps, forwardRef } from "react";

const CheckboxRoot = forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentProps<typeof CheckboxPrimitive.Root>
>(({ className = "", ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={`peer h-5 w-5 shrink-0 rounded border border-white/10 bg-[var(--bg-secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-grass)]/45 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[var(--mc-grass)]/50 data-[state=checked]:bg-[var(--mc-grass)] ${className}`}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-white">
      <Check size={14} strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
CheckboxRoot.displayName = CheckboxPrimitive.Root.displayName;

export { CheckboxRoot as Checkbox };
