// Runs JS inside the Lumen WebView on the TV (needs: adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>).
// Usage: node android/tools/tv-eval.js "<expression>"   (await allowed; the result is printed as JSON)
const [, , expr] = process.argv;
(async () => {
  const pages = await (await fetch('http://localhost:9333/json')).json();
  const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id !== 1) return;
    const r = d.result?.result;
    console.log(d.result?.exceptionDetails ? 'ERROR ' + JSON.stringify(d.result.exceptionDetails.exception?.description) : JSON.stringify(r?.value ?? r, null, 1));
    process.exit(0);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true } }));
  setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
})();
