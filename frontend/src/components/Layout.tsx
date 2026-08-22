import { useEffect, useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import Lenis from 'lenis';
import { useAuth } from '../lib/auth';
import { logout, hasFirebaseConfig } from '../lib/firebase';
import {
  SquaresFour,
  Robot,
  Plugs,
  Scroll,
  Fire,
  ClipboardText,
  Gear,
  PushPin,
  PushPinSlash,
  Storefront,
  Broadcast,
  GitBranch,
  Checks,
  HardDrives,
  UsersThree,
  FileText,
  Rewind,
  Cube,
  ClockCounterClockwise,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

// Liquid-glass floating sidebar (v1.1 premium): detached rounded panel,
// collapsed icon rail with centered circular chips, expands on hover,
// pin keeps it expanded. Active items light the icon chip with the accent
// gradient; hover is a whisper, not a show.

interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  badge?: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: SquaresFour },
  { to: '/agents', label: 'Agents', icon: Robot },
  { to: '/test-mcp', label: 'Connectors', icon: Plugs },
  { to: '/policies', label: 'Policies', icon: Scroll },
  { to: '/firewall', label: 'Firewall', icon: Fire },
  { to: '/logs', label: 'Audit Log', icon: ClipboardText },
  { to: '/marketplace', label: 'Marketplace', icon: Storefront },
  { to: '/settings', label: 'Settings', icon: Gear },
];

export default function Layout() {
  const { user, mockSignOut } = useAuth();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;

  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';

  // Heavy, damped smooth scrolling (skipped for reduced-motion users)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const lenis = new Lenis({ lerp: 0.08, smoothWheel: true });
    let raf = 0;
    const loop = (time: number) => { lenis.raf(time); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); lenis.destroy(); };
  }, []);
  const displayInitial = (
    user?.displayName?.charAt(0) ||
    user?.email?.charAt(0) ||
    '?'
  ).toUpperCase();

  async function handleSignOut() {
    if (!hasFirebaseConfig) {
      mockSignOut();
    } else {
      await logout();
    }
  }

  return (
    <div className="lyt-root">
      <aside
        className={`lyt-sidebar ${expanded ? 'expanded' : ''} ${pinned ? 'pinned' : ''}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="lyt-side-top">
          <NavLink to="/" className="lyt-logo" title="Context Fence">
            <span className="lyt-logo-mark" aria-hidden>
              <img src="/icon.png" alt="" />
            </span>
            <span className="lyt-logo-word">Context<b>Fence</b></span>
          </NavLink>
          <button
            className="lyt-pin"
            onClick={() => setPinned((p) => !p)}
            title={pinned ? 'Unpin sidebar (collapse on mouse leave)' : 'Pin sidebar (keep expanded)'}
            aria-pressed={pinned}
          >
            {pinned ? <PushPinSlash weight="fill" size={14} /> : <PushPin weight="fill" size={14} />}
          </button>
        </div>

        <nav className="lyt-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `lyt-link ${isActive ? 'active' : ''}`}
              title={item.label}
            >
              <span className="lyt-link-icon"><item.icon weight="fill" size={18} /></span>
              <span className="lyt-link-label">{item.label}</span>
              {item.badge && <span className="lyt-link-badge">{item.badge}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="lyt-side-bottom">
          <NavLink to="/profile" className="lyt-avatar" title={`${displayName} — profile`}>
            {user?.photoURL ? (
              <img src={user.photoURL} alt="" referrerPolicy="no-referrer" />
            ) : (
              displayInitial
            )}
          </NavLink>
          <span className="lyt-user-label">{displayName}</span>
          <button onClick={handleSignOut} className="lyt-signout" title="Sign out">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </aside>

      <main className="lyt-main">
        <div className="lyt-container">
          <Outlet />
        </div>
      </main>

      <style>{`
/* Lenis smooth scroll */
html.lenis, html.lenis body { height: auto; }
.lenis.lenis-smooth { scroll-behavior: auto !important; }
.lenis.lenis-smooth [data-lenis-prevent] { overscroll-behavior: contain; }
.lenis.lenis-stopped { overflow: hidden; }

.lyt-root { min-height: 100vh; background: var(--bg-app); }

/* ── Liquid-glass floating sidebar ────────────────────────────────────── */
.lyt-sidebar {
  position: fixed; top: 16px; bottom: 16px; left: 16px; z-index: 100;
  width: 76px;
  display: flex; flex-direction: column;
  padding: 16px 12px 14px;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--card-border);
  border-radius: 28px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.35),
    0 10px 36px rgba(16, 24, 32, 0.1);
  transition: width 260ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 260ms ease;
  overflow: hidden;
}
.lyt-sidebar.expanded {
  width: 244px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.35),
    0 18px 56px rgba(16, 24, 32, 0.16);
}
@media (prefers-reduced-transparency: reduce) {
  .lyt-sidebar { background: var(--bg-surface); -webkit-backdrop-filter: none; backdrop-filter: none; }
}

