// The toolbar popup: choose what rewalk should do to this tab.
//
// The button used to BE the interface — one click started a recording that
// asked the daemon for the microphone, a second stopped it. That made the two
// decisions in this product invisible: whether to record at all, and whether
// to record voice. Commenting needs neither, and a DOM recording for a replay
// needs no microphone. So the click opens this instead, and every option says
// what it will actually do.
//
// MV3 forbids inline script on extension pages, which is why this is a file.
const $ = (id) => document.getElementById(id);

const ask = (msg) => new Promise((res) => {
  chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r));
});

/** @param {string} label @param {string} note @param {string} cls @param {() => void} onClick */
function button(label, note, cls, onClick) {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  b.textContent = label;
  if (note) { const s = document.createElement('small'); s.textContent = note; b.appendChild(s); }
  b.onclick = async () => { b.disabled = true; await onClick(); window.close(); };
  $('actions').appendChild(b);
}

async function render() {
  const state = await ask({ rewalk: 'state' });
  $('actions').textContent = '';
  if (!state) {
    $('sub').textContent = 'the extension background is not responding — reload it at chrome://extensions';
    return;
  }

  if (state.recording) {
    const voice = state.voice !== false;
    $('dot').className = `dot ${voice ? 'rec' : 'dom'}`;
    $('title').textContent = voice ? 'recording — voice on' : 'recording — DOM only';
    $('sub').textContent = (state.dir ? state.dir.split('/').pop() : 'a tab') +
      (state.sameTab ? '' : ' — another tab');
    button('Stop and finish', state.sameTab
      ? 'reads the session back and opens the replay'
      : 'ends the recording running in the other tab', 'stop',
      () => ask({ rewalk: 'stop' }));
    button(state.sameTab ? 'Comment, then stop' : 'Comment on this page',
      state.sameTab
        ? 'pick elements, write it, send — sending ends the recording'
        : 'this tab is not the one being recorded, so the comment travels without it', '',
      () => ask({ rewalk: 'annotate-active' }));
    $('why').textContent = voice
      ? 'Voice comes from the daemon or the companion, never from Chrome — macOS will not grant the browser a microphone.'
      : 'No microphone was asked for. The DOM stream still gives you a replay and source mapping.';
    return;
  }

  $('dot').className = 'dot';
  $('title').textContent = 'rewalk';
  $('sub').textContent = 'nothing is injected into this page yet';
  button('Comment on this page', 'no recording — just the elements you pick and what you say', 'primary',
    () => ask({ rewalk: 'annotate-active' }));
  button('Record this tab, DOM only', 'replay + source mapping, no microphone', '',
    () => ask({ rewalk: 'start', voice: false }));
  button('Record this tab with voice', 'narrate while you click; needs the daemon or the companion', '',
    () => ask({ rewalk: 'start', voice: true }));
  $('why').textContent = 'Recording reloads this tab so the recorder catches the whole page load.';
}

render();
