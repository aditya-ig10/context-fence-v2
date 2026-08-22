// Antigravity / Gemini CLI brand icon; if it 404s at runtime, renderers fall
// back to FALLBACK_ICON so the card never breaks.
export const ANTIGRAVITY_ICON = 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png';
export const FALLBACK_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8e706f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3"/><path d="M12 15h6"/></svg>',
);

export const LOGOS: Record<string, string> = {
  opencode: 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/opencode.png',
  claude: 'https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/claude-ai-icon.png',
  'claude-desktop': 'https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/claude-ai-icon.png',
  'claude-code': 'https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/claude-ai-icon.png',
  cursor: 'https://www.gartner.com/pi/vendorimages/anysphere_cursor_1771021658737.png',
  codex: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/dark/codex-color.png',
  copilot: 'https://img.icons8.com/3d-fluency/1200/github-copilot.jpg',
  cline: 'https://cline.bot/assets/branding/favicons/favicon-256x256.png',
  continue: 'https://avatars.githubusercontent.com/u/127876214?v=4',
  windsurf: 'https://windsurf.com/favicon_270.png',
  aider: 'https://aider.chat/assets/aider-square.jpg',
  // Gemini CLI / Antigravity — type key AND brand key both resolve here.
  gemini: ANTIGRAVITY_ICON,
  antigravity: ANTIGRAVITY_ICON,
  // Display-name key (lowercased agent name from the API).
  'gemini cli (antigravity)': ANTIGRAVITY_ICON,
};
