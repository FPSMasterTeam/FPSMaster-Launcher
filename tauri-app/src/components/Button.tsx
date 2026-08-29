import React, { memo } from 'react';
import { LiquidGlassLayers } from './LiquidGlass';
import { useLiquidGlass } from '../hooks/useLiquidGlass';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  fullWidth?: boolean;
  launchProgress?: boolean;
  launchProgressPercent?: number | null;
  /**
   * Primary-CTA Liquid Glass: under the liquid visual profile the button
   * becomes colored glass (lensed backdrop + accent tint + hover energy +
   * elasticity). No-op in every other profile.
   */
  liquidGlass?: boolean;
}

const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  launchProgress = false,
  launchProgressPercent = null,
  liquidGlass = false,
  className = '',
  children,
  style,
  ...props
}) => {
  const glass = useLiquidGlass();
  const glassActive = liquidGlass && glass.active;
  const baseStyles =
    'inline-flex items-center justify-center font-medium transition-all duration-[var(--duration-normal)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-grass)]/45 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-primary)] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none active:translate-y-[0.5px]';

  const variants = {
    primary:
      'bg-[var(--mc-grass)] text-white rounded-[var(--radius-control)] border border-[rgba(var(--accent-rgb),0.4)] shadow-[0_1px_2px_rgba(0,0,0,0.2)] hover:bg-[var(--mc-grass-dark)]',
    secondary:
      'bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-[var(--radius-control)] border border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)] hover:border-[var(--border-medium)]',
    outline:
      'bg-transparent border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-medium)] hover:text-[var(--text-primary)] rounded-[var(--radius-control)] hover:bg-[var(--surface-soft)]',
    ghost:
      'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] rounded-[var(--radius-control)]',
    danger:
      'bg-[var(--accent-danger)]/12 text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/20 rounded-[var(--radius-control)] border border-[#ff6b8f]/25',
  };

  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2.5 text-sm',
    lg: 'px-6 py-3 text-base',
    xl: 'px-8 py-4 text-lg',
  };

  const progress =
    typeof launchProgressPercent === "number" && Number.isFinite(launchProgressPercent)
      ? Math.max(0, Math.min(100, launchProgressPercent))
      : null;

  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${fullWidth ? 'w-full' : ''} ${launchProgress ? 'launch-button-progress' : ''} ${className} ${glassActive ? glass.hostClassName : ''}`}
      data-launching={launchProgress ? "true" : "false"}
      data-launch-progress-known={progress === null ? "false" : "true"}
      style={
        progress === null
          ? style
          : ({ ...style, ["--launch-progress" as string]: `${progress}%` } as React.CSSProperties)
      }
      {...props}
    >
      {glassActive && (
        <LiquidGlassLayers
          mode="standard"
          displacementScale={36}
          aberrationIntensity={2}
          blur={6}
          tint="accent"
          interactive
          elastic
        />
      )}
      {children}
    </button>
  );
};

export default memo(Button);
