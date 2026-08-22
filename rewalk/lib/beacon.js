// The shared transient that anchors audio to the DOM.
//
// rrweb stamps Date.now(); the audio file starts whenever the capture device
// actually delivered its first sample, which is not when we asked. Anchoring on
// "ffmpeg start time" bakes that unknown latency into every window, and the
// audio clock then drifts against the system clock on top of it.
//
// So emit something both timelines can see: a short tone, played by the page and
// picked up by the same microphone that records the voice. Each burst is stamped
// into the event stream at emission. The detector finds the same bursts in the
// waveform, and two lists of times for the same events give offset AND drift
// instead of one guessed anchor.
//
// Repeat rather than anchoring once: one burst gives an offset, a sequence gives
// a slope, and it is the slope that decision 1 warned about.
(() => {
  if (window.__rewalkBeacon || location.href === 'about:blank') return;
  window.__rewalkBeacon = 1;

  const FREQ = 1970;       // clear of speech fundamentals and their low harmonics
  const MS = 120;          // long enough to detect, short enough to ignore
  // Deliberately NOT a constant interval. Evenly spaced beacons alias: if the
  // detector misses some, an offset shifted by one whole interval explains the
  // survivors just as well, and the fit locks onto it with a clean residual and
  // a confident wrong answer. Measured: a 5s-uniform train recovered the start
  // time 5009ms late while reporting 0.77ms residual. Jittered spacing makes
  // the pattern unique, so only one alignment can fit.
  const EVERY_MS = 5000;
  const JITTER_MS = 900;
  const GAIN = 0.06;       // audible to the mic, not unpleasant to sit next to

  let ctx = null, seq = 0;
  const emit = (data) => {
    try { window.rrweb?.record?.addCustomEvent?.('rewalk-beacon', data); } catch (e) {}
  };

  const ping = () => {
    try {
      ctx = ctx ?? new (window.AudioContext ?? window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = FREQ;
      osc.type = 'sine';
      // Ramp the envelope: an instant gate produces a click whose broadband
      // energy the detector would find at every frequency, including this one.
      const t = ctx.currentTime + 0.02;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(GAIN, t + 0.012);
      g.gain.setValueAtTime(GAIN, t + MS / 1000 - 0.012);
      g.gain.linearRampToValueAtTime(0, t + MS / 1000);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + MS / 1000 + 0.01);
      // Stamp the wall clock for the instant the tone is scheduled to sound,
      // not for the instant we asked for it: AudioContext.currentTime and
      // Date.now() are both available here, so the conversion is exact.
      const lead = (t - ctx.currentTime) * 1000;
      emit({ seq: seq++, wall: Date.now() + lead, freq: FREQ, ms: MS });
    } catch (e) {
      emit({ seq: seq++, error: String(e) });
    }
  };

  // Autoplay policy: no audio before a gesture. Start on the first interaction
  // and say so, rather than silently producing a recording with no anchors.
  // A deterministic but non-repeating sequence: no Math.random, so a recording
  // can be re-derived, and no period for a missed beacon to hide behind.
  const gap = (k) => EVERY_MS + Math.round(JITTER_MS * Math.sin(k * 2.399963));
  const schedule = (k) => setTimeout(() => { ping(); schedule(k + 1); }, gap(k));
  const start = () => {
    ping();
    schedule(1);
    removeEventListener('click', start, true);
    removeEventListener('keydown', start, true);
  };
  addEventListener('click', start, true);
  addEventListener('keydown', start, true);
  window.__rewalkPing = ping;
})();
