import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'minecraft-success' | 'minecraft-primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  fullWidth?: boolean;
  launchProgress?: boolean;
  launchProgressPercent?: number | null;
}

const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  launchProgress = false,
  launchProgressPercent = null,
  className = '',
  children,
  style,
  ...props
}) => {
  const baseStyles =
    'inline-flex items-center justify-center font-medium transition-all duration-[var(--duration-normal)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-grass)]/45 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-primary)] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none active:translate-y-[0.5px]';

  const variants = {
    primary:
      'bg-[var(--mc-grass)] text-white rounded-xl border border-[#25b87a]/50 hover:bg-[var(--mc-grass-dark)] hover:-translate-y-0.5',
    secondary:
      'bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-xl border border-white/5 hover:bg-[var(--bg-elevated)] hover:-translate-y-0.5',
    outline:
      'bg-transparent border border-white/5 text-[var(--text-secondary)] hover:border-white/10 hover:text-[var(--text-primary)] rounded-xl hover:bg-[var(--surface-soft)]',
    ghost:
      'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] rounded-xl',
    danger:
      'bg-[var(--accent-danger)]/12 text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/20 rounded-xl border border-[#ff6b8f]/25',
    'minecraft-success':
      'bg-[var(--mc-grass)] text-white rounded-xl border border-[#25b87a]/50 shadow-[0_8px_20px_rgba(95,111,255,0.2)] hover:bg-[var(--mc-grass-dark)] hover:shadow-[0_10px_24px_rgba(95,111,255,0.26)] hover:-translate-y-0.5',
    'minecraft-primary':
      'bg-[var(--mc-grass)] text-white rounded-xl border border-[#25b87a]/50 shadow-[0_8px_20px_rgba(95,111,255,0.2)] hover:bg-[var(--mc-grass-dark)] hover:shadow-[0_10px_24px_rgba(95,111,255,0.26)] hover:-translate-y-0.5',
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
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${fullWidth ? 'w-full' : ''} ${launchProgress ? 'launch-button-progress' : ''} ${className}`}
      data-launching={launchProgress ? "true" : "false"}
      data-launch-progress-known={progress === null ? "false" : "true"}
      style={
        progress === null
          ? style
          : ({ ...style, ["--launch-progress" as string]: `${progress}%` } as React.CSSProperties)
      }
      {...props}
    >
      {children}
    </button>
  );
};

export default Button;
