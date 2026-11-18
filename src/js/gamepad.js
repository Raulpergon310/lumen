// Game controllers (Xbox and the like, Moonlight's virtual pad when streaming from the PC with
// Sunshine) turned into the keys the app already understands: the d-pad and left stick are the
// arrows, A presses, B goes back (Escape), Start pauses, Y opens the options of what is focused, and
// the bumpers seek. Polls (about 30 times a second, with a timer: animation frames stop when the
// window is covered) only while a controller is connected.
const BUTTONS = {
  12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight',
  1: 'Escape', 8: 'Escape', 9: 'MediaPlayPause', 3: 'ContextMenu',
  4: 'MediaRewind', 5: 'MediaFastForward',
};
const PRESS = 0; // A
const REPEATS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const FIRST_REPEAT_MS = 420;
const REPEAT_MS = 130;
const STICK = 0.6;
const POLL_MS = 33;

function send(key) {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// A: what the remote's OK does. A synthetic Enter doesn't click buttons, so click directly.
function press() {
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.click === 'function' && !el.matches('input[type=text], input:not([type]), textarea')) el.click();
  else send('Enter');
}

export function startGamepad({ onUse } = {}) {
  if (!navigator.getGamepads) return;
  const held = new Map(); // action -> { since, last }
  let running = false;

  const frame = (now) => {
    const pads = [...navigator.getGamepads()].filter(Boolean);
    if (!pads.length) { running = false; held.clear(); return; }
    const down = new Set();
    for (const p of pads) {
      p.buttons.forEach((b, i) => {
        if (!b.pressed) return;
        if (i === PRESS) down.add('press');
        else if (BUTTONS[i]) down.add(BUTTONS[i]);
      });
      const [x = 0, y = 0] = p.axes;
      if (x <= -STICK) down.add('ArrowLeft');
      if (x >= STICK) down.add('ArrowRight');
      if (y <= -STICK) down.add('ArrowUp');
      if (y >= STICK) down.add('ArrowDown');
    }
    for (const action of down) {
      const h = held.get(action);
      let fire = false;
      if (!h) { held.set(action, { since: now, last: now }); fire = true; }
      else if (REPEATS.has(action) && now - h.since > FIRST_REPEAT_MS && now - h.last > REPEAT_MS) { h.last = now; fire = true; }
      if (!fire) continue;
      onUse?.();
      if (action === 'press') press();
      else send(action);
    }
    for (const action of [...held.keys()]) if (!down.has(action)) held.delete(action);
    setTimeout(() => frame(performance.now()), POLL_MS);
  };

  const start = () => {
    if (running) return;
    running = true;
    frame(performance.now());
  };
  window.addEventListener('gamepadconnected', start);
  // A controller already plugged in shows up once any of its buttons is pressed.
  if ([...navigator.getGamepads()].some(Boolean)) start();
}
