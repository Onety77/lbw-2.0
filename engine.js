/**
 * Last Buyer Wins — Engine v4
 * - Filters out wallets holding 5%+ of supply (bonding curve, whales)
 * - WebSocket + 4s poll backup
 * - Direct RPC balance
 */

require("dotenv").config();
const { startAutoClaimFees } = require("./claimFees");

const {
  Connection, PublicKey, Transaction, SystemProgram,
  Keypair, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const bs58  = require("bs58");
const https = require("https");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CREATOR_WALLET    = process.env.CREATOR_WALLET;
const TOKEN_CA          = process.env.TOKEN_CA;
const SOLANA_RPC        = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const ST_API_KEY        = process.env.SOLANATRACKER_API_KEY || "";
const GAS_RESERVE_SOL   = parseFloat(process.env.GAS_RESERVE_SOL   || "0.1");
const MIN_BUY_SOL       = parseFloat(process.env.MIN_BUY_SOL        || "0.1");
const TIMER_MS          = parseInt(process.env.TIMER_MS             || "60000");
const MAX_HOLDER_PCT    = parseFloat(process.env.MAX_HOLDER_PCT     || "5"); // disqualify if holding 5%+
const POLL_MS           = 4000;

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

// ── HTTP FETCH (no node-fetch needed) ────────────────────────────────────────
function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── BALANCE ───────────────────────────────────────────────────────────────────
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

// ── HOLDER CHECK — disqualify wallets holding MAX_HOLDER_PCT% or more ─────────
// Uses on-chain token supply + wallet balance — no API key needed
async function isQualifiedBuyer(walletAddress) {
  try {
    const mintPubkey   = new PublicKey(TOKEN_CA);
    const walletPubkey = new PublicKey(walletAddress);

    // Get wallet's token balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey, { mint: mintPubkey }
    );

    if (tokenAccounts.value.length === 0) {
      // No token account — they bought but tokens haven't settled yet
      // Allow them through — they're definitely not a whale with 5%
      return { qualified: true, holdingPct: 0 };
    }

    const walletTokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;

    // Get total supply
    const mintInfo    = await connection.getParsedAccountInfo(mintPubkey);
    const totalSupply = mintInfo.value?.data?.parsed?.info?.supply
      ? parseInt(mintInfo.value.data.parsed.info.supply) / Math.pow(10, mintInfo.value.data.parsed.info.decimals)
      : null;

    if (!totalSupply || totalSupply === 0) {
      // Can't determine supply — let them through
      return { qualified: true, holdingPct: 0 };
    }

    const holdingPct = (walletTokenBalance / totalSupply) * 100;

    if (holdingPct >= MAX_HOLDER_PCT) {
      return { qualified: false, holdingPct };
    }

    return { qualified: true, holdingPct };

  } catch (e) {
    log(`  [holder check] Error for ${walletAddress.slice(0,8)}: ${e.message} — allowing`);
    // On error, allow the buyer through — don't block legitimate buys
    return { qualified: true, holdingPct: 0 };
  }
}

// ── LEADERBOARD LOGIC ─────────────────────────────────────────────────────────
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
  // Check holder percentage — disqualify whales and bonding curve
  const { qualified, holdingPct } = await isQualifiedBuyer(wallet);
  if (!qualified) {
    log(`  [skip] ${wallet.slice(0,8)}... holds ${holdingPct.toFixed(1)}% — disqualified (>${MAX_HOLDER_PCT}%)`);
    return;
  }

  log(`  ★ NEW LEADER: ${wallet.slice(0,8)}... ◎${solAmount.toFixed(4)} (holds ${holdingPct.toFixed(2)}%)`);
  leaderboard = addToLeaderboard(leaderboard, { wallet, amount: solAmount, sig, tsMs });
  const pot = await pushState().catch(() => 0);
  log(`  Pot: ◎${pot.toFixed(4)} | Players: ${leaderboard.length}`);
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

  isPayingOut    = true;
  const snapshot = [...leaderboard];
  const n        = snapshot.length;
  log(`\n${"=".repeat(50)}`);
  log(`PAYOUT — Round ${roundNumber} — ${n} winner${n > 1 ? "s" : ""}`);

  try {
    const balSOL   = await getWalletBalance();
    let sendSOLAmt = balSOL - GAS_RESERVE_SOL;

    if (sendSOLAmt <= 0) {
      log("Pot empty — waiting 30s for fees...");
      await sleep(30000);
      const bal2 = await getWalletBalance();
      sendSOLAmt = bal2 - GAS_RESERVE_SOL;
      if (sendSOLAmt <= 0) {
        log("Still empty — new round.");
        await startNewRound();
        isPayingOut = false;
        return;
      }
    }

    const sendLam = Math.floor(sendSOLAmt * LAMPORTS_PER_SOL);
    log(`Pot: ◎${sendSOLAmt.toFixed(6)}`);

    const payouts = snapshot.map((e, i) => {
      let lam;
      if (n === 1)      lam = sendLam;
      else if (i === 0) lam = Math.floor(sendLam / 2);
      else              lam = Math.floor(sendLam / 2 / (n - 1));
      return { ...e, lam, sol: lam / LAMPORTS_PER_SOL };
    });

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

    log(`Round ${roundNumber} done — ◎${totalPaid.toFixed(6)} to ${n} winner${n>1?"s":""}`);
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

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
function startWebSocket(mintPubkey) {
  log(`WebSocket subscribing to mint: ${TOKEN_CA}`);
  try {
    connection.onLogs(
      mintPubkey,
      async ({ signature, err }) => {
        if (err) return;
        log(`  [ws] ${signature.slice(0,16)}...`);
        await processTx(signature);
      },
      "confirmed"
    );
    log("WebSocket active.");
  } catch (e) {
    log(`WebSocket failed: ${e.message} — poll will handle detection`);
  }
}

// ── POLL BACKUP ───────────────────────────────────────────────────────────────
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
        lastSigSeen = sigs[0].signature;
        log(`Poll cursor set: ${lastSigSeen.slice(0,16)}...`);
        continue;
      }

      const fresh = sigs.filter(s => !s.err);
      if (fresh.length > 0) {
        lastSigSeen = fresh[0].signature;
        for (const s of fresh) await processTx(s.signature);
      }
    } catch (e) {
      log(`  [poll] error: ${e.message}`);
    }
  }
}

// ── BALANCE LOOP ──────────────────────────────────────────────────────────────
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
console.log(`\n  LAST BUYER WINS — Engine v4\n`);
log(`Wallet      : ${CREATOR_WALLET}`);
log(`Token       : ${TOKEN_CA}`);
log(`Min Buy     : ◎${MIN_BUY_SOL} SOL`);
log(`Timer       : ${TIMER_MS / 1000}s`);
log(`Gas Reserve : ◎${GAS_RESERVE_SOL}`);
log(`Max Holding : ${MAX_HOLDER_PCT}% (above this = disqualified)`);
log(`Detection   : WebSocket + ${POLL_MS/1000}s poll backup`);
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