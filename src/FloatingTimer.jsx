import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

const TIMER_DEF = 60_000;

const fmtTime = (ms) => {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
};

export default function FloatingTimer({ navigate }) {
  const [countdown, setCountdown] = useState(TIMER_DEF);
  const [potSOL,    setPotSOL]    = useState(null);
  const [solPrice,  setSolPrice]  = useState(null);
  const [visible,   setVisible]   = useState(true);
  const winAtRef = useRef(null);

  // Firestore stats
  useEffect(() => {
    return onSnapshot(doc(db, "lbw_stats", "global"), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.nextWinAt) winAtRef.current = d.nextWinAt.toMillis();
      if (d.currentPotSOL != null) setPotSOL(d.currentPotSOL);
    });
  }, []);

  // Countdown tick
  useEffect(() => {
    const id = setInterval(() => {
      if (winAtRef.current) {
        const rem = winAtRef.current - Date.now();
        setCountdown(rem > 0 ? rem : 0);
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  // SOL price — fetched once every 60s from CoinGecko (free, no API key)
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const res  = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        const data = await res.json();
        if (data?.solana?.usd) setSolPrice(data.solana.usd);
      } catch {}
    };
    fetchPrice();
    const id = setInterval(fetchPrice, 60_000);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  const urgent   = countdown > 0 && countdown < 15_000;
  const warning  = countdown > 0 && countdown < 30_000 && !urgent;
  const color    = urgent ? "#FF2020" : warning ? "#FFB800" : "#39FF14";
  const potUSD   = potSOL != null && solPrice ? (potSOL * solPrice).toFixed(2) : null;

  return (
    <div style={{
      position:     "fixed",
      bottom:       24,
      right:        24,
      zIndex:       999,
      display:      "flex",
      flexDirection:"column",
      alignItems:   "flex-end",
      gap:          8,
      animation:    "fade-in 0.4s ease",
    }}>
      {/* Main pill */}
      <div
        onClick={() => navigate && navigate("home")}
        style={{
          display:      "flex",
          alignItems:   "center",
          gap:          12,
          padding:      "10px 16px",
          background:   "rgba(13,13,13,0.95)",
          border:       `1px solid ${color}44`,
          borderRadius: 40,
          cursor:       navigate ? "pointer" : "default",
          backdropFilter: "blur(12px)",
          boxShadow:    urgent
            ? `0 0 24px rgba(255,32,32,0.4), 0 4px 20px rgba(0,0,0,0.5)`
            : `0 0 16px ${color}22, 0 4px 20px rgba(0,0,0,0.5)`,
          animation:    urgent ? "urgent-shake 0.4s ease infinite" : "none",
          transition:   "border-color 0.3s, box-shadow 0.3s",
          userSelect:   "none",
        }}
      >
        {/* Live dot */}
        <div style={{
          width:        7,
          height:       7,
          borderRadius: "50%",
          background:   color,
          boxShadow:    `0 0 8px ${color}`,
          animation:    "blink 1.5s ease infinite",
          flexShrink:   0,
        }}/>

        {/* Timer */}
        <div style={{
          fontFamily:  "'Space Mono',monospace",
          fontSize:    18,
          fontWeight:  700,
          color,
          letterSpacing: "-0.02em",
          lineHeight:  1,
          animation:   urgent ? "countdown-pulse 0.5s ease infinite" : "none",
        }}>
          {fmtTime(countdown)}
        </div>

        {/* Divider */}
        <div style={{ width:1, height:18, background:"rgba(255,255,255,0.1)" }}/>

        {/* Pot */}
        <div style={{ textAlign:"right" }}>
          <div style={{
            fontFamily:   "'Space Mono',monospace",
            fontSize:     12,
            fontWeight:   700,
            color:        "#fff",
            lineHeight:   1,
          }}>
            ◎ {potSOL != null ? potSOL.toFixed(3) : "—"}
          </div>
          {potUSD && (
            <div style={{
              fontFamily: "'Inter',sans-serif",
              fontSize:   9,
              color:      "rgba(255,255,255,0.4)",
              marginTop:  2,
              lineHeight: 1,
            }}>
              ${potUSD}
            </div>
          )}
        </div>

        {/* Close */}
        <button
          onClick={e => { e.stopPropagation(); setVisible(false); }}
          style={{
            background: "none", border:"none", cursor:"pointer",
            color:      "rgba(255,255,255,0.3)",
            fontSize:   12, lineHeight:1, padding:"0 0 0 4px",
            transition: "color 0.2s",
          }}
          onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,0.7)"}
          onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.3)"}
        >×</button>
      </div>

      {/* Urgent label */}
      {urgent && (
        <div style={{
          fontFamily:   "'Inter',sans-serif",
          fontSize:     9,
          fontWeight:   700,
          letterSpacing:3,
          color:        "#FF2020",
          textAlign:    "right",
          animation:    "blink 0.5s ease infinite",
          paddingRight: 16,
        }}>
          FINAL COUNTDOWN
        </div>
      )}
    </div>
  );
}