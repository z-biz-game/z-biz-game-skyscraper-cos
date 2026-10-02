// Synthesised feedback, no sample files. A puzzle game's sound is a *state* readout —
// "a height went down", "that height breaks a clue", "every clue adds up" — and each of those is
// one short envelope, so a synth keeps the artifact small and the vocabulary honest.

let ctx = null;
let master = null;
let enabled = true;
// `held` is the pause / backgrounded latch. It is separate from `enabled` because the two are
// released by different things: the player's mute switch, and the run's own state machine.
let held = false;
// Every oscillator this module has ever created. A muted or held tab must leave this number
// untouched — that is the difference between "the volume is 0" and "the instrument is off".
let voices = 0;

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
  // The auto-resume is here for the browser's autoplay gesture rule, and it must not undo a mute
  // or a pause: without the `!held && enabled` guard, any later tone() would wake the context up
  // behind the switch that put it to sleep.
  if (ctx.state === 'suspended' && enabled && !held) ctx.resume().catch(() => {});
  return ctx;
}

// The single gate every sound passes through. Returning false means no node is created at all, so
// a muted run does not keep an instrument running and burn CPU on envelopes nobody can hear.
function gate() {
  return enabled && !held;
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is
// a call to this; adding a second voice shape is how a game ends up with sounds that do not
// belong to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  if (!gate()) return false;
  const ac = audio();
  if (!ac) return false;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  voices++;
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return true;
}

// Taking the audio hardware down is what makes the switch a mute instead of a volume knob. The
// promise is kept in both directions: suspending must not throw when the context was never built
// (a browser with no AudioContext, or a page nobody has clicked yet).
function park() {
  if (!ctx) return;
  try {
    if (gate()) ctx.resume().catch(() => {});
    else ctx.suspend().catch(() => {});
  } catch {
    /* a context that refuses to change state is not worth crashing a gesture over */
  }
}

export const Sound = {
  setEnabled(v) {
    enabled = !!v;
    park();
    return enabled;
  },
  enabled: () => enabled,

  // The mute switch, named for what it does. `sound` stays the stored setting (an archive written
  // by an older build keeps working), and `muted` is its exact complement — no third flag that
  // could disagree with the first.
  setMuted(v) {
    return this.setEnabled(!v);
  },
  muted: () => !enabled,
  toggleMute() {
    return this.setEnabled(!enabled);
  },

  // Held by the pause / tab-hidden path. Distinct from mute: the player's own switch is persisted,
  // this one is a property of the moment and is never written to storage.
  setHeld(v) {
    held = !!v;
    park();
    return held;
  },
  held: () => held,
  // For the harness: prove a muted or paused run creates no new oscillator nodes.
  voices: () => voices,

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
