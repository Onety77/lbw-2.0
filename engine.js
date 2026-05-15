/**
 * Last Buyer Wins — Engine v5
 * - Queue-based tx processing — no RPC flooding
 * - Leaderboard always accepts new qualifying buys
 * - 5% holder filter using on-chain data
 * - WebSocket + poll backup
 */

require("dotenv").config();
const { startAutoClaimFees } = require("./claimFees");

const {
  Connection, PublicKey, Transaction, SystemProgram,
  Keypair, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const bs58 = require("bs58");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CREATOR_WALLET  = process.env.CREATOR_WALLET;
const TOKEN_CA        = process.env.TOKEN_CA;
const SOLANA_RPC      = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const GAS_RESERVE_SOL = parseFloat(process.env.GAS_RESERVE_SOL || "0.1");
const MIN_BUY_SOL     = parseFloat(process.env.MIN_BUY_SOL     || "0.1");
const TIMER_MS        = parseInt(process.env.TIMER_MS          || "60000");
const MAX_HOLDER_PCT  = parseFloat(process.env.MAX_HOLDER_PCT  || "5");
const SPLIT_THRESHOLD = parseFloat(process.env.SPLIT_THRESHOLD || "1.0"); // SOL
const POLL_MS         = 6000; // poll every 6s — relaxed to avoid 429s

// ── VALIDATE ──────────────────────────────────────────────────────────────────
["CREATOR_PRIVATE_KEY","FIREBASE_SERVICE_ACCOUNT_JSON","CREATOR_WALLET","TOKEN_CA"]
  .forEach(k => { if (!process.env[k]) { console.error(`Missing: ${k}`); process.exit(1); } });

// ── SOLANA ────────────────────────────────────────────────────────────────────
const WS_RPC     = SOLANA_RPC.replace("https://","wss://").replace("http://","ws://");
const connection = new Connection(SOLANA_RPC, { commitment:"confirmed", wsEndpoint: WS_RPC });
const creatorKP  = Keypair.fromSecretKey(bs58.decode(process.env.CREATOR_PRIVATE_KEY));

if (creatorKP.publicKey.toBase58() !== CREATOR_WALLET) {
  console.error("Key mismatch"); process.exit(1);
}

// ── FIREBASE ──────────────────────────────────────────────────────────────────
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
const db = getFirestore();

// ── UTILS ─────────────────────────────────────────────────────────────────────
const log   = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      const delay = e.message?.includes("429") ? 8000 * (i+1) : 2000 * (i+1);
      await sleep(delay);
    }
  }
}

async function getWalletBalance() {
  const lam = await withRetry(() => connection.getBalance(new PublicKey(CREATOR_WALLET)));
  return lam / LAMPORTS_PER_SOL;
}

async function sendSOL(to, lamports) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: creatorKP.publicKey,
    toPubkey:   new PublicKey(to),
    lamports,
  }));
  return withRetry(() =>
    sendAndConfirmTransaction(connection, tx, [creatorKP], { commitment: "confirmed" })
  );
}

// ── HOLDER CHECK ──────────────────────────────────────────────────────────────
async function isQualifiedBuyer(wallet) {
  try {
    const mintPub   = new PublicKey(TOKEN_CA);
    const walletPub = new PublicKey(wallet);

    const [tokenAccts, mintInfo] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(walletPub, { mint: mintPub }),
      connection.getParsedAccountInfo(mintPub),
    ]);

    if (tokenAccts.value.length === 0) return { qualified: true, pct: 0 };

    const walletBal  = tokenAccts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    const supplyRaw  = mintInfo.value?.data?.parsed?.info?.supply;
    const decimals   = mintInfo.value?.data?.parsed?.info?.decimals ?? 6;

    if (!supplyRaw) return { qualified: true, pct: 0 };

    const totalSupply = parseInt(supplyRaw) / Math.pow(10, decimals);
    const pct         = (walletBal / totalSupply) * 100;

    return { qualified: pct < MAX_HOLDER_PCT, pct };
  } catch {
    return { qualified: true, pct: 0 }; // allow on error
  }
}

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
function calculateShares(entries, potSOL) {
  const n = entries.length;
  if (n === 0) return [];

  const useSplit = potSOL >= SPLIT_THRESHOLD && n > 1;

  return entries.map((e, i) => {
    let pct, sol;
    if (!useSplit || n === 1) {
      // Below threshold or only one player — leader takes all
      pct = i === 0 ? 100 : 0;
      sol = i === 0 ? potSOL : 0;
    } else if (i === 0) {
      pct = 50; sol = potSOL * 0.5;
    } else {
      pct = 50 / (n - 1);
      sol = (potSOL * 0.5) / (n - 1);
    }
    return {
      ...e,
      position:     i + 1,
      sharePercent: Math.round(pct * 100) / 100,
      shareSol:     Math.round(sol * 1e6) / 1e6,
    };
  });
}

