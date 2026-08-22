import { startHarness, cleanupTemp } from './e2e-harness.js';
const h = await startHarness({ real: true });
console.log('backend up; stopping in 5s');
await new Promise((r) => setTimeout(r, 5000));
h.stop();
await new Promise((r) => setTimeout(r, 3500));
cleanupTemp();
console.log('stop() returned; check procs now');
