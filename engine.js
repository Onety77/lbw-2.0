/**
 * Last Buyer Wins — Engine v3
 * Detection: WebSocket (Helius) + 4s poll backup
 * Balance: direct RPC wallet balance
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
const POLL_MS         = 4000;

// ── VALIDATE ──────────────────────────────────────────────────────────────────
["CREATOR_PRIVATE_KEY","FIREBASE_SERVICE_ACCOUNT_JSON","CREATOR_WALLET","TOKEN_CA"]
  .forEach(k => { if (!process.env[k]) { console.error(`Missing: ${k}`); process.exit(1); } });

// ── SOLANA ────────────────────────────────────────────────────────────────────
const WS_RPC     = SOLANA_RPC.replace("https://","wss://").replace("http://","ws://");
const connection = new Connection(SOLANA_RPC, { commitment:"confirmed", wsEndpoint: WS_RPC });
const creatorKP  = Keypair.fromSecretKey(bs58.decode(process.env.CREATOR_PRIVATE_KEY));

if (creatorKP.publicKey.toBase58() !== CREATOR_WALLET) {
  console.error("Private key does not match CREATOR_WALLET"); process.exit(1);
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
      await sleep(2000 * (i + 1));
    }
  }
}

// ── BALANCE — direct RPC, no SolanaTracker needed ─────────────────────────────
async function getWalletBalance() {
  const lamports = await withRetry(() =>
    connection.getBalance(new PublicKey(CREATOR_WALLET))
  );
  return lamports / LAMPORTS_PER_SOL;
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

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
function calculateShares(entries, potSOL) {
  const n = entries.length;
  if (n === 0) return [];
  return entries.map((e, i) => {
    let pct, sol;
    if (n === 1)      { pct = 100; sol = potSOL; }
    else if (i === 0) { pct = 50;  sol = potSOL * 0.5; }
    else              { pct = 50 / (n - 1); sol = (potSOL * 0.5) / (n - 1); }
    return {
      ...e,
      position:     i + 1,
      sharePercent: Math.round(pct * 100) / 100,
      shareSol:     Math.round(sol * 1e6) / 1e6,
    };
  });
}

function addToLeaderboard(current, newEntry) {
  return [newEntry, ...current.filter(e => e.wallet !== newEntry.wallet)].slice(0, 10);
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let leaderboard   = [];
let roundNumber   = 0;
let winTimer      = null;
let isPayingOut   = false;
let processedSigs = new Set();
let lastSigSeen   = null;

// ── FIRESTORE PUSH ────────────────────────────────────────────────────────────
async function pushState() {
  const potSOL     = await getWalletBalance().catch(() => 0);
  const withShares = calculateShares(leaderboard, potSOL);

  await db.doc("lbw_stats/global").set({
    currentPotSOL: potSOL,
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

  return potSOL;
}

// ── TIMER ─────────────────────────────────────────────────────────────────────
function resetTimer() {
  if (winTimer) clearTimeout(winTimer);
  const nextWinAt = Date.now() + TIMER_MS;
  db.doc("lbw_stats/global")
    .set({ nextWinAt: Timestamp.fromMillis(nextWinAt) }, { merge: true })
    .catch(() => {});
  winTimer = setTimeout(triggerPayout, TIMER_MS);
  log(`  ⏱ Timer reset — ${TIMER_MS / 1000}s`);
}

// ── ON QUALIFYING BUY ─────────────────────────────────────────────────────────
async function onBuy(wallet, solAmount, sig, tsMs) {
  log(`  ★ NEW LEADER: ${wallet.slice(0, 8)}... ◎${solAmount.toFixed(4)}`);
  leaderboard = addToLeaderboard(leaderboard, { wallet, amount: solAmount, sig, tsMs });
  const pot = await pushState().catch(() => 0);
  log(`  Pot: ◎${pot.toFixed(4)} | Leaderboard: ${leaderboard.length} players`);
  resetTimer();
}

// ── PAYOUT ────────────────────────────────────────────────────────────────────
async function triggerPayout() {
  if (isPayingOut) return;
  if (leaderboard.length === 0) {
    log("No players this round — resetting timer.");
    resetTimer();
    return;
  }

  isPayingOut = true;
  const snapshot = [...leaderboard];
  const n        = snapshot.length;
  log(`\n${"=".repeat(50)}`);
  log(`PAYOUT — Round ${roundNumber} — ${n} winner${n > 1 ? "s" : ""}`);

  try {
    const balSOL = await getWalletBalance();
    const gasSOL = GAS_RESERVE_SOL;
    let sendSOLAmt = balSOL - gasSOL;

    if (sendSOLAmt <= 0) {
      log("Pot empty — waiting 30s for fees to land...");
      await sleep(30000);
      const bal2 = await getWalletBalance();
      sendSOLAmt = bal2 - gasSOL;
      if (sendSOLAmt <= 0) {
        log("Still empty — starting new round.");
        await startNewRound();
        isPayingOut = false;
        return;
      }
    }

    const sendLam = Math.floor(sendSOLAmt * LAMPORTS_PER_SOL);
    log(`Pot: ◎${sendSOLAmt.toFixed(6)} | Gas reserved: ◎${gasSOL}`);

    // Calculate lamports per winner
    const payouts = snapshot.map((e, i) => {
      let lam;
      if (n === 1)      lam = sendLam;
      else if (i === 0) lam = Math.floor(sendLam / 2);
      else              lam = Math.floor(sendLam / 2 / (n - 1));
      return { ...e, lam, sol: lam / LAMPORTS_PER_SOL };
    });

    // Send sequentially
    const results = [];
    for (const p of payouts) {
      try {
        log(`  → ◎${p.sol.toFixed(6)} to pos ${p.position} ${p.wallet.slice(0, 8)}...`);
        const txSig = await sendSOL(p.wallet, p.lam);
        log(`    ✓ ${txSig}`);
        results.push({ ...p, txSig, ok: true });
      } catch (e) {
        log(`    ✗ Failed: ${e.message}`);
        results.push({ ...p, txSig: null, ok: false });
      }
    }

    const totalPaid = results.filter(r => r.ok).reduce((s, r) => s + r.sol, 0);

    await db.collection("lbw_history").add({
      round: roundNumber, pot: sendSOLAmt, totalPaid,
      numWinners: n, timestamp: Timestamp.now(),
      winners: results.map((r, i) => ({
        position:     i + 1,
        wallet:       r.wallet,
        buyAmount:    r.amount,
        payout:       r.ok ? r.sol : 0,
        sharePercent: n === 1 ? 100 : i === 0 ? 50 : Math.round(50 / (n - 1) * 100) / 100,
        txSig:        r.txSig || null,
      })),
    });

    await db.doc("lbw_stats/global").set({
      totalPaid:   FieldValue.increment(totalPaid),
      totalRounds: FieldValue.increment(1),
      lastRoundAt: Timestamp.now(),
    }, { merge: true });

    const gs = await db.doc("lbw_stats/global").get();
    if (gs.exists && sendSOLAmt > (gs.data().biggestPot || 0)) {
      await db.doc("lbw_stats/global").set({ biggestPot: sendSOLAmt }, { merge: true });
    }

    log(`Round ${roundNumber} complete — ◎${totalPaid.toFixed(6)} distributed`);
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
  leaderboard   = [];
  processedSigs = new Set();
  lastSigSeen   = null;
  log(`Round ${roundNumber} started.`);

  const pot = await getWalletBalance().catch(() => 0);
  await db.doc("lbw_stats/global").set({
    currentPotSOL: pot,
    leaderboard:   [],
    lastBuyer:     null,
    lastBuyAt:     null,
    lastBuySOL:    null,
    nextWinAt:     Timestamp.fromMillis(Date.now() + TIMER_MS),
  }, { merge: true });

  resetTimer();
}

// ── PROCESS TX ────────────────────────────────────────────────────────────────
async function processTx(sig) {
  if (processedSigs.has(sig)) return;
  processedSigs.add(sig);
  if (processedSigs.size > 2000) {
    const arr = Array.from(processedSigs);
    processedSigs = new Set(arr.slice(-1000));
  }

  try {
    const tx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx?.meta) return;

    const accounts = tx.transaction.message.staticAccountKeys
                  || tx.transaction.message.accountKeys
                  || [];
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
      CREATOR_WALLET,
      TOKEN_CA,
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

  } catch {
    // silent
  }
}

// ── WEBSOCKET — fires instantly on every tx ───────────────────────────────────
function startWebSocket(mintPubkey) {
  log(`WebSocket subscribing to mint: ${TOKEN_CA}`);
  try {
    connection.onLogs(
      mintPubkey,
      async ({ signature, err }) => {
        if (err) return;
        log(`  [ws] ${signature.slice(0, 16)}...`);
        await processTx(signature);
      },
      "confirmed"
    );
    log("WebSocket active.");
  } catch (e) {
    log(`WebSocket failed: ${e.message} — poll backup will handle detection`);
  }
}

// ── POLL — backup every 4s to catch anything WebSocket misses ─────────────────
async function pollLoop(mintPubkey) {
  log(`Poll backup every ${POLL_MS / 1000}s`);

  while (true) {
    await sleep(POLL_MS);
    if (isPayingOut) continue;

    try {
      const opts = { limit: 10, commitment: "confirmed" };
      if (lastSigSeen) opts.until = lastSigSeen;

      const sigs = await connection.getSignaturesForAddress(mintPubkey, opts);
      if (!sigs || sigs.length === 0) continue;

      if (!lastSigSeen) {
        // First poll — set cursor only, don't replay history
        lastSigSeen = sigs[0].signature;
        log(`Poll cursor set: ${lastSigSeen.slice(0, 16)}...`);
        continue;
      }

      const fresh = sigs.filter(s => !s.err);
      if (fresh.length > 0) {
        lastSigSeen = fresh[0].signature;
        log(`  [poll] ${fresh.length} new tx(s)`);
        for (const s of fresh) {
          await processTx(s.signature);
        }
      }

    } catch (e) {
      log(`  [poll] error: ${e.message}`);
    }
  }
}

// ── BALANCE UPDATE ────────────────────────────────────────────────────────────
async function balanceLoop() {
  while (true) {
    await sleep(15_000);
    try {
      const pot = await getWalletBalance();
      await db.doc("lbw_stats/global").set({ currentPotSOL: pot }, { merge: true });
    } catch {}
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
console.log(`
  LAST BUYER WINS — Engine v3
`);
log(`Wallet      : ${CREATOR_WALLET}`);
log(`Token       : ${TOKEN_CA}`);
log(`Min Buy     : ◎${MIN_BUY_SOL} SOL`);
log(`Timer       : ${TIMER_MS / 1000}s`);
log(`Gas Reserve : ◎${GAS_RESERVE_SOL}`);
log(`Detection   : WebSocket + ${POLL_MS / 1000}s poll backup`);
log(`RPC         : ${SOLANA_RPC.split("?")[0]}`);
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