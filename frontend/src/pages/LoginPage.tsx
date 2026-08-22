import { useState } from 'react';
import { motion } from 'framer-motion';
import Pattern from '../components/Pattern';
import { useAuth } from '../lib/auth';
import {
  loginWithGoogle,
  loginWithGoogleSystem,
  saveGoogleUserProfile,
  hasFirebaseConfig,
} from '../lib/firebase';
import { setPersistence, browserLocalPersistence } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { Zap } from 'lucide-react';

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="spinner-rotate" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export default function LoginPage({ transitioning = false }: { transitioning?: boolean }) {
  const { mockSignIn, signingIn, setSigningIn } = useAuth();
  const [error, setError] = useState('');
  const [loadingGoogle, setLoadingGoogle] = useState(false);

  async function handleGoogle() {
    setError('');
    setLoadingGoogle(true);
    if (!hasFirebaseConfig) {
      try {
        mockSignIn();
      } catch {
        setError('Sign-in unavailable.');
        setLoadingGoogle(false);
      }
      return;
    }
    try {
      await setPersistence(auth!, browserLocalPersistence);
      if (window.electronAuth) {
        setSigningIn(true);
        const user = await loginWithGoogleSystem();
        saveGoogleUserProfile(user).catch(() => {});
      } else {
        await loginWithGoogle();
      }
    } catch (err: unknown) {
      setSigningIn(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Sign-in failed. Please try again.');
      setLoadingGoogle(false);
    }
  }

  async function handleOffline() {
    setError('');
    try {
      mockSignIn();
    } catch {
      setError('Sign-in unavailable.');
    }
  }

  return (
    <div className={`auth-root ${transitioning ? 'auth-root--exit' : ''}`}>
      <Pattern opacity={0.04} />

      <div className="auth-ambient">
        <div className="auth-ambient-spot auth-ambient-spot--1" />
        <div className="auth-ambient-spot auth-ambient-spot--2" />
      </div>

      <div className="auth-frame">
        <motion.div
          className="auth-card"
          initial={{ opacity: 0, scale: 0.97, y: 16 }}
          animate={
            transitioning
              ? { opacity: 0.5, scale: 0.99, y: 4 }
              : { opacity: 1, scale: 1, y: 0 }
          }
          transition={
            transitioning
              ? { duration: 0.4, ease: [0.22, 1, 0.36, 1] }
              : { type: 'spring', stiffness: 220, damping: 28, mass: 1, delay: 0.08 }
          }
        >
          {/* Left Column: Form & Actions */}
          <div className="auth-panel auth-panel--left">
            <div className="auth-panel-inner">
              <div className="auth-brand-block">
                <div className="auth-brand-icon">
                  <img src="/icon.png" alt="Context Fence" style={{ width: 34, height: 34, objectFit: 'contain' }} />
                </div>
                <div className="auth-brand-text">
                  <span className="auth-brand-name">Context Fence</span>
                  <span className="auth-brand-label">Your AI Context Firewall</span>
                </div>
              </div>

              <motion.h1
                className="auth-heading"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                Welcome back.
              </motion.h1>

              <motion.p
                className="auth-desc"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                Continue protecting every AI conversation with local-first context security.
              </motion.p>

              <div className="auth-social">
                <motion.button
                  type="button"
                  className="social-btn social-btn--google"
                  onClick={handleGoogle}
                  disabled={loadingGoogle || signingIn}
                  whileHover={{ scale: 1.012, y: -2 }}
                  whileTap={{ scale: 0.988 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 26 }}
                >
                  {loadingGoogle || signingIn ? <Spinner /> : <GoogleIcon />}
                  <span>{signingIn ? 'Waiting for browser…' : 'Continue with Google'}</span>
                </motion.button>
              </div>

              {error && (
                <div className="auth-error-banner">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              <div className="auth-divider">
                <span className="auth-divider-line" />
                <span className="auth-divider-text">or</span>
                <span className="auth-divider-line" />
              </div>

              <motion.button
                type="button"
                className="social-btn social-btn--email"
                onClick={handleOffline}
                whileHover={{ scale: 1.012, y: -2 }}
                whileTap={{ scale: 0.988 }}
                transition={{ type: 'spring', stiffness: 450, damping: 26 }}
              >
                <Zap size={16} className="auth-zap-icon" />
                <span>Continue offline</span>
              </motion.button>
            </div>
          </div>

          {/* Right Column: Dynamic Moving Gradient Blur Orbs Canvas */}
          <div className="auth-panel auth-panel--right">
            <div className="auth-visual-canvas">
              {/* Animated Floating Gradient Blur Orbs */}
              <div className="orb orb--coral" />
              <div className="orb orb--teal" />
              <div className="orb orb--violet" />
              <div className="orb orb--amber" />
              <div className="orb orb--indigo" />
              <div className="orb orb--rose" />
              <div className="auth-visual-glass-overlay" />
            </div>
          </div>
        </motion.div>
      </div>

      <style>{`
        /* ─── Base Layout ─────────────────────────────────────────────────── */
        .auth-root {
          width: 100vw;
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Inter', system-ui, sans-serif;
          user-select: none;
          transition: background 300ms cubic-bezier(0.22, 1, 0.36, 1), color 300ms ease;
        }
        .auth-root--exit { opacity: 0.7; }

        .auth-ambient {
          position: absolute;
          inset: 0;
          z-index: 0;
          pointer-events: none;
        }
        .auth-ambient-spot {
          position: absolute;
          border-radius: 50%;
          will-change: transform;
          animation: ambientDrift 16s ease-in-out infinite;
        }
        @keyframes ambientDrift {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(2%, -3%) scale(1.04); }
          66% { transform: translate(-1%, 2%) scale(0.96); }
        }

        .auth-frame {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          padding: 6.5vh 6.5vw;
          box-sizing: border-box;
        }

        .auth-card {
          display: flex;
          width: 100%;
          height: 100%;
          max-width: 1100px;
          max-height: 680px;
          border-radius: 28px;
          backdrop-filter: blur(32px);
          -webkit-backdrop-filter: blur(32px);
          overflow: hidden;
          will-change: transform;
          transition: background 300ms ease, border-color 300ms ease, box-shadow 300ms ease;
        }

        .auth-panel {
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .auth-panel--left {
          flex: 0 0 46%;
          padding: 48px 48px;
          box-sizing: border-box;
        }
        .auth-panel--right {
          flex: 1;
          padding: 18px;
          min-width: 0;
          height: 100%;
          box-sizing: border-box;
        }

        .auth-panel-inner {
          width: 100%;
          max-width: 380px;
          display: flex;
          flex-direction: column;
        }

        .auth-brand-block {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 28px;
        }
        .auth-brand-icon {
          width: 50px;
          height: 50px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 14px;
        }
        .auth-brand-text {
          display: flex;
          flex-direction: column;
        }
        .auth-brand-name {
          font-size: 21px;
          font-weight: 700;
          letter-spacing: -0.02em;
          line-height: 1.2;
        }
        .auth-brand-label {
          font-size: 11px;
          font-weight: 650;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-top: 2px;
        }

        .auth-heading {
          font-size: 40px;
          font-weight: 700;
          letter-spacing: -0.035em;
          line-height: 1.08;
          margin: 0 0 16px;
        }

        .auth-desc {
          font-size: 15px;
          font-weight: 450;
          margin: 0 0 32px;
          line-height: 1.6;
        }

        .auth-social {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .social-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          width: 100%;
          height: 52px;
          border-radius: 14px;
          font-size: 14.5px;
          font-weight: 600;
          cursor: pointer;
          border: none;
          position: relative;
          overflow: hidden;
          outline: none;
          will-change: transform;
          padding: 0 24px;
          box-sizing: border-box;
          transition: all 200ms ease;
        }
        .social-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .auth-error-banner {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          margin-top: 14px;
          border-radius: 10px;
          background: rgba(255, 49, 68, 0.1);
          border: 1px solid rgba(255, 49, 68, 0.25);
          color: #ff5c6b;
          font-size: 12.5px;
          font-weight: 500;
          line-height: 1.4;
        }

        .auth-divider {
          display: flex;
          align-items: center;
          gap: 16px;
          margin: 20px 0;
        }
        .auth-divider-line {
          flex: 1;
          height: 1px;
        }
        .auth-divider-text {
          font-size: 11.5px;
          font-weight: 650;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }

        /* ─── Right Panel: Dynamic Moving Gradient Blur Orbs ─────────────── */
        .auth-visual-canvas {
          width: 100%;
          height: 100%;
          border-radius: 20px;
          position: relative;
          overflow: hidden;
          transition: background 300ms ease, border-color 300ms ease;
        }

        .orb {
          position: absolute;
          border-radius: 50%;
          will-change: transform;
          transition: opacity 300ms ease, filter 300ms ease;
        }

        .orb--coral {
          width: 280px;
          height: 280px;
          top: 15%;
          left: 10%;
          animation: orbDrift1 12s ease-in-out infinite alternate;
        }

        .orb--teal {
          width: 260px;
          height: 260px;
          bottom: 12%;
          right: 15%;
          animation: orbDrift2 14s ease-in-out infinite alternate;
        }

        .orb--violet {
          width: 320px;
          height: 320px;
          top: 35%;
          right: 10%;
          animation: orbDrift3 16s ease-in-out infinite alternate;
        }

        .orb--amber {
          width: 220px;
          height: 220px;
          bottom: 25%;
          left: 20%;
          animation: orbDrift4 13s ease-in-out infinite alternate;
        }

        .orb--indigo {
          width: 240px;
          height: 240px;
          top: 8%;
          right: 30%;
          animation: orbDrift5 15s ease-in-out infinite alternate;
        }

        .orb--rose {
          width: 250px;
          height: 250px;
          bottom: 10%;
          left: 10%;
          animation: orbDrift1 18s ease-in-out infinite alternate-reverse;
        }

        @keyframes orbDrift1 {
          0% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(120px, 80px) scale(1.2); }
          100% { transform: translate(40px, 160px) scale(0.9); }
        }

        @keyframes orbDrift2 {
          0% { transform: translate(0, 0) scale(1.1); }
          50% { transform: translate(-100px, -70px) scale(0.85); }
          100% { transform: translate(-40px, -130px) scale(1.15); }
        }

        @keyframes orbDrift3 {
          0% { transform: translate(0, 0) scale(0.9); }
          50% { transform: translate(-80px, 100px) scale(1.25); }
          100% { transform: translate(-140px, 30px) scale(1); }
        }

        @keyframes orbDrift4 {
          0% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(90px, -90px) scale(1.18); }
          100% { transform: translate(130px, -30px) scale(0.88); }
        }

        @keyframes orbDrift5 {
          0% { transform: translate(0, 0) scale(0.95); }
          50% { transform: translate(-90px, 90px) scale(1.1); }
          100% { transform: translate(50px, 120px) scale(1.05); }
        }

        .auth-visual-glass-overlay {
          position: absolute;
          inset: 0;
          z-index: 2;
          pointer-events: none;
        }

        @keyframes spinnerRotate {
          to { transform: rotate(360deg); }
        }
        .spinner-rotate {
          animation: spinnerRotate 0.8s linear infinite;
        }

        /* ─── LIGHT THEME (Default or data-theme="light") ────────────────── */
        .auth-root,
        :root[data-theme="light"] .auth-root {
          background: #f7f8fb;
          color: #12141d;
        }
        .auth-root .auth-ambient-spot--1,
        :root[data-theme="light"] .auth-root .auth-ambient-spot--1 {
          width: 55vmax; height: 55vmax; top: -15%; left: -10%;
          background: radial-gradient(circle, rgba(255, 49, 68, 0.04) 0%, transparent 60%);
        }
        .auth-root .auth-ambient-spot--2,
        :root[data-theme="light"] .auth-root .auth-ambient-spot--2 {
          width: 45vmax; height: 45vmax; bottom: -10%; right: -5%;
          background: radial-gradient(circle, rgba(47, 230, 176, 0.04) 0%, transparent 55%);
          animation-delay: -8s;
        }
        .auth-root .auth-card,
        :root[data-theme="light"] .auth-root .auth-card {
          background: #ffffff;
          border: 1px solid rgba(0, 0, 0, 0.08);
          box-shadow:
            0 1px 3px rgba(0, 0, 0, 0.02),
            0 20px 50px -12px rgba(0, 0, 0, 0.07),
            0 0 0 1px rgba(0, 0, 0, 0.03),
            inset 0 1px 0 #ffffff;
        }
        .auth-root .auth-brand-icon,
        :root[data-theme="light"] .auth-root .auth-brand-icon {
          background: #fff0f1;
          border: 1px solid #ffd5d8;
          box-shadow: 0 2px 10px rgba(255, 49, 68, 0.08);
        }
        .auth-root .auth-brand-name,
        :root[data-theme="light"] .auth-root .auth-brand-name { color: #111218; }
        .auth-root .auth-brand-label,
        :root[data-theme="light"] .auth-root .auth-brand-label { color: #76798c; }
        .auth-root .auth-heading,
        :root[data-theme="light"] .auth-root .auth-heading { color: #111218; }
        .auth-root .auth-desc,
        :root[data-theme="light"] .auth-root .auth-desc { color: #585a6c; }
        .auth-root .social-btn--google,
        :root[data-theme="light"] .auth-root .social-btn--google {
          background: #ffffff;
          color: #12141d;
          border: 1px solid #d8dae5;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 3px 8px rgba(0, 0, 0, 0.02);
        }
        .auth-root .social-btn--google:hover:not(:disabled),
        :root[data-theme="light"] .auth-root .social-btn--google:hover:not(:disabled) {
          background: #f8f9fd;
          border-color: #c0c3d4;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
        }
        .auth-root .social-btn--email,
        :root[data-theme="light"] .auth-root .social-btn--email {
          background: #f2f4f8;
          color: #2c2e3e;
          border: 1px solid #e1e4ec;
        }
        .auth-root .social-btn--email:hover:not(:disabled),
        :root[data-theme="light"] .auth-root .social-btn--email:hover:not(:disabled) {
          background: #e8ebf2;
          border-color: #d0d3de;
          color: #111218;
        }
        .auth-root .auth-zap-icon,
        :root[data-theme="light"] .auth-root .auth-zap-icon { color: #10b981; }
        .auth-root .auth-divider-line,
        :root[data-theme="light"] .auth-root .auth-divider-line { background: #e5e8f0; }
        .auth-root .auth-divider-text,
        :root[data-theme="light"] .auth-root .auth-divider-text { color: #82869a; }
        .auth-root .auth-visual-canvas,
        :root[data-theme="light"] .auth-root .auth-visual-canvas {
          background: #f3f5fa;
          border: 1px solid rgba(0, 0, 0, 0.06);
          box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.02);
        }
        .auth-root .orb,
        :root[data-theme="light"] .auth-root .orb {
          filter: blur(52px);
          opacity: 0.85;
          mix-blend-mode: normal;
        }
        .auth-root .orb--coral,
        :root[data-theme="light"] .auth-root .orb--coral {
          background: radial-gradient(circle, #ff6b7b 0%, rgba(255, 107, 123, 0.45) 50%, transparent 80%);
        }
        .auth-root .orb--teal,
        :root[data-theme="light"] .auth-root .orb--teal {
          background: radial-gradient(circle, #38d9a9 0%, rgba(56, 217, 169, 0.45) 50%, transparent 80%);
        }
        .auth-root .orb--violet,
        :root[data-theme="light"] .auth-root .orb--violet {
          background: radial-gradient(circle, #b197fc 0%, rgba(177, 151, 252, 0.45) 50%, transparent 80%);
        }
        .auth-root .orb--amber,
        :root[data-theme="light"] .auth-root .orb--amber {
          background: radial-gradient(circle, #ffd43b 0%, rgba(255, 212, 59, 0.45) 50%, transparent 80%);
        }
        .auth-root .orb--indigo,
        :root[data-theme="light"] .auth-root .orb--indigo {
          background: radial-gradient(circle, #748ffc 0%, rgba(116, 143, 252, 0.45) 50%, transparent 80%);
        }
        .auth-root .orb--rose,
        :root[data-theme="light"] .auth-root .orb--rose {
          background: radial-gradient(circle, #ff8787 0%, rgba(255, 135, 135, 0.45) 50%, transparent 80%);
        }
        .auth-root .auth-visual-glass-overlay,
        :root[data-theme="light"] .auth-root .auth-visual-glass-overlay {
          background: rgba(255, 255, 255, 0.12);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
        }

        /* ─── DARK THEME (data-theme="dark" or OS dark mode without light override) ─ */
        :root[data-theme="dark"] .auth-root,
        :root:not([data-theme="light"]) .auth-root {
          background: #050507;
          color: #e8e8f0;
        }
        :root[data-theme="dark"] .auth-root .auth-ambient-spot--1,
        :root:not([data-theme="light"]) .auth-root .auth-ambient-spot--1 {
          width: 55vmax; height: 55vmax; top: -15%; left: -10%;
          background: radial-gradient(circle, rgba(255, 49, 68, 0.08) 0%, transparent 60%);
        }
        :root[data-theme="dark"] .auth-root .auth-ambient-spot--2,
        :root:not([data-theme="light"]) .auth-root .auth-ambient-spot--2 {
          width: 45vmax; height: 45vmax; bottom: -10%; right: -5%;
          background: radial-gradient(circle, rgba(47, 230, 176, 0.06) 0%, transparent 55%);
        }
        :root[data-theme="dark"] .auth-root .auth-card,
        :root:not([data-theme="light"]) .auth-root .auth-card {
          background: rgba(13, 13, 18, 0.85);
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow:
            inset 0 1px 0 0 rgba(255, 255, 255, 0.12),
            0 24px 64px -12px rgba(0, 0, 0, 0.8),
            0 0 0 1px rgba(0, 0, 0, 0.6);
        }
        :root[data-theme="dark"] .auth-root .auth-brand-icon,
        :root:not([data-theme="light"]) .auth-root .auth-brand-icon {
          background: rgba(255, 49, 68, 0.1);
          border: 1px solid rgba(255, 49, 68, 0.25);
          box-shadow: 0 0 20px rgba(255, 49, 68, 0.15), inset 0 1px 1px rgba(255, 255, 255, 0.15);
        }
        :root[data-theme="dark"] .auth-root .auth-brand-name,
        :root:not([data-theme="light"]) .auth-root .auth-brand-name { color: #f7f7fa; }
        :root[data-theme="dark"] .auth-root .auth-brand-label,
        :root:not([data-theme="light"]) .auth-root .auth-brand-label { color: #8484a6; }
        :root[data-theme="dark"] .auth-root .auth-heading,
        :root:not([data-theme="light"]) .auth-root .auth-heading { color: #ffffff; }
        :root[data-theme="dark"] .auth-root .auth-desc,
        :root:not([data-theme="light"]) .auth-root .auth-desc { color: #8484a6; }
        :root[data-theme="dark"] .auth-root .social-btn--google,
        :root:not([data-theme="light"]) .auth-root .social-btn--google {
          background: rgba(255, 255, 255, 0.08);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.16);
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1);
        }
        :root[data-theme="dark"] .auth-root .social-btn--google:hover:not(:disabled),
        :root:not([data-theme="light"]) .auth-root .social-btn--google:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.14);
          border-color: rgba(255, 255, 255, 0.28);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.2);
        }
        :root[data-theme="dark"] .auth-root .social-btn--email,
        :root:not([data-theme="light"]) .auth-root .social-btn--email {
          background: rgba(255, 255, 255, 0.03);
          color: #c4c4d4;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        :root[data-theme="dark"] .auth-root .social-btn--email:hover:not(:disabled),
        :root:not([data-theme="light"]) .auth-root .social-btn--email:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.16);
          color: #ffffff;
        }
        :root[data-theme="dark"] .auth-root .auth-zap-icon,
        :root:not([data-theme="light"]) .auth-root .auth-zap-icon { color: #2fe6b0; }
        :root[data-theme="dark"] .auth-root .auth-divider-line,
        :root:not([data-theme="light"]) .auth-root .auth-divider-line { background: rgba(255, 255, 255, 0.08); }
        :root[data-theme="dark"] .auth-root .auth-divider-text,
        :root:not([data-theme="light"]) .auth-root .auth-divider-text { color: #62627a; }
        :root[data-theme="dark"] .auth-root .auth-visual-canvas,
        :root:not([data-theme="light"]) .auth-root .auth-visual-canvas {
          background: #08080d;
          border: 1px solid rgba(255, 255, 255, 0.06);
          box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.8);
        }
        :root[data-theme="dark"] .auth-root .orb,
        :root:not([data-theme="light"]) .auth-root .orb {
          filter: blur(55px);
          opacity: 0.75;
          mix-blend-mode: screen;
        }
        :root[data-theme="dark"] .auth-root .orb--coral,
        :root:not([data-theme="light"]) .auth-root .orb--coral {
          background: radial-gradient(circle, #ff3144 0%, rgba(255, 49, 68, 0.2) 70%, transparent 100%);
        }
        :root[data-theme="dark"] .auth-root .orb--teal,
        :root:not([data-theme="light"]) .auth-root .orb--teal {
          background: radial-gradient(circle, #2fe6b0 0%, rgba(47, 230, 176, 0.25) 70%, transparent 100%);
        }
        :root[data-theme="dark"] .auth-root .orb--violet,
        :root:not([data-theme="light"]) .auth-root .orb--violet {
          background: radial-gradient(circle, #7928ca 0%, rgba(121, 40, 202, 0.2) 70%, transparent 100%);
        }
        :root[data-theme="dark"] .auth-root .orb--amber,
        :root:not([data-theme="light"]) .auth-root .orb--amber {
          background: radial-gradient(circle, #ffb020 0%, rgba(255, 176, 32, 0.2) 70%, transparent 100%);
        }
        :root[data-theme="dark"] .auth-root .orb--indigo,
        :root:not([data-theme="light"]) .auth-root .orb--indigo {
          background: radial-gradient(circle, #4c6fce 0%, rgba(76, 111, 206, 0.2) 70%, transparent 100%);
        }
        :root[data-theme="dark"] .auth-root .orb--rose,
        :root:not([data-theme="light"]) .auth-root .orb--rose {
          background: radial-gradient(circle, #ff5a5f 0%, rgba(255, 90, 95, 0.25) 70%, transparent 100%);
        }
        :root[data-theme="dark"] .auth-root .auth-visual-glass-overlay,
        :root:not([data-theme="light"]) .auth-root .auth-visual-glass-overlay {
          background: rgba(8, 8, 13, 0.15);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
        }

        @media (max-width: 900px) {
          .auth-card { flex-direction: column; max-height: none; height: auto; }
          .auth-panel--left { flex: 1; padding: 36px 28px; }
          .auth-panel--right { flex: 0 0 240px; padding: 0 16px 16px; width: 100%; }
        }
      `}</style>
    </div>
  );
}
