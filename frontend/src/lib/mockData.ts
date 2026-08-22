export const mockOpenCodeAgent = {
  agent: {
    type: 'opencode',
    stats: {
      last24h: [
        { hour: 0, tokens: 320 }, { hour: 1, tokens: 180 }, { hour: 2, tokens: 95 },
        { hour: 3, tokens: 62 }, { hour: 4, tokens: 48 }, { hour: 5, tokens: 110 },
        { hour: 6, tokens: 290 }, { hour: 7, tokens: 540 }, { hour: 8, tokens: 820 },
        { hour: 9, tokens: 940 }, { hour: 10, tokens: 870 }, { hour: 11, tokens: 760 },
        { hour: 12, tokens: 620 }, { hour: 13, tokens: 710 }, { hour: 14, tokens: 890 },
        { hour: 15, tokens: 960 }, { hour: 16, tokens: 840 }, { hour: 17, tokens: 730 },
        { hour: 18, tokens: 650 }, { hour: 19, tokens: 580 }, { hour: 20, tokens: 490 },
        { hour: 21, tokens: 410 }, { hour: 22, tokens: 380 }, { hour: 23, tokens: 350 },
      ],
      dailyUsage: [
        { day: '2026-07-15', tokens: 4200, input: 2600, output: 1600 },
        { day: '2026-07-16', tokens: 3800, input: 2200, output: 1600 },
        { day: '2026-07-17', tokens: 5100, input: 3100, output: 2000 },
        { day: '2026-07-18', tokens: 2900, input: 1700, output: 1200 },
        { day: '2026-07-19', tokens: 3500, input: 2000, output: 1500 },
        { day: '2026-07-20', tokens: 4800, input: 2800, output: 2000 },
        { day: '2026-07-21', tokens: 5600, input: 3400, output: 2200 },
        { day: '2026-07-22', tokens: 4400, input: 2600, output: 1800 },
        { day: '2026-07-23', tokens: 3900, input: 2300, output: 1600 },
        { day: '2026-07-24', tokens: 6200, input: 3800, output: 2400 },
        { day: '2026-07-25', tokens: 5800, input: 3500, output: 2300 },
        { day: '2026-07-26', tokens: 3400, input: 2000, output: 1400 },
        { day: '2026-07-27', tokens: 4700, input: 2900, output: 1800 },
        { day: '2026-07-28', tokens: 5300, input: 3200, output: 2100 },
        { day: '2026-07-29', tokens: 4900, input: 3000, output: 1900 },
      ],
    },
  },
};

export const mockAgentList = {
  agents: [
    { type: 'opencode' }, { type: 'opencode' },
    { type: 'claude' },
    { type: 'cursor' }, { type: 'cursor' },
    { type: 'codex' },
  ],
};

export const mockLogs = {
  logs: [
    { decision: 'allow' }, { decision: 'allow' }, { decision: 'deny' }, { decision: 'allow' },
    { decision: 'allow' }, { decision: 'log' }, { decision: 'allow' }, { decision: 'deny' },
    { decision: 'allow' }, { decision: 'allow' }, { decision: 'deny' }, { decision: 'log' },
    { decision: 'allow' }, { decision: 'allow' }, { decision: 'allow' }, { decision: 'deny' },
    { decision: 'allow' }, { decision: 'log' }, { decision: 'allow' }, { decision: 'deny' },
    { decision: 'allow' }, { decision: 'allow' }, { decision: 'allow' }, { decision: 'log' },
    { decision: 'deny' }, { decision: 'allow' }, { decision: 'allow' }, { decision: 'allow' },
    { decision: 'log' }, { decision: 'allow' }, { decision: 'deny' }, { decision: 'allow' },
    { decision: 'allow' }, { decision: 'allow' }, { decision: 'deny' }, { decision: 'allow' },
    { decision: 'log' }, { decision: 'allow' }, { decision: 'allow' }, { decision: 'deny' },
    { decision: 'allow' }, { decision: 'allow' }, { decision: 'log' }, { decision: 'deny' },
    { decision: 'allow' }, { decision: 'allow' }, { decision: 'log' }, { decision: 'allow' },
    { decision: 'deny' }, { decision: 'allow' },
  ],
};
