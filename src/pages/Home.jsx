import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot, collection, query, orderBy, limit } from "firebase/firestore";
import { db } from "../firebase";

// ── CONFIG — update these before deploying ─────────────────────────────────────
const TOKEN_CA   = "PASTE_TOKEN_CA_HERE";
const PUMP_URL   = "https://pump.fun/coin/" + TOKEN_CA;
const X_URL      = "https://x.com/REPLACE_HANDLE";
const SITE_NAME  = "lastbuyerwins.xyz";
const MIN_BUY    = 0.1;
const TIMER_DEF  = 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const short = (a) => a ? `${a.slice(0,4)}...${a.slice(-4)}` : "—";
const fmtSOL = (n, d = 4) => (n == null ? "—" : Number(n).toFixed(d));
const fmtPct = (n) => (n == null ? "—" : `${Number(n).toFixed(1)}%`);
const fmtTime = (ms) => {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const timeAgo = (ms) => {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5)  return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
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

// ── Countdown component ────────────────────────────────────────────────────────
function Countdown({ ms }) {
  const urgent  = ms > 0 && ms < 15_000;
  const warning = ms > 0 && ms < 30_000 && !urgent;
  const done    = ms <= 0;

  const color = urgent ? "var(--red)" : warning ? "var(--amber)" : "var(--green)";

  return (
    <div style={{ position:"relative", textAlign:"center" }}>
      <div style={{
        fontFamily: "'Space Mono',monospace",
        fontSize:   "clamp(72px, 18vw, 160px)",
        fontWeight: 700,
        lineHeight: 0.9,
        color,
        letterSpacing: "-0.03em",
        animation: done
          ? "none"
          : urgent
            ? "urgent-shake 0.4s ease infinite, countdown-pulse 0.5s ease infinite"
            : warning
              ? "countdown-pulse 1.5s ease infinite"
              : "countdown-pulse 3s ease infinite",
        transition: "color 0.5s ease",
        position: "relative",
        zIndex: 1,
      }}>
        {done ? "00:00" : fmtTime(ms)}
      </div>

      {/* Ambient glow behind timer */}
      <div style={{
        position: "absolute",
        top: "50%", left: "50%",
        transform: "translate(-50%,-50%)",
        width: "clamp(200px,50vw,500px)",
        height: "clamp(200px,50vw,500px)",
        borderRadius: "50%",
        background: `radial-gradient(circle, ${color}08 0%, transparent 70%)`,
        animation: urgent
          ? "pulse-red 0.5s ease infinite"
          : warning
            ? "pulse-green 1.5s ease infinite"
            : "pulse-green 3s ease infinite",
        pointerEvents: "none",
        zIndex: 0,
        transition: "background 0.5s ease",
      }}/>

      <div style={{
        marginTop: 8,
        fontFamily: "'Inter',sans-serif",
        fontSize: "clamp(9px,2vw,12px)",
        fontWeight: 700,
        letterSpacing: "0.4em",
        color: done ? "var(--grey)" : color,
        transition: "color 0.5s ease",
      }}>
        {done ? "PROCESSING PAYOUT..." : urgent ? "FINAL COUNTDOWN" : warning ? "ENDING SOON" : "UNTIL NEXT WINNER"}
      </div>
    </div>
  );
}

// ── Ticker ─────────────────────────────────────────────────────────────────────
function Ticker({ stats }) {
  const pot    = stats?.currentPotSOL?.toFixed(4) ?? "—";
  const paid   = stats?.totalPaid?.toFixed(4) ?? "0.0000";
  const rounds = stats?.totalRounds ?? 0;
  const big    = stats?.biggestPot?.toFixed(4) ?? "—";

  const items = [
    `CURRENT POT ◎${pot}`,
    `TOTAL PAID ◎${paid}`,
    `ROUNDS PLAYED ${rounds}`,
    `BIGGEST POT ◎${big}`,
    `MIN BUY ◎${MIN_BUY} SOL`,
    `LAST BUYER WINS`,
    `CURRENT POT ◎${pot}`,
    `TOTAL PAID ◎${paid}`,
    `ROUNDS PLAYED ${rounds}`,
    `BIGGEST POT ◎${big}`,
    `MIN BUY ◎${MIN_BUY} SOL`,
    `LAST BUYER WINS`,
  ];

  return (
    <div style={{ overflow:"hidden", borderBottom:"1px solid var(--border)", background:"var(--bg2)", padding:"9px 0" }}>
      <div style={{ display:"flex", gap:48, animation:"ticker-scroll 22s linear infinite", whiteSpace:"nowrap", width:"max-content" }}>
        {items.map((item, i) => (
          <span key={i} style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey)", letterSpacing:2 }}>
            <span style={{ color:"var(--green)", marginRight:16, fontSize:8 }}>◆</span>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Leaderboard row ────────────────────────────────────────────────────────────
function LeaderRow({ entry, isMobile, animateIn }) {
  const isFirst = entry.position === 1;
  const opacity = Math.max(0.3, 1 - (entry.position - 1) * 0.08);

  return (
    <div style={{
      display:        "grid",
      gridTemplateColumns: isMobile ? "32px 1fr 80px 70px" : "40px 1fr 120px 120px 90px 80px",
      gap:            isMobile ? 8 : 12,
      alignItems:     "center",
      padding:        isMobile ? "12px 14px" : "14px 20px",
      background:     isFirst ? "rgba(57,255,20,0.05)" : "transparent",
      borderBottom:   "1px solid rgba(255,255,255,0.03)",
      borderLeft:     isFirst ? "2px solid var(--green)" : "2px solid transparent",
      animation:      animateIn ? "leader-enter 0.35s ease" : "none",
      transition:     "background 0.3s",
      opacity,
    }}>
      {/* Position */}
      <div style={{
        width:  isMobile ? 28 : 34,
        height: isMobile ? 28 : 34,
        borderRadius: "50%",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: isFirst ? "var(--green)" : "rgba(255,255,255,0.05)",
        fontFamily: "'Space Mono',monospace",
        fontSize: isFirst ? (isMobile ? 14 : 16) : (isMobile ? 11 : 12),
        fontWeight: 700,
        color: isFirst ? "#000" : "var(--grey)",
        flexShrink: 0,
        boxShadow: isFirst ? "0 0 16px var(--green-glow)" : "none",
      }}>
        {isFirst ? "★" : entry.position}
      </div>

      {/* Wallet */}
      <div>
        <div style={{
          fontFamily: "'Space Mono',monospace",
          fontSize:   isMobile ? 11 : 13,
          color:      isFirst ? "var(--green)" : "var(--white)",
          fontWeight: isFirst ? 700 : 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {short(entry.wallet)}
        </div>
        {isFirst && (
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:8, letterSpacing:3, color:"var(--green)", marginTop:2, opacity:0.7 }}>
            CURRENT LEADER
          </div>
        )}
      </div>

      {/* Buy amount */}
      <div style={{ textAlign:"right" }}>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?10:12, color:"var(--grey)" }}>
          ◎{fmtSOL(entry.amount)}
        </div>
        {!isMobile && (
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", marginTop:2 }}>
            bought
          </div>
        )}
      </div>

      {/* Payout share */}
      <div style={{ textAlign:"right" }}>
        <div style={{
          fontFamily: "'Space Mono',monospace",
          fontSize:   isMobile ? 11 : 14,
          color:      isFirst ? "var(--green)" : "var(--white)",
          fontWeight: 700,
        }}>
          ◎{fmtSOL(entry.shareSol)}
        </div>
        {!isMobile && (
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", marginTop:2 }}>
            payout
          </div>
        )}
      </div>

      {/* Percentage — desktop only */}
      {!isMobile && (
        <div style={{ textAlign:"right" }}>
          <div style={{
            display: "inline-block",
            padding: "3px 8px",
            borderRadius: 3,
            background: isFirst ? "rgba(57,255,20,0.12)" : "rgba(255,255,255,0.04)",
            fontFamily: "'Space Mono',monospace",
            fontSize: 11,
            color: isFirst ? "var(--green)" : "var(--grey)",
            fontWeight: 700,
          }}>
            {fmtPct(entry.sharePercent)}
          </div>
        </div>
      )}

      {/* Time — desktop only */}
      {!isMobile && (
        <div style={{ textAlign:"right", fontFamily:"'Inter',sans-serif", fontSize:10, color:"var(--grey-dim)" }}>
          {entry.timestamp ? timeAgo(entry.timestamp.toMillis()) : ""}
        </div>
      )}
    </div>
  );
}

// ── Leaderboard ────────────────────────────────────────────────────────────────
function Leaderboard({ entries, potSOL, isMobile }) {
  const prevTopRef   = useRef(null);
  const [newTop, setNewTop] = useState(null);

  useEffect(() => {
    if (!entries || entries.length === 0) return;
    const top = entries[0]?.wallet;
    if (top && top !== prevTopRef.current) {
      setNewTop(top);
      setTimeout(() => setNewTop(null), 600);
    }
    prevTopRef.current = top;
  }, [entries]);

  if (!entries || entries.length === 0) {
    return (
      <div style={{ border:"1px solid var(--border)", borderRadius:4, overflow:"hidden", background:"var(--bg2)" }}>
        <div style={{ padding:"48px 24px", textAlign:"center" }}>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey-dim)", letterSpacing:4 }}>
            WAITING FOR FIRST BUY...
          </div>
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"var(--grey-dim)", marginTop:8, opacity:0.5 }}>
            Minimum ◎{MIN_BUY} SOL to qualify
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ border:"1px solid var(--border)", borderRadius:4, overflow:"hidden", background:"var(--bg2)" }}>
      {/* Table header */}
      <div style={{
        display:        "grid",
        gridTemplateColumns: isMobile ? "32px 1fr 80px 70px" : "40px 1fr 120px 120px 90px 80px",
        gap:            isMobile ? 8 : 12,
        padding:        isMobile ? "8px 14px" : "10px 20px",
        background:     "var(--bg3)",
        borderBottom:   "1px solid var(--border)",
      }}>
        {["#", "WALLET", isMobile?"BOUGHT":"BUY AMOUNT", isMobile?"WINS":"PAYOUT",
          ...(isMobile ? [] : ["SHARE", "WHEN"]),
        ].map((h, i) => (
          <div key={i} style={{
            fontFamily: "'Inter',sans-serif",
            fontSize: 9, fontWeight: 700, letterSpacing: 3,
            color: "var(--grey-dim)",
            textAlign: i > 1 ? "right" : "left",
          }}>{h}</div>
        ))}
      </div>

      {/* Rows */}
      {entries.map(entry => (
        <LeaderRow
          key={entry.wallet}
          entry={entry}
          isMobile={isMobile}
          animateIn={entry.wallet === newTop}
        />
      ))}
    </div>
  );
}

