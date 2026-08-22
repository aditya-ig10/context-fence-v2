/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

// Main-process OAuth bridge (preload.js → window.cfOauth). The connector
// authorization-code flow: start(serverName) opens the provider's consent
// screen in the system browser and resolves when the flow completes.
interface Window {
  cfOauth?: {
    start(serverName: string): Promise<{ ok: boolean; error?: string }>;
  };
}

// Legacy Google/Apple sign-in bridge (LoginPage / firebase auth).
interface ElectronOAuthResult {
  success: boolean;
  oauthIdToken?: string;
  oauthAccessToken?: string;
  error?: string;
}

// Main-process update checker (preload.js → window.cfUpdates). Notify-only:
// check() hits the GitHub API and reports whether a newer release exists;
// nothing is ever downloaded or installed by the app.
interface Window {
  cfUpdates?: {
    check(): Promise<
      | { ok: true; current: string; latest: string; updateAvailable: boolean; releaseUrl: string; notes: string | null }
      | { ok: false; error: string }
    >;
  };
}

interface Window {
  electronAuth?: {
    startOAuth(provider: 'google' | 'apple'): Promise<ElectronOAuthResult>;
  };
}
