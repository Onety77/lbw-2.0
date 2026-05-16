import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

const TIMER_DEF = 60_000;

const fmtTime = (ms) => {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
};

// Play a tick using Web Audio API
function playTick(urgent) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    // Higher pitch and slightly louder as urgency increases
    osc.frequency.value = urgent ? 1000 : 520;
    gain.gain.setValueAtTime(urgent ? 0.12 : 0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.08);
    // Close context after sound finishes to avoid memory leak
    setTimeout(() => ctx.close(), 200);
  } catch {}
}

export default function FloatingTimer() {
  const [countdown, setCountdown] = useState(TIMER_DEF);
  const [visible,   setVisible]   = useState(true);
  const [soundOn,   setSoundOn]   = useState(false);
  const winAtRef     = useRef(null);
  const lastSecRef   = useRef(null); // tracks last second that played a tick

  useEffect(() => {
    return onSnapshot(doc(db, "lbw_stats", "global"), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.nextWinAt) winAtRef.current = d.nextWinAt.toMillis();
    });
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (!winAtRef.current) return;
      const rem = Math.max(0, winAtRef.current - Date.now());
      setCountdown(rem);

      // Only tick when the second actually changes
      if (soundOn && rem > 0) {
        const currentSec = Math.floor(rem / 1000);
        if (currentSec !== lastSecRef.current) {
          lastSecRef.current = currentSec;
          const urgent = rem < 15_000;
          playTick(urgent);
        }
      }
    }, 200); // check every 200ms for precision but tick only on second change
    return () => clearInterval(id);
  }, [soundOn]);

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
          setSoundOn(s => !s);
          lastSecRef.current = null; // reset so next second fires immediately
        }}
        title={soundOn ? "Mute ticking" : "Enable ticking"}
        style={{
          background:"none", border:"none", cursor:"pointer",
          fontSize:12, lineHeight:1, padding:"0 2px",
          opacity: soundOn ? 1 : 0.4,
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