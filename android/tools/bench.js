// Presses keys through tv.js on the TV and reports per-key handler time, dropped frames and long tasks.
// Usage: node android/tools/tv-eval.js "$(cat android/tools/bench.js)"
const keys = ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowUp'];
const long = [];
const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(Math.round(e.duration))));
po.observe({ type: 'longtask', buffered: false });
const res = [];
for (const k of keys) {
  const t0 = performance.now();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const sync = performance.now() - t0;
  const frames = [];
  let last = performance.now();
  await new Promise((done) => {
    const end = performance.now() + 700;
    const tick = (t) => { frames.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else done(); };
    requestAnimationFrame(tick);
  });
  const worst = Math.max(...frames);
  res.push(`${k}: js ${sync.toFixed(1)}ms, frames ${frames.length}/700ms, peor ${worst.toFixed(0)}ms → ${document.activeElement.className.slice(0, 20)}`);
}
po.disconnect();
return { res, longTasks: long };
