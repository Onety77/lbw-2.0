import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

const TIMER_DEF = 60_000;

const fmtTime = (ms) => {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
};

export default function FloatingTimer() {
  const [countdown, setCountdown] = useState(TIMER_DEF);
  const [visible,   setVisible]   = useState(true);
  const [soundOn,   setSoundOn]   = useState(false);

  const winAtRef    = useRef(null);
  const lastSecRef  = useRef(null);
  const audioCtxRef = useRef(null);  // one persistent AudioContext
  const soundOnRef  = useRef(false); // ref mirrors state so interval always sees current value
  const lockedRef   = useRef(false); // true while waiting for new nextWinAt after round ends

  // Keep ref in sync with state
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);

  // Create AudioContext once on first sound toggle (needs user gesture)
  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume if browser suspended it
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  const playTick = (urgent) => {
    try {
      const ctx  = ensureAudioCtx();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = urgent ? 1000 : 520;
      gain.gain.setValueAtTime(urgent ? 0.12 : 0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
    } catch {}
  };

  // Firestore listener
  useEffect(() => {
    return onSnapshot(doc(db, "lbw_stats", "global"), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.nextWinAt) {
        const nextMs = d.nextWinAt.toMillis();
        // Only accept if it's in the future — this is a fresh round
        if (nextMs > Date.now()) {
          winAtRef.current = nextMs;
          lockedRef.current = false; // unlock — new round started
          lastSecRef.current = null;  // reset tick tracker
        }
      }
    });
  }, []);

  // Countdown interval — stable, never recreated
  useEffect(() => {
    const id = setInterval(() => {
      if (!winAtRef.current) return;

      const rem = winAtRef.current - Date.now();

      if (rem <= 0) {
        // Timer expired — lock at 00:00 until engine sends new nextWinAt
        setCountdown(0);
        if (!lockedRef.current) {
          lockedRef.current = true;
          lastSecRef.current = null;
        }
        return;
      }

      if (lockedRef.current) return; // waiting for new round — stay at 00:00

      setCountdown(rem);

      // Tick only when second changes
      if (soundOnRef.current) {
        const currentSec = Math.floor(rem / 1000);
        if (currentSec !== lastSecRef.current) {
          lastSecRef.current = currentSec;
          playTick(rem < 15_000);
        }
      }
    }, 200);
    return () => clearInterval(id);
  }, []); // empty deps — runs once, uses refs for live values

  if (!visible) return null;

  const urgent  = countdown > 0 && countdown < 15_000;
  const warning = countdown > 0 && countdown < 30_000 && !urgent;
  const color   = urgent ? "#FF2020" : warning ? "#FFB800" : "#39FF14";

  return (
    <div style={{
      position:      "fixed",
      bottom:        24,
      right:         24,
      zIndex:        999,
      display:       "flex",
      alignItems:    "center",
      gap:           10,
      padding:       "10px 16px",
      background:    "rgba(13,13,13,0.95)",
      border:        `1px solid ${color}44`,
      borderRadius:  40,
      backdropFilter:"blur(12px)",
      boxShadow:     urgent
        ? `0 0 24px rgba(255,32,32,0.4), 0 4px 20px rgba(0,0,0,0.5)`
        : `0 0 16px ${color}22, 0 4px 20px rgba(0,0,0,0.5)`,
      animation:     urgent ? "urgent-shake 0.4s ease infinite" : "fade-in 0.4s ease",
      transition:    "border-color 0.3s, box-shadow 0.3s",
      userSelect:    "none",
    }}>
      {/* Live dot */}
      <div style={{
        width:8, height:8, borderRadius:"50%",
        background:color, boxShadow:`0 0 8px ${color}`,
        animation:"blink 1.5s ease infinite", flexShrink:0,
      }}/>

      {/* Timer */}
      <div style={{
        fontFamily:  "'Space Mono',monospace",
        fontSize:    18, fontWeight:700,
        color, letterSpacing:"-0.02em", lineHeight:1,
        animation:   urgent ? "countdown-pulse 0.5s ease infinite" : "none",
      }}>
        {fmtTime(countdown)}
      </div>

      {/* Sound toggle */}
      <button
        onClick={() => {
          ensureAudioCtx(); // create/resume on user gesture
          setSoundOn(s => !s);
        }}
        title={soundOn ? "Mute ticking" : "Enable ticking"}
        style={{
          background:"none", border:"none", cursor:"pointer",
          fontSize:12, lineHeight:1, padding:"0 2px",
          opacity: soundOn ? 1 : 0.35,
          transition:"opacity 0.2s",
        }}
      >
        🔔
      </button>

      {/* Close */}
      <button
        onClick={() => setVisible(false)}
        style={{
          background:"none", border:"none", cursor:"pointer",
          color:"rgba(255,255,255,0.3)", fontSize:13,
          lineHeight:1, padding:"0 0 0 2px", transition:"color 0.2s",
        }}
        onMouseEnter={e => e.currentTarget.style.color="rgba(255,255,255,0.7)"}
        onMouseLeave={e => e.currentTarget.style.color="rgba(255,255,255,0.3)"}
      >×</button>
    </div>
  );
}