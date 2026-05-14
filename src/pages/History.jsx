import { useState, useEffect } from "react";
import { collection, query, orderBy, limit, onSnapshot, startAfter, getDocs } from "firebase/firestore";
import { db } from "../firebase";

const short  = (a) => a ? `${a.slice(0,4)}...${a.slice(-4)}` : "—";
const fmtSOL = (n) => (n == null ? "—" : Number(n).toFixed(4));
const fmtDate = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts.toMillis());
  return d.toLocaleDateString("en-US", { month:"short", day:"numeric" }) + " " +
         d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
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

export default function History({ navigate }) {
  const width    = useWindowWidth();
  const isMobile = width < 768;

  const [rounds,    setRounds]    = useState([]);
  const [expanded,  setExpanded]  = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [menuOpen,  setMenuOpen]  = useState(false);

  useEffect(() => {
    const q = query(collection(db, "lbw_history"), orderBy("timestamp","desc"), limit(50));
    return onSnapshot(q, snap => {
      setRounds(snap.docs.map(d => ({ id:d.id, ...d.data() })));
      setLoading(false);
    });
  }, []);

  // Stats from rounds
  const totalRounds = rounds.length;
  const totalPaid   = rounds.reduce((s, r) => s + (r.totalPaid || 0), 0);
  const biggestPot  = Math.max(0, ...rounds.map(r => r.pot || 0));
  const maxWinners  = Math.max(0, ...rounds.map(r => r.numWinners || 0));

  return (
    <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", position:"relative", zIndex:1 }}>

      {/* Header */}
      <header style={{
        position:"fixed", top:0, left:0, right:0, zIndex:100,
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:isMobile?"12px 16px":"14px 28px",
        background:"rgba(8,8,8,0.95)", borderBottom:"1px solid var(--border)",
        backdropFilter:"blur(12px)",
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <img src="/logo.png" alt="" style={{ width:isMobile?28:34, height:isMobile?28:34, objectFit:"cover", borderRadius:4 }}/>
          <div>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:isMobile?15:20, letterSpacing:"0.12em", color:"var(--white)", lineHeight:1 }}>
              LAST BUYER WINS
            </div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:isMobile?12:28 }}>
          {!isMobile && [["HOME",()=>navigate("home")],["HISTORY",()=>navigate("history")]].map(([l,fn]) => (
            <button key={l} onClick={fn} style={{ background:"none", border:"none", cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:11, fontWeight:700, letterSpacing:3, color:l==="HISTORY"?"var(--green)":"var(--grey)", transition:"color 0.2s" }}>{l}</button>
          ))}
          {isMobile && (
            <button onClick={() => setMenuOpen(o=>!o)} style={{ background:"none", border:"1px solid var(--border)", borderRadius:3, cursor:"pointer", color:"var(--grey)", padding:"5px 10px", fontSize:13 }}>
              {menuOpen?"✕":"☰"}
            </button>
          )}
        </div>
      </header>

      {menuOpen && (
        <div style={{ position:"fixed", top:53, left:0, right:0, background:"var(--bg2)", borderBottom:"1px solid var(--border)", zIndex:99, padding:"12px 16px 20px" }}>
          {[["HOME",()=>{navigate("home");setMenuOpen(false);}],["HISTORY",()=>{navigate("history");setMenuOpen(false);}]].map(([l,fn]) => (
            <button key={l} onClick={fn} style={{ display:"block", width:"100%", background:"none", border:"none", cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:14, fontWeight:700, letterSpacing:3, color:"var(--grey)", textAlign:"left", padding:"12px 0", borderBottom:"1px solid var(--border)" }}>{l}</button>
          ))}
        </div>
      )}

      <div style={{ marginTop:isMobile?53:63, flex:1, padding:isMobile?"24px 16px 60px":"40px 24px 80px", maxWidth:"var(--max-w)", margin:`${isMobile?53:63}px auto 0`, width:"100%" }}>

        {/* Page title */}
        <div style={{ marginBottom:32 }}>
          <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:5, color:"var(--grey)", marginBottom:10 }}>ON-CHAIN RECORD</div>
          <h1 style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:isMobile?"clamp(36px,10vw,48px)":"clamp(48px,6vw,64px)", letterSpacing:"0.08em", color:"var(--white)", lineHeight:1, marginBottom:8 }}>
            WINNERS HISTORY
          </h1>
          <p style={{ fontFamily:"'Inter',sans-serif", fontSize:13, color:"var(--grey)", lineHeight:1.6 }}>
            Every round. Every winner. Every payout. All on-chain.
          </p>
        </div>

        {/* Summary stats */}
        {rounds.length > 0 && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:1, border:"1px solid var(--border)", borderRadius:4, overflow:"hidden", marginBottom:28 }}>
            {[
              { label:"TOTAL ROUNDS",  value:totalRounds.toString() },
              { label:"TOTAL PAID",    value:`◎ ${fmtSOL(totalPaid)}` },
              { label:"BIGGEST POT",   value:`◎ ${fmtSOL(biggestPot)}` },
              { label:"MAX WINNERS",   value:`${maxWinners} wallets` },
            ].map(s => (
              <div key={s.label} style={{ padding:"16px 20px", background:"var(--bg2)", borderRight:"1px solid var(--border)" }}>
                <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey-dim)", marginBottom:6 }}>{s.label}</div>
                <div style={{ fontFamily:"'Space Mono',monospace", fontSize:16, color:"var(--white)", fontWeight:700 }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Rounds list */}
        {loading ? (
          <div style={{ textAlign:"center", padding:60, fontFamily:"'Space Mono',monospace", fontSize:11, color:"var(--grey-dim)", letterSpacing:3 }}>
            LOADING...
          </div>
        ) : rounds.length === 0 ? (
          <div style={{ textAlign:"center", padding:80 }}>
            <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey-dim)", letterSpacing:4, marginBottom:12 }}>NO ROUNDS YET</div>
            <div style={{ fontFamily:"'Inter',sans-serif", fontSize:13, color:"var(--grey-dim)" }}>The first round hasn't completed yet.</div>
            <button onClick={() => navigate("home")} className="btn btn-outline" style={{ marginTop:24 }}>GO TO GAME →</button>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:1, border:"1px solid var(--border)", borderRadius:4, overflow:"hidden" }}>
            {rounds.map((round, ri) => {
              const isOpen   = expanded === round.id;
              const topWinner = round.winners?.[0];

              return (
                <div key={round.id} style={{ borderBottom:ri<rounds.length-1?"1px solid var(--border)":"none" }}>
                  {/* Round summary row */}
                  <div
                    onClick={() => setExpanded(isOpen ? null : round.id)}
                    style={{
                      display:"flex", alignItems:"center", justifyContent:"space-between",
                      gap:12, padding:isMobile?"12px 14px":"16px 22px",
                      background: isOpen ? "rgba(57,255,20,0.04)" : ri%2===0?"var(--bg2)":"var(--bg3)",
                      cursor:"pointer", flexWrap:isMobile?"wrap":"nowrap",
                      borderLeft:isOpen?"2px solid var(--green)":"2px solid transparent",
                      transition:"all 0.2s",
                    }}
                    onMouseEnter={e => { if(!isOpen) e.currentTarget.style.background="rgba(57,255,20,0.02)"; }}
                    onMouseLeave={e => { if(!isOpen) e.currentTarget.style.background=ri%2===0?"var(--bg2)":"var(--bg3)"; }}
                  >
                    {/* Round # + date */}
                    <div style={{ display:"flex", alignItems:"center", gap:12, minWidth:0 }}>
                      <div style={{
                        width:32, height:32, borderRadius:"50%", flexShrink:0,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        background: isOpen ? "var(--green)" : "rgba(255,255,255,0.05)",
                        fontFamily:"'Space Mono',monospace", fontSize:10, fontWeight:700,
                        color: isOpen ? "#000" : "var(--grey-dim)",
                      }}>{round.round}</div>
                      <div>
                        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?10:12, color:"var(--white)", marginBottom:2 }}>
                          {short(topWinner?.wallet)}
                          {round.numWinners > 1 && <span style={{ fontFamily:"'Inter',sans-serif", fontSize:10, color:"var(--grey)", marginLeft:8 }}>+{round.numWinners-1} more</span>}
                        </div>
                        <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)" }}>
                          {fmtDate(round.timestamp)}
                        </div>
                      </div>
                    </div>

                    {/* Pot + winners count */}
                    <div style={{ display:"flex", alignItems:"center", gap:isMobile?14:24, flexShrink:0 }}>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?13:15, color:"var(--green)", fontWeight:700 }}>
                          ◎ {fmtSOL(round.pot)}
                        </div>
                        <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", marginTop:2 }}>
                          {round.numWinners} winner{round.numWinners>1?"s":""}
                        </div>
                      </div>
                      <div style={{ fontFamily:"'Inter',sans-serif", fontSize:14, color:isOpen?"var(--green)":"var(--grey-dim)", transition:"color 0.2s" }}>
                        {isOpen ? "▲" : "▼"}
                      </div>
                    </div>
                  </div>

                  {/* Expanded winners */}
                  {isOpen && round.winners && (
                    <div style={{ padding:isMobile?"12px 14px":"16px 22px", background:"rgba(57,255,20,0.02)", borderTop:"1px solid rgba(57,255,20,0.08)", animation:"slide-up 0.25s ease" }}>
                      <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:700, letterSpacing:4, color:"var(--grey)", marginBottom:12 }}>
                        WINNERS BREAKDOWN
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                        {round.winners.map((w, wi) => (
                          <div key={wi} style={{
                            display:"flex", alignItems:"center", justifyContent:"space-between",
                            gap:12, padding:"10px 14px",
                            background: wi===0 ? "rgba(57,255,20,0.06)" : "rgba(255,255,255,0.02)",
                            borderRadius:3,
                            border: wi===0 ? "1px solid rgba(57,255,20,0.2)" : "1px solid rgba(255,255,255,0.04)",
                            flexWrap:"wrap",
                          }}>
                            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                              <div style={{
                                width:24, height:24, borderRadius:"50%", flexShrink:0,
                                display:"flex", alignItems:"center", justifyContent:"center",
                                background: wi===0 ? "var(--green)" : "rgba(255,255,255,0.05)",
                                fontFamily:"'Space Mono',monospace", fontSize:9, fontWeight:700,
                                color: wi===0 ? "#000" : "var(--grey-dim)",
                                boxShadow: wi===0 ? "0 0 10px var(--green-glow)" : "none",
                              }}>
                                {wi===0 ? "★" : wi+1}
                              </div>
                              <div>
                                <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?10:12, color: wi===0?"var(--green)":"var(--white)" }}>
                                  {short(w.wallet)}
                                </div>
                                {w.txSig && (
                                  <a href={`https://solscan.io/tx/${w.txSig}`} target="_blank" rel="noreferrer"
                                    style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", textDecoration:"underline" }}>
                                    TX ↗
                                  </a>
                                )}
                              </div>
                            </div>
                            <div style={{ textAlign:"right" }}>
                              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:isMobile?12:14, color:wi===0?"var(--green)":"var(--white)", fontWeight:700 }}>
                                ◎ {fmtSOL(w.payout)}
                              </div>
                              <div style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:"var(--grey-dim)", marginTop:2 }}>
                                {wi===0 ? "50%" : `${fmtSOL(w.sharePercent,1)}%`} of pot
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer style={{ borderTop:"1px solid var(--border)", padding:"18px 24px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"var(--grey-dim)" }}>LAST BUYER WINS — ON SOLANA</div>
        <button onClick={() => navigate("home")} className="btn btn-outline" style={{ fontSize:10, padding:"8px 18px" }}>← BACK TO GAME</button>
      </footer>
    </div>
  );
}
