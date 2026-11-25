// Child process for the lock test: saves N handoffs and N decisions into one repo, as fast as it can.
// Usage: node concurrent-save.mjs <repo> <worker> <n>   (TAGTEAM_HOME comes from the parent)
const [root, worker, n] = process.argv.slice(2);
if (!root) process.exit(0); // `node --test` also runs every file under test/; nothing to do then
const { capture } = await import('../../src/handoff.js');
const store = await import('../../src/store.js');
for (let i = 0; i < Number(n); i++) {
  capture(root, { source: 'agent', agent: `w${worker}`, fields: { next_action: `w${worker}-${i}` } });
  store.addDecision(root, { date: '2026-01-01', decision: `w${worker}-${i}` });
}
