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
  const winAtRef = useRef(null);

  useEffect(() => {
    return onSnapshot(doc(db, "lbw_stats", "global"), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.nextWinAt) winAtRef.current = d.nextWinAt.toMillis();
    });
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (winAtRef.current) {
        const rem = winAtRef.current - Date.now();
        setCountdown(rem > 0 ? rem : 0);
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

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
        background: color, boxShadow:`0 0 8px ${color}`,
        animation: "blink 1.5s ease infinite", flexShrink:0,
      }}/>

      {/* Timer */}
      <div style={{
        fontFamily:   "'Space Mono',monospace",
        fontSize:     18, fontWeight:700,
        color, letterSpacing:"-0.02em", lineHeight:1,
        animation: urgent ? "countdown-pulse 0.5s ease infinite" : "none",
      }}>
        {fmtTime(countdown)}
      </div>

      {/* Close */}
      <button
        onClick={() => setVisible(false)}
        style={{
          background:"none", border:"none", cursor:"pointer",
          color:"rgba(255,255,255,0.3)", fontSize:13,
          lineHeight:1, padding:"0 0 0 4px", transition:"color 0.2s",
        }}
        onMouseEnter={e => e.currentTarget.style.color="rgba(255,255,255,0.7)"}
        onMouseLeave={e => e.currentTarget.style.color="rgba(255,255,255,0.3)"}
      >×</button>
    </div>
  );
}