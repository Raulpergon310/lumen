// Records a Chromium trace on the TV while pressing Down/Up, then prints where main-thread time went.
// Usage: node android/tools/trace.js
(async () => {
  const pages = await (await fetch('http://localhost:9333/json')).json();
  const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const events = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); }
    if (d.method === 'Tracing.dataCollected') events.push(...d.params.value);
    if (d.method === 'Tracing.tracingComplete') done();
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,gpu', transferMode: 'ReportEvents' });
  await send('Runtime.evaluate', { awaitPromise: true, expression: `(async () => {
    for (const k of ['ArrowDown','ArrowDown','ArrowDown','ArrowUp','ArrowUp','ArrowUp']) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 700));
    }})()` });
  await send('Tracing.end');
  await finished;
  const sums = {};
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    const k = e.name;
    (sums[k] ||= { total: 0, n: 0, max: 0 });
    sums[k].total += e.dur / 1000; sums[k].n++; sums[k].max = Math.max(sums[k].max, e.dur / 1000);
  }
  const top = Object.entries(sums).sort((a, b) => b[1].total - a[1].total).slice(0, 28);
  for (const [k, v] of top) console.log(k.padEnd(42), `${v.total.toFixed(0)}ms`.padStart(8), `n=${v.n}`.padStart(7), `max ${v.max.toFixed(0)}ms`);
  process.exit(0);
})();
