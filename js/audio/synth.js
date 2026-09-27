// Synthesised feedback, no sample files. A puzzle game's sound is a *state* readout —
// "a height went down", "that height breaks a clue", "every clue adds up" — and each of those is
// one short envelope, so a synth keeps the artifact small and the vocabulary honest.

let ctx = null;
let master = null;
let enabled = true;

function audio() {
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is
// a call to this; adding a second voice shape is how a game ends up with sounds that do not
// belong to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac || !enabled) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const Sound = {
  setEnabled(v) {
    enabled = !!v;
  },
  enabled: () => enabled,

  // The written digit is the only thing with a pitch of its own: height k plays the k-th step of
  // the same scale, so "a 5 went in" is audible without looking.
  place(k = 1, n = 5) {
    const step = Math.max(0, Math.min(n - 1, k - 1));
    tone({ f0: 440 * Math.pow(2, step / 5), f1: 440 * Math.pow(2, (step + 1) / 5), dur: 0.13, type: 'triangle', gain: 0.19 });
  },
  note() {
    tone({ f0: 660, f1: 660, dur: 0.05, type: 'square', gain: 0.06 });
  },
  erase() {
    tone({ f0: 300, f1: 220, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // Two detuned voices: an interval that is deliberately unpleasant, for the one thing the
  // player must notice without looking.
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
