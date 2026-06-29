import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef } from "react";

const SelectRoot = SelectPrimitive.Root;

type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
};

const Select = ({ value, onValueChange, children }: SelectProps) => (
  <SelectRoot value={value} onValueChange={onValueChange}>
    {children}
  </SelectRoot>
);

type SelectTriggerProps = React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  unstyled?: boolean;
};

const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className = "", children, unstyled = false, ...props }, ref) => (
    <SelectPrimitive.Trigger
      ref={ref}
      className={`${
        unstyled
          ? "w-full disabled:cursor-not-allowed disabled:opacity-50"
          : "flex h-11 w-full items-center justify-between rounded-[8px] border border-[rgba(255,255,255,0.1)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:border-[rgba(255,255,255,0.18)] focus:border-[rgba(255,255,255,0.18)] focus:outline-none data-[state=open]:border-[rgba(255,255,255,0.18)] data-[state=open]:bg-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
      } ${className}`}
      {...props}
    >
      <span className={`${unstyled ? "flex h-full min-w-0 flex-1 items-center" : "flex-1 min-w-0"}`}>
        {children}
      </span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={16} className="ml-2 shrink-0 text-[var(--text-muted)]" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
);
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectValue = forwardRef<HTMLSpanElement, React.ComponentProps<typeof SelectPrimitive.Value>>(
  ({ className = "", placeholder, ...props }, ref) => (
    <SelectPrimitive.Value ref={ref} className={`truncate block max-w-full ${className}`} placeholder={placeholder} {...props} />
  )
);
SelectValue.displayName = SelectPrimitive.Value.displayName;

const SelectContent = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof SelectPrimitive.Content>
>(({ className = "", children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={`relative z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[8px] border border-[rgba(255,255,255,0.1)] bg-[rgba(20,24,31,0.98)] shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ${position === "popper" ? "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1" : ""} ${className}`}
      position={position}
      {...props}
    >
      <SelectPrimitive.Viewport
        className="p-1"
        style={{
          width: "var(--radix-select-trigger-width)",
          minWidth: "var(--radix-select-trigger-width)"
        }}
      >
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = forwardRef<HTMLDivElement, React.ComponentProps<typeof SelectPrimitive.Item>>(
  ({ className = "", children, ...props }, ref) => (
    <SelectPrimitive.Item
      ref={ref}
      className={`relative flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition-colors data-[highlighted]:bg-[var(--surface-soft)] data-[highlighted]:text-[var(--text-primary)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className}`}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto shrink-0">
        <Check size={14} className="text-[var(--mc-grass)]" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
);
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectLabel = forwardRef<HTMLLabelElement, React.ComponentProps<typeof SelectPrimitive.Label>>(
  ({ className = "", ...props }, ref) => (
    <SelectPrimitive.Label
      ref={ref}
      className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] ${className}`}
      {...props}
    />
  )
);
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectSeparator = forwardRef<HTMLDivElement, React.ComponentProps<typeof SelectPrimitive.Separator>>(
  ({ className = "", ...props }, ref) => (
    <SelectPrimitive.Separator
      ref={ref}
      className={`-mx-1 my-1 h-px bg-[rgba(255,255,255,0.05)] ${className}`}
      {...props}
    />
  )
);
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

// Attach sub-components
Select.Trigger = SelectTrigger;
Select.Value = SelectValue;
Select.Content = SelectContent;
Select.Item = SelectItem;
Select.Label = SelectLabel;
Select.Separator = SelectSeparator;
Select.Group = SelectPrimitive.Group;

export default Select;