// Always allows new entries — pushes out oldest if over 10
function addToLeaderboard(current, newEntry) {
  // Remove same wallet if already in board (they rebought — move to front)
  const without = current.filter(e => e.wallet !== newEntry.wallet);
  // Add at front, keep max 10
  return [newEntry, ...without].slice(0, 5);
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let leaderboard    = [];
let roundNumber    = 0;
let winTimer       = null;
let isPayingOut    = false;
let processedSigs  = new Set();
let lastSigSeen    = null;
let lastLeaderTime = 0;
const LEADER_COOLDOWN = 2000; // min 2s between leader updates

// ── TX PROCESSING QUEUE ───────────────────────────────────────────────────────
// Prevents flooding the RPC with concurrent getTransaction calls
const txQueue    = [];
let queueRunning = false;

function enqueueTx(sig) {
  if (processedSigs.has(sig)) return;
  processedSigs.add(sig);
  if (processedSigs.size > 2000) {
    const arr = Array.from(processedSigs);
    processedSigs = new Set(arr.slice(-1000));
  }
  txQueue.push(sig);
  runQueue();
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;

  while (txQueue.length > 0) {
    const sig = txQueue.shift();
    await processTx(sig).catch(() => {});
    await sleep(300); // 300ms between tx fetches — gentle on RPC
  }

  queueRunning = false;
}

// ── FIRESTORE PUSH ────────────────────────────────────────────────────────────
async function pushState(potSOL) {
  const withShares = calculateShares(leaderboard, potSOL);
  await db.doc("lbw_stats/global").set({
    currentPotSOL: potSOL,
    splitThreshold: SPLIT_THRESHOLD,
    leaderboard: withShares.map(e => ({
      position:     e.position,
      wallet:       e.wallet,
      amount:       e.amount,
      sharePercent: e.sharePercent,
      shareSol:     e.shareSol,
      sig:          e.sig || null,
      timestamp:    Timestamp.fromMillis(e.tsMs),
    })),
    lastBuyer:  leaderboard[0]?.wallet || null,
    lastBuyAt:  leaderboard[0] ? Timestamp.fromMillis(leaderboard[0].tsMs) : null,
    lastBuySOL: leaderboard[0]?.amount || null,
  }, { merge: true });
}

// ── TIMER ─────────────────────────────────────────────────────────────────────
function resetTimer() {
  if (winTimer) clearTimeout(winTimer);
  const nextWinAt = Date.now() + TIMER_MS;
  db.doc("lbw_stats/global")
    .set({ nextWinAt: Timestamp.fromMillis(nextWinAt) }, { merge: true })
    .catch(() => {});
  winTimer = setTimeout(triggerPayout, TIMER_MS);
  log(`  ⏱ Timer reset — ${TIMER_MS/1000}s`);
}

// ── ON QUALIFYING BUY ─────────────────────────────────────────────────────────
async function onBuy(wallet, solAmount, sig, tsMs) {
  // Cooldown — prevent rapid-fire updates
  const now = Date.now();
  if (now - lastLeaderTime < LEADER_COOLDOWN) return;
  lastLeaderTime = now;

  // Holder check
  const { qualified, pct } = await isQualifiedBuyer(wallet);
  if (!qualified) {
    log(`  [skip] ${wallet.slice(0,8)}... holds ${pct.toFixed(1)}% — disqualified`);
    return;
  }

  log(`  ★ NEW LEADER: ${wallet.slice(0,8)}... ◎${solAmount.toFixed(4)}`);
  leaderboard = addToLeaderboard(leaderboard, { wallet, amount: solAmount, sig, tsMs });

  const pot = await getWalletBalance().catch(() => 0);
  await pushState(pot).catch(e => log(`  Firestore error: ${e.message}`));

  const splitActive = pot >= SPLIT_THRESHOLD;
  log(`  Pot: ◎${pot.toFixed(4)} | Players: ${leaderboard.length}/10 | Split: ${splitActive ? "YES" : "NO (below ◎"+SPLIT_THRESHOLD+")"}`);

  resetTimer();
}

// ── PAYOUT ────────────────────────────────────────────────────────────────────
async function triggerPayout() {
  if (isPayingOut) return;
  if (leaderboard.length === 0) { log("No players — resetting."); resetTimer(); return; }

  isPayingOut    = true;
  const snapshot = [...leaderboard];
  const n        = snapshot.length;

  log(`\n${"=".repeat(50)}`);
  log(`PAYOUT — Round ${roundNumber} — ${n} player${n>1?"s":""}`);

  try {
    const balSOL   = await getWalletBalance();
    let sendSOLAmt = balSOL - GAS_RESERVE_SOL;

    if (sendSOLAmt <= 0) {
      log("Pot empty — waiting 30s...");
      await sleep(30000);
      sendSOLAmt = (await getWalletBalance()) - GAS_RESERVE_SOL;
      if (sendSOLAmt <= 0) { log("Still empty — new round."); await startNewRound(); isPayingOut = false; return; }
    }

    const sendLam    = Math.floor(sendSOLAmt * LAMPORTS_PER_SOL);
    const useSplit   = sendSOLAmt >= SPLIT_THRESHOLD && n > 1;

    log(`Pot: ◎${sendSOLAmt.toFixed(6)} | Split: ${useSplit ? `YES (${n} winners)` : "NO (last buyer takes all)"}`);

    // Calculate payouts
    const payouts = snapshot.map((e, i) => {
      let lam;
      if (!useSplit || n === 1) {
        lam = i === 0 ? sendLam : 0;
      } else if (i === 0) {
        lam = Math.floor(sendLam / 2);
      } else {
        lam = Math.floor(sendLam / 2 / (n - 1));
      }
      return { ...e, lam, sol: lam / LAMPORTS_PER_SOL };
    }).filter(p => p.lam > 0);

    // Send sequentially
    const results = [];
    for (const p of payouts) {
      try {
        log(`  → ◎${p.sol.toFixed(6)} to pos ${p.position} ${p.wallet.slice(0,8)}...`);
        const txSig = await sendSOL(p.wallet, p.lam);
        log(`    ✓ ${txSig}`);
        results.push({ ...p, txSig, ok: true });
      } catch (e) {
        log(`    ✗ Failed: ${e.message}`);
        results.push({ ...p, txSig: null, ok: false });
      }
    }

    const totalPaid   = results.filter(r => r.ok).reduce((s, r) => s + r.sol, 0);
    const actualWinners = results.filter(r => r.ok && r.sol > 0);

    // Only write history if something was actually paid out
    if (totalPaid > 0 && actualWinners.length > 0) {
      await db.collection("lbw_history").add({
        round: roundNumber, pot: sendSOLAmt, totalPaid,
        numWinners: actualWinners.length,
        splitUsed: useSplit,
        timestamp: Timestamp.now(),
        winners: actualWinners.map((r, i) => ({
          position:  i + 1,
          wallet:    r.wallet,
          buyAmount: r.amount,
          payout:    r.sol,
          txSig:     r.txSig || null,
        })),
      });
    } else {
      log("No SOL paid out — skipping history write.");
    }

    await db.doc("lbw_stats/global").set({
      totalPaid:   FieldValue.increment(totalPaid),
      totalRounds: FieldValue.increment(1),
      lastRoundAt: Timestamp.now(),
    }, { merge: true });

    const gs = await db.doc("lbw_stats/global").get();
    if (gs.exists && sendSOLAmt > (gs.data().biggestPot || 0)) {
      await db.doc("lbw_stats/global").set({ biggestPot: sendSOLAmt }, { merge: true });
    }

    log(`Done — ◎${totalPaid.toFixed(6)} paid out`);
    log(`${"=".repeat(50)}\n`);

  } catch (e) {
    log(`PAYOUT ERROR: ${e.message}`);
  }

  await startNewRound();
  isPayingOut = false;
}

// ── NEW ROUND ─────────────────────────────────────────────────────────────────
async function startNewRound() {
  roundNumber++;
  leaderboard    = [];
  processedSigs  = new Set();
  lastSigSeen    = null;
  lastLeaderTime = 0;
  txQueue.length = 0;
  log(`Round ${roundNumber} started.`);

  const pot = await getWalletBalance().catch(() => 0);
  await db.doc("lbw_stats/global").set({
    currentPotSOL: pot, leaderboard: [],
    lastBuyer: null, lastBuyAt: null, lastBuySOL: null,
    nextWinAt: Timestamp.fromMillis(Date.now() + TIMER_MS),
  }, { merge: true });

  resetTimer();
}

// ── PROCESS ONE TX ────────────────────────────────────────────────────────────
async function processTx(sig) {
  try {
    const tx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx?.meta) return;

    const accounts = tx.transaction.message.staticAccountKeys
                  || tx.transaction.message.accountKeys || [];
    const pre  = tx.meta.preBalances  || [];
    const post = tx.meta.postBalances || [];

    // Find account that spent most SOL
    let maxDec = 0, buyerIdx = -1;
    for (let i = 0; i < pre.length; i++) {
      const dec = pre[i] - post[i];
      if (dec > maxDec && dec > 10_000) { maxDec = dec; buyerIdx = i; }
    }

    if (buyerIdx === -1) return;

    const solSpent = maxDec / LAMPORTS_PER_SOL;
    const buyer    = accounts[buyerIdx].toString();

    const skip = [
      CREATOR_WALLET, TOKEN_CA,
      "11111111111111111111111111111111",
      "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    ];
    if (skip.includes(buyer)) return;

    const tsMs = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    log(`  [tx] ${sig.slice(0,16)}... | ${buyer.slice(0,8)}... | ◎${solSpent.toFixed(4)}`);

    if (solSpent >= MIN_BUY_SOL && !isPayingOut) {
      await onBuy(buyer, solSpent, sig, tsMs);
    }

  } catch (e) {
    if (!e.message?.includes("429")) return; // silent unless rate limit
    log(`  [tx] 429 on ${sig.slice(0,12)} — will retry via poll`);
  }
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
function startWebSocket(mintPubkey) {
  log(`WebSocket subscribing to: ${TOKEN_CA}`);
  try {
    connection.onLogs(mintPubkey, ({ signature, err }) => {
      if (err || isPayingOut) return;
      enqueueTx(signature);
    }, "confirmed");
    log("WebSocket active.");
  } catch (e) {
    log(`WebSocket failed: ${e.message} — poll will handle detection`);
  }
}

// ── POLL BACKUP ───────────────────────────────────────────────────────────────
async function pollLoop(mintPubkey) {
  log(`Poll backup every ${POLL_MS/1000}s`);
  while (true) {
    await sleep(POLL_MS);
    if (isPayingOut) continue;
    try {
      const opts = { limit: 5, commitment: "confirmed" };
      if (lastSigSeen) opts.until = lastSigSeen;

      const sigs = await connection.getSignaturesForAddress(mintPubkey, opts);
      if (!sigs || sigs.length === 0) continue;

      if (!lastSigSeen) {
        lastSigSeen = sigs[0].signature;
        log(`Poll cursor: ${lastSigSeen.slice(0,16)}...`);
        continue;
      }

      const fresh = sigs.filter(s => !s.err);
      if (fresh.length > 0) {
        lastSigSeen = fresh[0].signature;
        log(`  [poll] ${fresh.length} new tx(s)`);
        fresh.forEach(s => enqueueTx(s.signature));
      }
    } catch (e) {
      log(`  [poll] error: ${e.message}`);
    }
  }
}

// ── BALANCE LOOP ──────────────────────────────────────────────────────────────
async function balanceLoop() {
  while (true) {
    await sleep(20_000);
    try {
      const pot = await getWalletBalance();
      await db.doc("lbw_stats/global").set({ currentPotSOL: pot }, { merge: true });
    } catch {}
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
console.log(`\n  LAST BUYER WINS — Engine v5\n`);
log(`Wallet         : ${CREATOR_WALLET}`);
log(`Token          : ${TOKEN_CA}`);
log(`Min Buy        : ◎${MIN_BUY_SOL} SOL`);
log(`Timer          : ${TIMER_MS/1000}s`);
log(`Gas Reserve    : ◎${GAS_RESERVE_SOL}`);
log(`Split Threshold: ◎${SPLIT_THRESHOLD} SOL`);
log(`Max Holding    : ${MAX_HOLDER_PCT}%`);
log(`Detection      : WebSocket + ${POLL_MS/1000}s poll`);
log("─".repeat(50));

db.doc("lbw_stats/global").get().then(snap => {
  if (!snap.exists) {
    db.doc("lbw_stats/global").set({
      currentPotSOL: 0, totalPaid: 0, totalRounds: 0, biggestPot: 0,
      leaderboard: [], lastBuyer: null, lastBuyAt: null,
      nextWinAt: Timestamp.fromMillis(Date.now() + TIMER_MS),
    });
    log("Firestore initialized.");
  }
}).catch(e => log(`Init error: ${e.message}`));

const mintPubkey = new PublicKey(TOKEN_CA);

startAutoClaimFees(connection, creatorKP, log);
startNewRound();
startWebSocket(mintPubkey);
pollLoop(mintPubkey);
balanceLoop();