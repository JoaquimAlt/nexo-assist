import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tone } from '../data/labels';
import type { User } from '../data/types';

export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 3h4.2l7.6 11V3H20v18h-4.2L8.2 10v11H4z" fill="currentColor" />
    </svg>
  );
}

export const initials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

export function Avatar({ user, size = 40, online }: { user: Pick<User, 'name' | 'color'>; size?: number; online?: boolean }) {
  return (
    <span className={`avatar av-${user.color % 7}`} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden="true">
      {initials(user.name)}
      {online && <span className="avatar-online" />}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

export function StatusLabel({ tone, children, className = '' }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`status-label tone-${tone} ${className}`}>
      <Dot tone={tone} />
      {children}
    </span>
  );
}

/** Menu suspenso simples, fecha ao clicar fora ou com Esc. */
export function Menu({ trigger, children, align = 'right', placement = 'below' }: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  placement?: 'below' | 'above';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open && (
        <div className={`menu menu-${align} menu-${placement}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
