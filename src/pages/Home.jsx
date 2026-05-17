import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot, collection, query, orderBy, limit } from "firebase/firestore";
import { db } from "../firebase";

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const TOKEN_CA  = "Exmff76TBNGYxob2WEJb28c12R6TjSvLv2zpbo6Xpump";
const PUMP_URL  = "https://pump.fun/coin/" + TOKEN_CA;
const X_URL     = "https://x.com/LastBuyerWins26";
const MIN_BUY   = 0.1;
const TIMER_DEF = 60_000;

// ── Helpers ────────────────────────────────────────────────────────────────────
const short  = (a) => a ? `${a.slice(0,4)}...${a.slice(-4)}` : "—";
const fmtSOL = (n, d=4) => n == null ? "—" : Number(n).toFixed(d);
const fmtPct = (n) => n == null ? "—" : `${Number(n).toFixed(1)}%`;
const fmtTime = (ms) => {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms/1000);
  return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
};
const timeAgo = (ms) => {
  if (!ms) return "";
  const s = Math.floor((Date.now()-ms)/1000);
  if (s < 5)  return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s/60)}m ago`;
};

function useWindowWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

// ── Confetti on win ────────────────────────────────────────────────────────────
function Confetti({ active }) {
  if (!active) return null;
  const pieces = Array.from({length: 60}, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    delay: Math.random() * 0.8,
    dur: 1.5 + Math.random() * 1.5,
    color: ["#39FF14","#FFB800","#FF2020","#fff","#39FF14","#FFB800"][i % 6],
    size: 4 + Math.random() * 8,
    rot: Math.random() * 360,
  }));

  return (
    <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:9999, overflow:"hidden" }}>
      {pieces.map(p => (
        <div key={p.id} style={{
          position: "absolute",
          left: `${p.x}%`,
          top: "-20px",
          width: p.size,
          height: p.size,
          background: p.color,
          borderRadius: p.id % 3 === 0 ? "50%" : 2,
          transform: `rotate(${p.rot}deg)`,
          animation: `confetti-fall ${p.dur}s ease-in ${p.delay}s forwards`,
        }}/>
      ))}
      <style>{`
        @keyframes confetti-fall {
          0%   { transform: rotate(0deg) translateY(0); opacity:1; }
          100% { transform: rotate(720deg) translateY(110vh); opacity:0; }
        }
      `}</style>
    </div>
  );
}

// ── Buy toast notification ─────────────────────────────────────────────────────
// Max 2 visible at once. Small pill style. Never covers content.
function BuyToast({ toasts }) {
  // Only show the 2 most recent
  const visible = toasts.slice(-2);
  return (
    <div style={{
      position:"fixed", top:80, right:20, zIndex:500,
      display:"flex", flexDirection:"column", gap:6,
      pointerEvents:"none", alignItems:"flex-end",
      maxWidth:220,
    }}>
      {visible.map(t => (
        <div key={t.id} style={{
          padding: "7px 12px",
          background: "rgba(13,13,13,0.92)",
          border: "1px solid rgba(57,255,20,0.25)",
          borderRadius: 20,
          backdropFilter: "blur(12px)",
          display: "flex", alignItems:"center", gap:8,
          animation: "toast-in 0.25s ease",
          boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
          whiteSpace:"nowrap",
        }}>
          <div style={{ width:5, height:5, borderRadius:"50%", background:"var(--green)", flexShrink:0 }}/>
          <span style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--white)" }}>
            {short(t.wallet)}
          </span>
          <span style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--green)", fontWeight:700 }}>
            ◎{fmtSOL(t.amount, 3)}
          </span>
        </div>
      ))}
      <style>{`
        @keyframes toast-in {
          from { opacity:0; transform:translateX(10px); }
          to   { opacity:1; transform:translateX(0); }
        }
      `}</style>
    </div>
  );
}

// ── Ticker ─────────────────────────────────────────────────────────────────────
function Ticker({ stats, solPrice }) {
  const pot    = stats?.currentPotSOL?.toFixed(4) ?? "—";
  const potUSD = stats?.currentPotSOL && solPrice ? `$${(stats.currentPotSOL * solPrice).toFixed(0)}` : "";
  const paid   = stats?.totalPaid?.toFixed(4) ?? "0.0000";
  const rounds = stats?.totalRounds ?? 0;
  const big    = stats?.biggestPot?.toFixed(4) ?? "—";

  const base = [
    `POT ◎${pot}${potUSD ? " ("+potUSD+")" : ""}`,
    `TOTAL PAID ◎${paid}`,
    `ROUNDS ${rounds}`,
    `BIGGEST ◎${big}`,
    `MIN BUY ◎${MIN_BUY}`,
    `LAST BUYER WINS`,
  ];
  const items = [...base, ...base];

  return (
    <div style={{ overflow:"hidden", borderBottom:"1px solid var(--border)", background:"rgba(57,255,20,0.02)", padding:"8px 0" }}>
      <div style={{ display:"flex", gap:48, animation:"ticker-scroll 24s linear infinite", whiteSpace:"nowrap", width:"max-content" }}>
        {items.map((item, i) => (
          <span key={i} style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey)", letterSpacing:2 }}>
            <span style={{ color:"var(--green)", marginRight:14, fontSize:7 }}>◆</span>{item}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Leaderboard row ────────────────────────────────────────────────────────────
function LeaderRow({ entry, isMobile, animateIn }) {
  const isFirst = entry.position === 1;
  const opacity = Math.max(0.35, 1 - (entry.position - 1) * 0.12);

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "30px 1fr 72px 68px" : "38px 1fr 110px 110px 80px 72px",
      gap: isMobile ? 8 : 12,
      alignItems: "center",
      padding: isMobile ? "11px 14px" : "13px 20px",
      background: isFirst ? "rgba(57,255,20,0.04)" : "transparent",
      borderBottom: "1px solid rgba(255,255,255,0.03)",
      borderLeft: isFirst ? "2px solid var(--green)" : "2px solid transparent",
      animation: animateIn ? "leader-enter 0.3s ease" : "none",
      opacity,
      transition: "opacity 0.3s",
    }}>
      <div style={{
        width: isMobile?26:32, height: isMobile?26:32,
        borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
        background: isFirst ? "var(--green)" : "rgba(255,255,255,0.05)",
        fontFamily:"'Space Mono',monospace",
        fontSize: isFirst ? (isMobile?13:15) : (isMobile?10:11),
        fontWeight:700,
        color: isFirst ? "#000" : "var(--grey)",
        flexShrink:0,
        boxShadow: isFirst ? "0 0 14px rgba(57,255,20,0.5)" : "none",
      }}>
        {isFirst ? "★" : entry.position}
      </div>

      <div>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?11:13, color:isFirst?"var(--green)":"var(--white)", fontWeight:isFirst?700:400, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {short(entry.wallet)}
        </div>
        {isFirst && <div style={{ fontFamily:"'Inter',sans-serif", fontSize:8, letterSpacing:3, color:"var(--green)", marginTop:1, opacity:0.7 }}>CURRENT LEADER</div>}
      </div>

      <div style={{ textAlign:"right", fontFamily:"'Space Mono',monospace", fontSize:isMobile?10:12, color:"var(--grey)" }}>◎{fmtSOL(entry.amount)}</div>

      <div style={{ textAlign:"right" }}>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?11:14, color:isFirst?"var(--green)":"var(--white)", fontWeight:700 }}>
          ◎{fmtSOL(entry.shareSol)}
        </div>
      </div>

      {!isMobile && (
        <div style={{ textAlign:"right" }}>
          <div style={{ display:"inline-block", padding:"2px 7px", borderRadius:3, background:isFirst?"rgba(57,255,20,0.12)":"rgba(255,255,255,0.04)", fontFamily:"'Space Mono',monospace", fontSize:10, color:isFirst?"var(--green)":"var(--grey)", fontWeight:700 }}>
            {fmtPct(entry.sharePercent)}
          </div>
        </div>
      )}

      {!isMobile && (
        <div style={{ textAlign:"right", fontFamily:"'Inter',sans-serif", fontSize:10, color:"var(--grey-dim)" }}>
          {entry.timestamp ? timeAgo(entry.timestamp.toMillis()) : ""}
        </div>
      )}
    </div>
  );
}

function Leaderboard({ entries, isMobile }) {
  const prevTopRef = useRef(null);
  const [newTop, setNewTop] = useState(null);

  useEffect(() => {
    if (!entries?.length) return;
    const top = entries[0]?.wallet;
    if (top && top !== prevTopRef.current) {
      setNewTop(top);
      setTimeout(() => setNewTop(null), 500);
    }
    prevTopRef.current = top;
  }, [entries]);

  if (!entries?.length) {
    return (
      <div style={{ border:"1px solid var(--border)", borderRadius:4, background:"var(--bg2)", padding:"40px 24px", textAlign:"center" }}>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey-dim)", letterSpacing:4 }}>WAITING FOR FIRST BUY....</div>
        <div style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"var(--grey-dim)", marginTop:8, opacity:0.5 }}>Minimum ◎{MIN_BUY} SOL to qualify</div>
      </div>
    );
  }

  return (
    <div style={{ border:"1px solid var(--border)", borderRadius:4, overflow:"hidden", background:"var(--bg2)" }}>
      <div style={{ display:"grid", gridTemplateColumns:isMobile?"30px 1fr 72px 68px":"38px 1fr 110px 110px 80px 72px", gap:isMobile?8:12, padding:isMobile?"7px 14px":"9px 20px", background:"var(--bg3)", borderBottom:"1px solid var(--border)" }}>
        {["#","WALLET",isMobile?"BOUGHT":"BUY AMT",isMobile?"WINS":"PAYOUT",...(isMobile?[]:["SHARE","WHEN"])].map((h,i)=>(
          <div key={i} style={{ fontFamily:"'Inter',sans-serif", fontSize:8, fontWeight:700, letterSpacing:3, color:"var(--grey-dim)", textAlign:i>1?"right":"left" }}>{h}</div>
        ))}
      </div>
      {entries.map(e => <LeaderRow key={e.wallet} entry={e} isMobile={isMobile} animateIn={e.wallet===newTop}/>)}
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function Home({ navigate }) {
  const width    = useWindowWidth();
  const isMobile = width < 768;
  const isLive   = TOKEN_CA !== "PASTE_TOKEN_CA_HERE";

  const [stats,     setStats]     = useState(null);
  const [winners,   setWinners]   = useState([]);
  const [countdown, setCountdown] = useState(TIMER_DEF);
  const [copiedCA,  setCopiedCA]  = useState(false);
  const [menuOpen,  setMenuOpen]  = useState(false);
  const [confetti,  setConfetti]  = useState(false);
  const [toasts,    setToasts]    = useState([]);
  const [solPrice,  setSolPrice]  = useState(null);

  const winAtRef      = useRef(null);
  const prevRoundRef  = useRef(null);
  const prevLeaderRef = useRef(null);
  const lockedRef     = useRef(false);

  // Stats
  useEffect(() => {
    return onSnapshot(doc(db,"lbw_stats","global"), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.nextWinAt) {
        const nextMs = d.nextWinAt.toMillis();
        if (nextMs > Date.now()) { winAtRef.current = nextMs; lockedRef.current = false; }
      }

      // Detect new round — fire confetti
      if (prevRoundRef.current !== null && d.totalRounds > prevRoundRef.current) {
        setConfetti(true);
        setTimeout(() => setConfetti(false), 4000);
      }
      prevRoundRef.current = d.totalRounds ?? 0;
    });
  }, []);

  // Detect new leader — show toast
  useEffect(() => {
    const lb = stats?.leaderboard;
    if (!lb?.length) return;
    const top = lb[0];
    if (top?.wallet && top.wallet !== prevLeaderRef.current) {
      if (prevLeaderRef.current !== null) {
        const id = Date.now();
        setToasts(t => [...t.slice(-1), { id, wallet:top.wallet, amount:top.amount, position:top.position }]);
        setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
      }
      prevLeaderRef.current = top.wallet;
    }
  }, [stats?.leaderboard]);

  // Winners history
  useEffect(() => {
    const q = query(collection(db,"lbw_history"), orderBy("timestamp","desc"), limit(5));
    return onSnapshot(q, snap => setWinners(snap.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);

  // Countdown — locks at 00:00 during payout processing
  useEffect(() => {
    const id = setInterval(() => {
      if (!winAtRef.current) return;
      const rem = winAtRef.current - Date.now();
      if (rem <= 0) { setCountdown(0); lockedRef.current = true; return; }
      if (lockedRef.current) return;
      setCountdown(rem);
    }, 200);
    return () => clearInterval(id);
  }, []);

  // SOL price
  useEffect(() => {
    const fetch = async () => {
      try {
        const r = await window.fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        const d = await r.json();
        if (d?.solana?.usd) setSolPrice(d.solana.usd);
      } catch {}
    };
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, []);

  const copyCA = () => {
    if (!isLive) return;
    navigator.clipboard.writeText(TOKEN_CA);
    setCopiedCA(true);
    setTimeout(() => setCopiedCA(false), 2200);
  };

  const leaderboard = stats?.leaderboard || [];
  const currentPot  = stats?.currentPotSOL ?? null;
  const totalPaid   = stats?.totalPaid ?? 0;
  const totalRounds = stats?.totalRounds ?? 0;
  const biggestPot  = stats?.biggestPot ?? 0;
  const leader      = leaderboard[0];
  const potUSD      = currentPot != null && solPrice ? currentPot * solPrice : null;
  const urgent      = countdown > 0 && countdown < 15_000;
  const warning     = countdown > 0 && countdown < 30_000 && !urgent;
  const timerColor  = urgent ? "var(--red)" : warning ? "var(--amber)" : "var(--green)";

  return (
    <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", position:"relative", zIndex:1 }}>
      <Confetti active={confetti}/>
      <BuyToast toasts={toasts}/>

      {/* ── HEADER ── */}
      <header style={{ position:"fixed", top:0, left:0, right:0, zIndex:100, display:"flex", alignItems:"center", justifyContent:"space-between", padding:isMobile?"11px 16px":"13px 28px", background:"rgba(8,8,8,0.96)", borderBottom:"1px solid var(--border)", backdropFilter:"blur(16px)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <img src="/logo.png" alt="" style={{ width:isMobile?28:32, height:isMobile?28:32, objectFit:"cover", borderRadius:4 }}/>
          <div>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:isMobile?15:19, letterSpacing:"0.12em", color:"var(--white)", lineHeight:1 }}>LAST BUYER WINS</div>
            {!isMobile && <div style={{ fontFamily:"'Space Mono',monospace", fontSize:7, color:"var(--grey)", letterSpacing:3 }}>ON SOLANA</div>}
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:isMobile?10:24 }}>
          {!isMobile && [["HOME",()=>navigate("home")],["HISTORY",()=>navigate("history")]].map(([l,fn])=>(
            <button key={l} onClick={fn} style={{ background:"none", border:"none", cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:11, fontWeight:700, letterSpacing:3, color:"var(--grey)", transition:"color 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
              onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
            >{l}</button>
          ))}
          <a href={X_URL} target="_blank" rel="noreferrer" style={{ fontFamily:"'Inter',sans-serif", fontSize:11, fontWeight:700, letterSpacing:3, color:"var(--grey)", textDecoration:"none" }}
            onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
            onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
          >𝕏</a>
          {isMobile && <button onClick={()=>setMenuOpen(o=>!o)} style={{ background:"none", border:"1px solid var(--border)", borderRadius:3, cursor:"pointer", color:"var(--grey)", padding:"5px 10px", fontSize:13 }}>{menuOpen?"✕":"☰"}</button>}
        </div>
      </header>

      {menuOpen && (
        <div style={{ position:"fixed", top:53, left:0, right:0, background:"var(--bg2)", borderBottom:"1px solid var(--border)", zIndex:99, padding:"12px 16px 20px" }}>
          {[["HOME",()=>{navigate("home");setMenuOpen(false);}],["HISTORY",()=>{navigate("history");setMenuOpen(false);}]].map(([l,fn])=>(
            <button key={l} onClick={fn} style={{ display:"block", width:"100%", background:"none", border:"none", cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:14, fontWeight:700, letterSpacing:3, color:"var(--grey)", textAlign:"left", padding:"12px 0", borderBottom:"1px solid var(--border)" }}>{l}</button>
          ))}
        </div>
      )}

      <div style={{ marginTop:isMobile?53:62 }}><Ticker stats={stats} solPrice={solPrice}/></div>

      {/* ── HERO — two column on desktop ── */}
      <section style={{ padding:isMobile?"32px 16px 40px":"56px 24px 52px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%", position:"relative" }}>

        {/* Subtle grain texture overlay */}
        <div style={{ position:"absolute", inset:0, backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E")`, pointerEvents:"none", opacity:0.4 }}/>

        <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"1fr 1fr", gap:isMobile?32:48, alignItems:"center" }}>

          {/* LEFT — countdown */}
          <div style={{ textAlign:isMobile?"center":"left" }}>
            {/* Status pill */}
            <div style={{ display:"inline-flex", alignItems:"center", gap:7, padding:"5px 12px", border:`1px solid ${timerColor}33`, borderRadius:20, marginBottom:20, background:`${timerColor}08` }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:timerColor, boxShadow:`0 0 6px ${timerColor}`, animation:"blink 1.5s ease infinite" }}/>
              <span style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:timerColor }}>
                {countdown<=0 ? "PROCESSING..." : urgent ? "FINAL COUNTDOWN" : warning ? "ENDING SOON" : "LIVE"}
              </span>
            </div>

            {/* Big timer */}
            <div style={{
              fontFamily: "'Space Mono',monospace",
              fontSize: isMobile ? "clamp(80px,22vw,120px)" : "clamp(80px,10vw,140px)",
              fontWeight: 700, lineHeight: 0.9,
              color: timerColor,
              letterSpacing: "-0.04em",
              animation: urgent ? "urgent-shake 0.35s ease infinite, countdown-pulse 0.5s ease infinite" : warning ? "countdown-pulse 2s ease infinite" : "none",
              textShadow: urgent ? `0 0 60px ${timerColor}` : warning ? `0 0 30px ${timerColor}` : "none",
              transition: "color 0.4s, text-shadow 0.4s",
              marginBottom: 12,
              position: "relative", zIndex:1,
            }}>
              {fmtTime(countdown)}
            </div>

            <div style={{ fontFamily:"'Inter',sans-serif", fontSize:isMobile?10:11, fontWeight:700, letterSpacing:"0.4em", color:"var(--grey)", marginBottom:isMobile?20:28 }}>
              UNTIL NEXT WINNER
            </div>

            {/* Stats row */}
            <div style={{ display:"flex", gap:isMobile?20:28, flexWrap:"wrap", justifyContent:isMobile?"center":"flex-start" }}>
              {[
                { label:"TOTAL PAID", value:"◎ "+fmtSOL(totalPaid) },
                { label:"ROUNDS", value:totalRounds.toString() },
                { label:"BIGGEST", value:"◎ "+fmtSOL(biggestPot) },
              ].map(s => (
                <div key={s.label}>
                  <div style={{ fontFamily:"'Inter',sans-serif", fontSize:8, fontWeight:700, letterSpacing:3, color:"var(--grey-dim)", marginBottom:4 }}>{s.label}</div>
                  <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?13:15, color:"var(--white)", fontWeight:700 }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT — pot + CTA */}
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            {/* Pot card */}
            <div style={{
              padding: isMobile?"24px":"32px",
              border: `1px solid ${urgent?"var(--red)":"rgba(57,255,20,0.2)"}`,
              borderRadius: 6,
              background: urgent ? "rgba(255,32,32,0.04)" : "rgba(57,255,20,0.02)",
              position:"relative", overflow:"hidden",
              animation: urgent ? "pulse-red 1s ease-in-out infinite" : "pulse-green 4s ease-in-out infinite",
              transition:"border-color 0.4s, background 0.4s",
            }}>
              {/* Top accent line */}
              <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, transparent, ${timerColor}, transparent)` }}/>

              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:5, color:"var(--grey)", marginBottom:12 }}>CURRENT POT</div>

              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?"clamp(32px,10vw,48px)":"clamp(36px,4vw,52px)", fontWeight:700, color:"var(--white)", lineHeight:1, marginBottom:6 }}>
                ◎ {fmtSOL(currentPot, 4)}
              </div>

              {potUSD != null && (
                <div style={{ fontFamily:"'Inter',sans-serif", fontSize:isMobile?18:22, fontWeight:700, color:"rgba(57,255,20,0.6)", marginBottom:10 }}>
                  ≈ ${potUSD.toFixed(2)}
                </div>
              )}

              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:10, color:"var(--grey)", borderTop:"1px solid var(--border)", paddingTop:10, marginTop:4 }}>
                shared by {leaderboard.length > 0 ? `top ${leaderboard.length} buyer${leaderboard.length>1?"s":""}` : "last buyer"}
              </div>
            </div>

            {/* CTA buttons */}
            <a href={PUMP_URL} target="_blank" rel="noreferrer" style={{ display:"block" }}>
              <button className="btn btn-green" style={{ width:"100%", fontSize:14, padding:"15px", letterSpacing:3 }}>
                BUY NOW ↗
              </button>
            </a>

            <button onClick={()=>navigate("history")} className="btn btn-outline" style={{ width:"100%", fontSize:12 }}>
              WINNERS HISTORY
            </button>

            <div style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"var(--grey-dim)", letterSpacing:1, textAlign:"center" }}>
              min ◎{MIN_BUY} SOL to qualify · top 5 wallets win
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:6, justifyContent:"center", padding:"8px 12px", background:"rgba(255,32,32,0.04)", border:"1px solid rgba(255,32,32,0.12)", borderRadius:4 }}>
              <span style={{ fontSize:10 }}>🚫</span>
              <span style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey)", letterSpacing:1 }}>
                Wallets holding <strong style={{ color:"var(--red)" }}>≥ 3.5%</strong> of supply are disqualified from winning
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── LEADERBOARD ── */}
      <section style={{ padding:isMobile?"0 16px 52px":"0 24px 64px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:7, height:7, borderRadius:"50%", background:"var(--green)", boxShadow:"0 0 8px var(--green)", animation:"blink 1.5s ease infinite" }}/>
            <span style={{ fontFamily:"'Inter',sans-serif", fontSize:10, fontWeight:700, letterSpacing:4, color:"var(--grey)" }}>LIVE LEADERBOARD</span>
          </div>
          <div style={{ flex:1, height:"1px", background:"linear-gradient(90deg, var(--border), transparent)" }}/>
          {leaderboard.length > 0 && <span style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"var(--grey-dim)" }}>{leaderboard.length}/5 spots</span>}
        </div>

        {/* Leader callout */}
        {leader && (
          <div style={{ marginBottom:10, padding:isMobile?"13px 16px":"15px 20px", border:"1px solid var(--green)", borderRadius:4, background:"rgba(57,255,20,0.03)", animation:"pulse-green 3s ease-in-out infinite", display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, flexWrap:"wrap" }}>
            <div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--green)", marginBottom:5 }}>★ LEADING — WINS 50%</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?13:15, color:"var(--white)", fontWeight:700 }}>{short(leader.wallet)}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?18:22, color:"var(--green)", fontWeight:700 }}>◎ {fmtSOL(leader.shareSol)}</div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey)", marginTop:3 }}>if nobody buys before timer ends</div>
            </div>
          </div>
        )}

        <Leaderboard entries={leaderboard} isMobile={isMobile}/>

        {leaderboard.length > 1 && (
          <div style={{ marginTop:10, padding:"10px 14px", border:"1px solid var(--border)", borderRadius:4, background:"var(--bg2)", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
            <div style={{ display:"flex", alignItems:"center", gap:7 }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:"var(--green)" }}/>
              <span style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"var(--grey)" }}>Leader 50% → ◎{fmtSOL(leaderboard[0]?.shareSol)}</span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:7 }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:"var(--grey-dim)" }}/>
              <span style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"var(--grey)" }}>Pos 2-{leaderboard.length} split 50% → ◎{fmtSOL(leaderboard[1]?.shareSol)} each</span>
            </div>
          </div>
        )}
      </section>

      {/* ── HOW IT WORKS ── */}
      <section style={{ padding:isMobile?"0 16px 52px":"0 24px 64px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>
        <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:18 }}>
          <div style={{ flex:1, height:"1px", background:"linear-gradient(90deg, transparent, var(--border))" }}/>
          <span style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey)", whiteSpace:"nowrap" }}>HOW IT WORKS</span>
          <div style={{ flex:1, height:"1px", background:"linear-gradient(90deg, var(--border), transparent)" }}/>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)", gap:1, border:"1px solid var(--border)", borderRadius:4, overflow:"hidden" }}>
          {[
            { n:"01", title:"BUY",     desc:`Spend ◎${MIN_BUY}+ SOL to enter the leaderboard at position 1.` },
            { n:"02", title:"LEAD",    desc:"Every qualifying buy resets the countdown. You're the leader." },
            { n:"03", title:"HOLD",    desc:"Stay in the top 5 when the timer hits zero. Wallets holding ≥3.5% of supply are disqualified." },
            { n:"04", title:"WIN",     desc:"Leader takes 50%. Positions 2-5 split the other 50% equally." },
          ].map(s => (
            <div key={s.n} style={{ padding:isMobile?"16px 12px":"22px 18px", background:"var(--bg2)", borderRight:"1px solid var(--border)", position:"relative", overflow:"hidden" }}>
              <div style={{ position:"absolute", top:0, left:0, right:0, height:"1px", background:"linear-gradient(90deg, var(--green), transparent)", opacity:0.3 }}/>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?22:28, color:"rgba(57,255,20,0.1)", fontWeight:700, lineHeight:1, marginBottom:8 }}>{s.n}</div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:isMobile?12:13, fontWeight:700, color:"var(--white)", letterSpacing:1, marginBottom:5 }}>{s.title}</div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"var(--grey)", lineHeight:1.6 }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── RECENT WINNERS ── */}
      {winners.length > 0 && (
        <section style={{ padding:isMobile?"0 16px 52px":"0 24px 64px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>
          <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:16 }}>
            <div style={{ flex:1, height:"1px", background:"linear-gradient(90deg, transparent, var(--border))" }}/>
            <span style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey)", whiteSpace:"nowrap" }}>RECENT ROUNDS</span>
            <div style={{ flex:1, height:"1px", background:"linear-gradient(90deg, var(--border), transparent)" }}/>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:1, border:"1px solid var(--border)", borderRadius:4, overflow:"hidden" }}>
            {winners.map((w,i) => {
              const top = w.winners?.[0];
              return (
                <div key={w.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, padding:isMobile?"11px 14px":"13px 20px", background:i%2===0?"var(--bg2)":"var(--bg3)", flexWrap:"wrap" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"var(--grey-dim)", minWidth:22 }}>#{w.round}</div>
                    <div>
                      <div style={{ fontFamily:"'Space Mono',monospace", fontSize:11, color:"var(--white)" }}>
                        {short(top?.wallet)}{w.numWinners>1?` +${w.numWinners-1} more`:""}
                      </div>
                      <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", marginTop:2 }}>{w.timestamp?timeAgo(w.timestamp.toMillis()):""}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontFamily:"'Space Mono',monospace", fontSize:13, color:"var(--green)", fontWeight:700 }}>◎ {fmtSOL(w.pot)}</div>
                      <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", marginTop:2 }}>{w.numWinners} winner{w.numWinners>1?"s":""}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ textAlign:"center", marginTop:12 }}>
            <button onClick={()=>navigate("history")} className="btn btn-outline">VIEW ALL ROUNDS →</button>
          </div>
        </section>
      )}

      {/* ── CA ── */}
      <section style={{ padding:isMobile?"0 16px 52px":"0 24px 64px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>
        <div style={{ border:"1px solid var(--border)", borderRadius:4, padding:isMobile?"18px":"24px", background:"var(--bg2)", position:"relative", overflow:"hidden" }}>
          <div style={{ position:"absolute", top:0, left:0, right:0, height:"1px", background:"linear-gradient(90deg, transparent, rgba(57,255,20,0.3), transparent)" }}/>
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey)", marginBottom:10 }}>CONTRACT ADDRESS</div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?9:12, color:isLive?"var(--white)":"var(--grey)", wordBreak:"break-all", lineHeight:1.7, marginBottom:14, fontStyle:isLive?"normal":"italic" }}>
            {isLive ? TOKEN_CA : "— contract address at launch —"}
          </div>
          <div style={{ display:"flex", flexDirection:isMobile?"column":"row", gap:10 }}>
            {isLive && <button onClick={copyCA} className="btn btn-green" style={{ fontSize:11, padding:"11px 22px", width:isMobile?"100%":"auto" }}>{copiedCA?"COPIED ✓":"COPY CA"}</button>}
            <a href={X_URL} target="_blank" rel="noreferrer" style={{ width:isMobile?"100%":"auto" }}>
              <button className="btn btn-outline" style={{ width:isMobile?"100%":"auto" }}>𝕏 TWITTER</button>
            </a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{ borderTop:"1px solid var(--border)", padding:"16px 24px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginTop:"auto", background:"rgba(57,255,20,0.01)" }}>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey-dim)" }}>LAST BUYER WINS — ON SOLANA</div>
        {!isMobile && <div style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"var(--grey-dim)", fontStyle:"italic" }}>The clock resets. The pot grows. 5 wallets win.</div>}
        <a href={X_URL} target="_blank" rel="noreferrer" style={{ fontFamily:"'Inter',sans-serif", fontSize:10, letterSpacing:3, color:"var(--grey-dim)", textDecoration:"none" }}>𝕏</a>
      </footer>
    </div>
  );
}