/* Collapsed: everything centers. Expanded: logo/pin split, labels flow. */
.lyt-side-top { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 14px; min-height: 36px; }
.expanded .lyt-side-top { justify-content: space-between; gap: 8px; }
/* Collapsed: kill the inter-item gaps so the mark sits dead-center in the rail */
.lyt-sidebar:not(.expanded) .lyt-side-top { gap: 0; }
.lyt-sidebar:not(.expanded) .lyt-logo { gap: 0; }
.lyt-logo { display: flex; align-items: center; gap: 11px; text-decoration: none; flex-shrink: 0; }
.lyt-logo-mark {
  width: 36px; height: 36px; border-radius: 12px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(16, 24, 32, 0.2);
}
/* Horizontal padding is asymmetric (right 3 / left 1) to nudge the drawn
   glyph 1px left inside the centered tile — a box transform won't show here
   because the tile is overflow:hidden and the same width as the img. */
.lyt-logo-mark img { width: 100%; height: 100%; object-fit: contain; padding: 2px 3px 2px 1px; }
.lyt-logo-word {
  font-size: 16.5px; font-weight: 500; letter-spacing: -0.02em;
  color: var(--text-primary); line-height: 1; white-space: nowrap;
  opacity: 0; width: 0; transition: opacity 180ms ease 80ms, width 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.lyt-logo-word b { font-weight: 750; }
.expanded .lyt-logo-word { opacity: 1; width: auto; }
.lyt-pin {
  width: 32px; height: 32px; border-radius: 10px; flex-shrink: 0;
  border: none; cursor: pointer;
  background: transparent; color: var(--text-muted);
  display: flex; align-items: center; justify-content: center;
  transition: background 160ms ease, color 160ms ease;
  opacity: 0; width: 0; padding: 0;
}
.expanded .lyt-pin { opacity: 1; width: 32px; }
.lyt-pin:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.lyt-sidebar.pinned .lyt-pin { color: var(--accent-coral); background: var(--sidebar-active-bg); }

.lyt-nav { display: flex; flex-direction: column; gap: 3px; flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; }
.lyt-nav::-webkit-scrollbar { display: none; }

.lyt-link {
  position: relative;
  display: flex; align-items: center; justify-content: center; gap: 12px;
  height: 42px; padding: 0; border-radius: 999px;
  font-size: 14px; font-weight: 550; letter-spacing: -0.005em;
  color: var(--sidebar-text); text-decoration: none; white-space: nowrap;
  transition: background 200ms ease, color 160ms ease, border-radius 200ms ease;
}
.expanded .lyt-link { justify-content: flex-start; padding: 0 6px; }
.lyt-link:hover { background: var(--bg-surface-hover); color: var(--text-primary); }

/* Icon — ghost by default, no chip chrome; only the active state gets a surface */
.lyt-link-icon {
  width: 34px; height: 34px; border-radius: 999px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  color: var(--text-muted);
  transition: color 160ms ease, background 200ms ease, box-shadow 200ms ease,
    width 260ms cubic-bezier(0.22, 1, 0.36, 1),
    height 260ms cubic-bezier(0.22, 1, 0.36, 1),
    border-radius 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.lyt-link:hover .lyt-link-icon { color: var(--text-primary); }
.lyt-link-label {
  font-weight: 550;
  opacity: 0; width: 0; overflow: hidden;
  transition: opacity 180ms ease 80ms, width 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.expanded .lyt-link-label { opacity: 1; width: auto; flex: 1; min-width: 0; }

/* BETA / new badge — only visible in expanded state */
.lyt-link-badge {
  font-size: 9px; font-weight: 750; letter-spacing: 0.04em;
  padding: 2px 6px; border-radius: 4px;
  background: linear-gradient(135deg, rgba(99,102,241,0.18), rgba(139,92,246,0.12));
  border: 1px solid rgba(99,102,241,0.35);
  color: #6366f1;
  opacity: 0; width: 0; overflow: hidden; white-space: nowrap; flex-shrink: 0;
  transition: opacity 180ms ease 100ms, width 260ms cubic-bezier(0.22, 1, 0.36, 1);
  margin-left: -2px;
}
.expanded .lyt-link-badge { opacity: 1; width: auto; }
.lyt-link.active .lyt-link-badge { color: #818cf8; border-color: rgba(129,140,248,0.5); }
:root[data-theme="dark"] .lyt-link-badge { color: #818cf8; background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.4); }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .lyt-link-badge { color: #818cf8; background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.4); } }

/* Active: the lit circle keeps the same 34px size whether the sidebar is
   expanded or collapsed — it does NOT shrink in the expanded state. The
   collapsed side still pins 34px (below the 42px tile) so it doesn't reach
   edge-to-edge against the rail. */
.lyt-link.active { color: var(--accent-coral); font-weight: 650; background: var(--sidebar-active-bg); }
.lyt-link.active .lyt-link-icon {
  background: linear-gradient(150deg, #ff5163, #ff3144);
  color: #ffffff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.28),
    0 2px 10px rgba(255, 49, 68, 0.32);
}
.lyt-sidebar:not(.expanded) .lyt-link.active .lyt-link-icon {
  width: 34px; height: 34px; border-radius: 999px;
}
/* Collapsed: the circular icon chip IS the tile — one 42px circle, no overlay
   behind it. The same chip that lights up expanded, so the state morphs instead
   of jumping. */
.lyt-sidebar:not(.expanded) .lyt-link { width: 42px; margin: 0 auto; }
.lyt-sidebar:not(.expanded) .lyt-link .lyt-link-icon { width: 42px; height: 42px; border-radius: 999px; }
.lyt-sidebar:not(.expanded) .lyt-link.active { background: transparent; }
.lyt-sidebar:not(.expanded) .lyt-link:hover .lyt-link-icon { background: var(--bg-surface-hover); }

.lyt-side-bottom {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding-top: 14px; margin-top: 8px;
  border-top: 1px solid var(--border-default);
}
.expanded .lyt-side-bottom { justify-content: flex-start; }
.lyt-avatar {
  width: 34px; height: 34px; border-radius: 50%; overflow: hidden;
  background: linear-gradient(150deg, #397e70, #2c6156);
  color: #fff; font-size: 13px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  text-decoration: none; flex-shrink: 0;
}
.lyt-avatar img { width: 100%; height: 100%; object-fit: cover; }
.lyt-user-label {
  flex: 1; font-size: 13px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; width: 0; transition: opacity 180ms ease 80ms, width 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.expanded .lyt-user-label { opacity: 1; width: auto; }
.lyt-signout {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  border: none; cursor: pointer;
  background: transparent; color: var(--text-muted);
  display: flex; align-items: center; justify-content: center;
  transition: background 160ms ease, color 160ms ease;
  opacity: 0; width: 0; padding: 0;
}
.expanded .lyt-signout { opacity: 1; width: 32px; }
.lyt-signout:hover { background: rgba(255, 49, 68, 0.1); color: var(--accent-coral); }

/* ── Content (clears the rail; expansion overlays) ────────────────────── */
.lyt-main {
  margin-left: 104px;
  padding: 26px 24px 48px;
  min-height: 100vh;
}
.lyt-container { max-width: 1404px; margin: 0 auto; }
      `}</style>
    </div>
  );
}