// ── Main Home ──────────────────────────────────────────────────────────────────
export default function Home({ navigate }) {
  const width    = useWindowWidth();
  const isMobile = width < 768;

  const [stats,     setStats]     = useState(null);
  const [winners,   setWinners]   = useState([]);
  const [countdown, setCountdown] = useState(TIMER_DEF);
  const [copiedCA,  setCopiedCA]  = useState(false);
  const [menuOpen,  setMenuOpen]  = useState(false);
  const [timeAgoMap,setTimeAgoMap]= useState({});

  const winAtRef  = useRef(null);
  const isLive    = TOKEN_CA !== "PASTE_TOKEN_CA_HERE";
  const [solPrice, setSolPrice] = useState(null);

  // Stats subscription
  useEffect(() => {
    return onSnapshot(doc(db, "lbw_stats", "global"), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.nextWinAt) {
        winAtRef.current = d.nextWinAt.toMillis();
        setCountdown(Math.max(0, d.nextWinAt.toMillis() - Date.now()));
      }
    });
  }, []);

  // Recent winners
  useEffect(() => {
    const q = query(collection(db, "lbw_history"), orderBy("timestamp","desc"), limit(5));
    return onSnapshot(q, snap => setWinners(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, []);

  // SOL price from CoinGecko — no API key needed
  useEffect(() => {
    const fetch = async () => {
      try {
        const res  = await window.fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        const data = await res.json();
        if (data?.solana?.usd) setSolPrice(data.solana.usd);
      } catch {}
    };
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
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

  // Time-ago tick for leaderboard
  useEffect(() => {
    const id = setInterval(() => {
      const map = {};
      (stats?.leaderboard || []).forEach(e => {
        if (e.timestamp) map[e.wallet] = timeAgo(e.timestamp.toMillis());
      });
      setTimeAgoMap(map);
    }, 3000);
    return () => clearInterval(id);
  }, [stats?.leaderboard]);

  const copyCA = () => {
    if (!isLive) return;
    navigator.clipboard.writeText(TOKEN_CA);
    setCopiedCA(true);
    setTimeout(() => setCopiedCA(false), 2200);
  };

  const leaderboard  = stats?.leaderboard  || [];
  const currentPot   = stats?.currentPotSOL ?? null;
  const totalPaid    = stats?.totalPaid     ?? 0;
  const totalRounds  = stats?.totalRounds   ?? 0;
  const biggestPot   = stats?.biggestPot    ?? 0;
  const lastWinners  = stats?.lastWinners   || [];
  const leader       = leaderboard[0];

  return (
    <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", position:"relative", zIndex:1 }}>

      {/* ── HEADER ── */}
      <header style={{
        position: "fixed", top:0, left:0, right:0, zIndex:100,
        display: "flex", alignItems:"center", justifyContent:"space-between",
        padding: isMobile ? "12px 16px" : "14px 28px",
        background: "rgba(8,8,8,0.95)",
        borderBottom: "1px solid var(--border)",
        backdropFilter: "blur(12px)",
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <img src="/logo.png" alt="" style={{ width:isMobile?28:34, height:isMobile?28:34, objectFit:"cover", borderRadius:4 }}/>
          <div>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:isMobile?15:20, letterSpacing:"0.12em", color:"var(--white)", lineHeight:1 }}>
              LAST BUYER WINS
            </div>
            {!isMobile && <div style={{ fontFamily:"'Space Mono',monospace", fontSize:8, color:"var(--grey)", letterSpacing:3 }}>ON SOLANA</div>}
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:isMobile?12:28 }}>
          {!isMobile && [["HOME",()=>navigate("home")],["HISTORY",()=>navigate("history")]].map(([l,fn]) => (
            <button key={l} onClick={fn} style={{ background:"none", border:"none", cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:11, fontWeight:700, letterSpacing:3, color:"var(--grey)", transition:"color 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
              onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
            >{l}</button>
          ))}
          <a href={X_URL} target="_blank" rel="noreferrer" style={{ fontFamily:"'Inter',sans-serif", fontSize:11, fontWeight:700, letterSpacing:3, color:"var(--grey)", textDecoration:"none" }}
            onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
            onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
          >𝕏</a>
          {isMobile && (
            <button onClick={() => setMenuOpen(o => !o)} style={{ background:"none", border:"1px solid var(--border)", borderRadius:3, cursor:"pointer", color:"var(--grey)", padding:"5px 10px", fontSize:13 }}>
              {menuOpen ? "✕" : "☰"}
            </button>
          )}
        </div>
      </header>

      {/* Mobile menu */}
      {menuOpen && (
        <div style={{ position:"fixed", top:53, left:0, right:0, background:"var(--bg2)", borderBottom:"1px solid var(--border)", zIndex:99, padding:"12px 16px 20px" }}>
          {[["HOME",()=>{navigate("home");setMenuOpen(false);}],["HISTORY",()=>{navigate("history");setMenuOpen(false);}]].map(([l,fn]) => (
            <button key={l} onClick={fn} style={{ display:"block", width:"100%", background:"none", border:"none", cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:14, fontWeight:700, letterSpacing:3, color:"var(--grey)", textAlign:"left", padding:"12px 0", borderBottom:"1px solid var(--border)" }}>
              {l}
            </button>
          ))}
        </div>
      )}

      {/* Ticker */}
      <div style={{ marginTop: isMobile ? 53 : 63 }}>
        <Ticker stats={stats} />
      </div>

      {/* ── HERO — countdown + pot ── */}
      <section style={{ padding: isMobile ? "48px 16px 40px" : "72px 24px 60px", textAlign:"center", position:"relative", overflow:"hidden" }}>
        <Countdown ms={countdown} />

        <div style={{
          marginTop: isMobile ? 32 : 48,
          display: "inline-flex", flexDirection:"column", alignItems:"center",
          padding: isMobile ? "20px 28px" : "24px 56px",
          border: "1px solid rgba(57,255,20,0.2)",
          borderRadius: 4,
          background: "rgba(57,255,20,0.03)",
          animation: "pulse-green 4s ease-in-out infinite",
        }}>
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:5, color:"var(--grey)", marginBottom:8 }}>
            CURRENT POT
          </div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?"clamp(28px,8vw,40px)":"clamp(36px,5vw,56px)", fontWeight:700, color:"var(--white)" }}>
            ◎ {fmtSOL(currentPot, 4)}
          </div>
          {potUSD != null && (
            <div style={{ fontFamily:"'Inter',sans-serif", fontSize:isMobile?16:20, fontWeight:600, color:"rgba(57,255,20,0.7)", marginTop:4 }}>
              ≈ ${potUSD.toFixed(2)} USD
            </div>
          )}
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:10, color:"var(--grey)", marginTop:6 }}>
            distributed to {leaderboard.length > 0 ? `top ${leaderboard.length} buyer${leaderboard.length>1?"s":""}` : "last buyer"}
          </div>
        </div>

        <div style={{ marginTop:28, display:"flex", flexDirection:isMobile?"column":"row", gap:10, justifyContent:"center", alignItems:"center" }}>
          <a href={PUMP_URL} target="_blank" rel="noreferrer">
            <button className="btn btn-green" style={{ fontSize:isMobile?13:14, padding:isMobile?"13px 0":"14px 36px", width:isMobile?"min(320px,90vw)":"auto" }}>
              BUY NOW ↗
            </button>
          </a>
          <button onClick={() => navigate("history")} className="btn btn-outline" style={{ width:isMobile?"min(320px,90vw)":"auto" }}>
            WINNERS HISTORY
          </button>
        </div>

        <div style={{ marginTop:16, fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey-dim)", letterSpacing:1 }}>
          min ◎{MIN_BUY} SOL to qualify
        </div>
      </section>

      {/* ── LEADERBOARD ── */}
      <section style={{ padding:isMobile?"0 16px 56px":"0 24px 72px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>

        {/* Section header */}
        <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:7, height:7, borderRadius:"50%", background:"var(--green)", boxShadow:"0 0 8px var(--green)", animation:"blink 1.5s ease infinite" }}/>
            <span style={{ fontFamily:"'Inter',sans-serif", fontSize:10, fontWeight:700, letterSpacing:4, color:"var(--grey)" }}>LIVE LEADERBOARD</span>
          </div>
          <div style={{ flex:1, height:1, background:"var(--border)" }}/>
          {leaderboard.length > 0 && (
            <span style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"var(--grey-dim)" }}>
              {leaderboard.length} / 10 spots filled
            </span>
          )}
        </div>

        {/* Leader callout — shown when there's a leader */}
        {leader && (
          <div style={{
            marginBottom: 12,
            padding: isMobile ? "14px 16px" : "16px 20px",
            border: "1px solid var(--green)",
            borderRadius: 4,
            background: "var(--green-dim)",
            animation: "pulse-green 3s ease-in-out infinite",
            display: "flex", alignItems:"center", justifyContent:"space-between", gap:16, flexWrap:"wrap",
          }}>
            <div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--green)", marginBottom:6 }}>
                ★ CURRENT LEADER — WINS 50%
              </div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?13:16, color:"var(--white)", fontWeight:700 }}>
                {short(leader.wallet)}
              </div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?18:24, color:"var(--green)", fontWeight:700 }}>
                ◎ {fmtSOL(leader.shareSol)}
              </div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:10, color:"var(--grey)", marginTop:4 }}>
                if nobody buys before timer ends
              </div>
            </div>
          </div>
        )}

        <Leaderboard entries={leaderboard} potSOL={currentPot} isMobile={isMobile} />

        {/* How the split works */}
        {leaderboard.length > 1 && (
          <div style={{
            marginTop: 12,
            padding: "12px 16px",
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--bg2)",
            display: "flex", alignItems:"center", gap:12, flexWrap:"wrap",
          }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:"var(--green)", flexShrink:0 }}/>
              <span style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey)" }}>
                Leader: 50% → ◎{fmtSOL(leaderboard[0]?.shareSol)}
              </span>
            </div>
            {leaderboard.length > 1 && (
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:"var(--grey-dim)", flexShrink:0 }}/>
                <span style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey)" }}>
                  Positions 2-{leaderboard.length}: 50% split → ◎{fmtSOL(leaderboard[1]?.shareSol)} each
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── HOW IT WORKS ── */}
      <section style={{ padding:isMobile?"0 16px 56px":"0 24px 72px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>
        <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:20 }}>
          <div style={{ flex:1, height:1, background:"var(--border)" }}/>
          <span style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey)", whiteSpace:"nowrap" }}>HOW IT WORKS</span>
          <div style={{ flex:1, height:1, background:"var(--border)" }}/>
        </div>

        <div style={{ display:"grid", gridTemplateColumns: isMobile?"1fr 1fr":"repeat(4,1fr)", gap:1, border:"1px solid var(--border)", borderRadius:4, overflow:"hidden" }}>
          {[
            { n:"01", title:"BUY",      desc:`Spend ◎${MIN_BUY}+ SOL in a single buy to enter the leaderboard.` },
            { n:"02", title:"LEAD",     desc:"Every qualifying buy resets the countdown and puts you at position 1." },
            { n:"03", title:"SURVIVE",  desc:"Stay in the top 10 when the timer hits zero. Top 10 = top 10 wins." },
            { n:"04", title:"WIN",      desc:"Leader takes 50%. The rest of the pot splits equally among positions 2-10." },
          ].map((s, i) => (
            <div key={s.n} style={{ padding:isMobile?"16px 14px":"24px 20px", background:"var(--bg2)", borderRight:"1px solid var(--border)" }}>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?24:32, color:"rgba(57,255,20,0.12)", fontWeight:700, lineHeight:1, marginBottom:10 }}>{s.n}</div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:isMobile?12:13, fontWeight:700, color:"var(--white)", letterSpacing:1, marginBottom:6 }}>{s.title}</div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"var(--grey)", lineHeight:1.6 }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── RECENT WINNERS ── */}
      {winners.length > 0 && (
        <section style={{ padding:isMobile?"0 16px 56px":"0 24px 72px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>
          <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:16 }}>
            <div style={{ flex:1, height:1, background:"var(--border)" }}/>
            <span style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey)", whiteSpace:"nowrap" }}>RECENT ROUNDS</span>
            <div style={{ flex:1, height:1, background:"var(--border)" }}/>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:1, border:"1px solid var(--border)", borderRadius:4, overflow:"hidden" }}>
            {winners.map((w, i) => {
              const topWinner = w.winners?.[0];
              return (
                <div key={w.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, padding:isMobile?"12px 14px":"14px 20px", background:i%2===0?"var(--bg2)":"var(--bg3)", flexWrap:"wrap" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"var(--grey-dim)", minWidth:24 }}>#{w.round}</div>
                    <div>
                      <div style={{ fontFamily:"'Space Mono',monospace", fontSize:11, color:"var(--white)" }}>
                        {short(topWinner?.wallet)} {w.numWinners > 1 ? `+${w.numWinners-1} more` : ""}
                      </div>
                      <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", marginTop:2 }}>
                        {w.timestamp ? timeAgo(w.timestamp.toMillis()) : ""}
                      </div>
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

          <div style={{ textAlign:"center", marginTop:14 }}>
            <button onClick={() => navigate("history")} className="btn btn-outline">VIEW ALL ROUNDS →</button>
          </div>
        </section>
      )}

      {/* ── CA ── */}
      <section style={{ padding:isMobile?"0 16px 56px":"0 24px 72px", maxWidth:"var(--max-w)", margin:"0 auto", width:"100%" }}>
        <div style={{ border:"1px solid var(--border)", borderRadius:4, padding:isMobile?"18px":"24px", background:"var(--bg2)" }}>
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey)", marginBottom:10 }}>
            CONTRACT ADDRESS
          </div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?9:12, color:isLive?"var(--white)":"var(--grey)", wordBreak:"break-all", lineHeight:1.7, marginBottom:14, fontStyle:isLive?"normal":"italic" }}>
            {isLive ? TOKEN_CA : "— contract address at launch —"}
          </div>
          <div style={{ display:"flex", flexDirection:isMobile?"column":"row", gap:10 }}>
            {isLive && (
              <button onClick={copyCA} className="btn btn-green" style={{ fontSize:11, padding:"11px 22px", width:isMobile?"100%":"auto" }}>
                {copiedCA ? "COPIED ✓" : "COPY CA"}
              </button>
            )}
            <a href={X_URL} target="_blank" rel="noreferrer" style={{ width:isMobile?"100%":"auto" }}>
              <button className="btn btn-outline" style={{ width:isMobile?"100%":"auto" }}>𝕏 TWITTER</button>
            </a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{ borderTop:"1px solid var(--border)", padding:"18px 24px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginTop:"auto" }}>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey-dim)" }}>LAST BUYER WINS — ON SOLANA</div>
        {!isMobile && <div style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"var(--grey-dim)", fontStyle:"italic" }}>The clock resets. The pot grows. 10 wallets win.</div>}
        <a href={X_URL} target="_blank" rel="noreferrer" style={{ fontFamily:"'Inter',sans-serif", fontSize:10, letterSpacing:3, color:"var(--grey-dim)", textDecoration:"none" }}>𝕏</a>
      </footer>
    </div>
  );
}