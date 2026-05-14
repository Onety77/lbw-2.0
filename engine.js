/**
 * Last Buyer Wins — Engine v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Rules:
 *   - Every qualifying buy (>= MIN_BUY_SOL) resets a countdown timer
 *   - Last 10 unique wallets form the leaderboard (most recent = position 1)
 *   - When timer hits zero:
 *       Position 1 (leader) receives 50% of pot
 *       Positions 2-N split the remaining 50% equally
 *       If only 1 buyer: they receive 100%
 *   - New round starts immediately after payout
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

// ── ENV VARS ─────────────────────────────────────────────────────────────────
const CREATOR_WALLET  = process.env.CREATOR_WALLET;
const TOKEN_CA        = process.env.TOKEN_CA;
const SOLANA_RPC      = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const GAS_RESERVE_SOL = parseFloat(process.env.GAS_RESERVE_SOL || "0.1");
const MIN_BUY_SOL     = parseFloat(process.env.MIN_BUY_SOL     || "0.1");
const TIMER_MS        = parseInt(process.env.TIMER_MS          || "60000");

const PUMP_PROGRAM_ID     = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

// ── STARTUP VALIDATION ────────────────────────────────────────────────────────
["CREATOR_PRIVATE_KEY","FIREBASE_SERVICE_ACCOUNT_JSON","CREATOR_WALLET","TOKEN_CA"].forEach(k => {
  if (!process.env[k]) { console.error(`Missing required env var: ${k}`); process.exit(1); }
});

// ── SOLANA ────────────────────────────────────────────────────────────────────
const WS_RPC     = SOLANA_RPC.replace("https://","wss://").replace("http://","ws://");
const connection = new Connection(SOLANA_RPC, { commitment: "confirmed", wsEndpoint: WS_RPC });
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
      const delay = e.message?.includes("429") ? 6000 * (i+1) : 2000 * (i+1);
      await sleep(delay);
    }
  }
}

async function getWalletBalance() {
  return withRetry(() => connection.getBalance(new PublicKey(CREATOR_WALLET)));
}

async function sendSOL(toAddress, lamports) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: creatorKP.publicKey,
    toPubkey:   new PublicKey(toAddress),
    lamports,
  }));
  return withRetry(() => sendAndConfirmTransaction(connection, tx, [creatorKP], { commitment: "confirmed" }));
}

// ── LEADERBOARD LOGIC ─────────────────────────────────────────────────────────

/**
 * Given the current leaderboard entries and pot size,
 * calculate each player's payout share.
 *
 * entries = [{ wallet, amount, sig, tsMs }, ...] — ordered most recent first
 * returns the same array with sharePercent and shareSol added to each entry
 */
function calculateShares(entries, potSOL) {
  const n = entries.length;
  if (n === 0) return [];

  return entries.map((entry, i) => {
    let sharePercent, shareSol;

    if (n === 1) {
      // Only one player — takes everything
      sharePercent = 100;
      shareSol     = potSOL;
    } else if (i === 0) {
      // Leader gets 50%
      sharePercent = 50;
      shareSol     = potSOL * 0.5;
    } else {
      // Remaining players split the other 50% equally
      sharePercent = 50 / (n - 1);
      shareSol     = (potSOL * 0.5) / (n - 1);
    }

    return {
      ...entry,
      position:     i + 1,
      sharePercent: Math.round(sharePercent * 100) / 100,
      shareSol:     Math.round(shareSol * 1e6) / 1e6,
    };
  });
}

/**
 * Add a new buy to the leaderboard.
 * - If wallet already exists, remove their old entry and put them at front
 * - Keep only top 10 unique wallets
 */
function addToLeaderboard(currentEntries, newEntry) {
  // Remove existing entry for this wallet (if any)
  const filtered = currentEntries.filter(e => e.wallet !== newEntry.wallet);
  // Add new entry at front (most recent = leader)
  return [newEntry, ...filtered].slice(0, 10);
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let leaderboardEntries = []; // current round entries
let roundNumber        = 0;
let winTimer           = null;
let isPayingOut        = false;
let lastUpdateMs       = 0;   // cooldown tracker
let processedSigs      = new Set();
let currentWatchAddr   = null;

const LEADER_COOLDOWN = 3000; // min 3s between updates

// ── FIRESTORE WRITES ──────────────────────────────────────────────────────────
async function pushLeaderboardToFirestore(entries, potSOL) {
  const withShares = calculateShares(entries, potSOL);
  await db.doc("lbw_stats/global").set({
    leaderboard: withShares.map(e => ({
      position:     e.position,
      wallet:       e.wallet,
      amount:       e.amount,
      sharePercent: e.sharePercent,
      shareSol:     e.shareSol,
      sig:          e.sig || null,
      timestamp:    Timestamp.fromMillis(e.tsMs),
    })),
    lastBuyer:  entries[0]?.wallet || null,
    lastBuyAt:  entries[0] ? Timestamp.fromMillis(entries[0].tsMs) : null,
    lastBuySOL: entries[0]?.amount || null,
  }, { merge: true });
}

async function updatePotDisplay() {
  try {
    const bal = await getWalletBalance();
    const pot  = bal / LAMPORTS_PER_SOL;
    await db.doc("lbw_stats/global").set({ currentPotSOL: pot }, { merge: true });

    // Also update live share amounts in leaderboard
    if (leaderboardEntries.length > 0) {
      await pushLeaderboardToFirestore(leaderboardEntries, pot);
    }
  } catch (e) {
    log(`  [pot] update error: ${e.message}`);
  }
}

// ── TIMER ─────────────────────────────────────────────────────────────────────
function resetTimer() {
  if (winTimer) clearTimeout(winTimer);
  const nextWinAt = Date.now() + TIMER_MS;
  db.doc("lbw_stats/global").set({ nextWinAt: Timestamp.fromMillis(nextWinAt) }, { merge: true }).catch(() => {});
  winTimer = setTimeout(triggerPayout, TIMER_MS);
  log(`  ⏱ Timer reset — fires at ${new Date(nextWinAt).toISOString()}`);
}

// ── NEW BUY DETECTED ──────────────────────────────────────────────────────────
async function onQualifyingBuy(wallet, solAmount, sig) {
  // Rate limit — don't process more than once every 3 seconds
  const now = Date.now();
  if (now - lastUpdateMs < LEADER_COOLDOWN) return;
  lastUpdateMs = now;

  log(`  ★ NEW LEADER: ${wallet.slice(0,8)}... | ◎${solAmount.toFixed(4)}`);

  // Update in-memory leaderboard
  leaderboardEntries = addToLeaderboard(leaderboardEntries, {
    wallet, amount: solAmount, sig, tsMs: now,
  });

  // Get current pot for share calculation
  const bal    = await getWalletBalance().catch(() => 0);
  const potSOL = bal / LAMPORTS_PER_SOL;

  // Push to Firestore
  await pushLeaderboardToFirestore(leaderboardEntries, potSOL).catch(e => {
    log(`  Firestore write error: ${e.message}`);
  });

  resetTimer();
}

// ── PAYOUT ────────────────────────────────────────────────────────────────────
async function triggerPayout() {
  if (isPayingOut) return;

  if (leaderboardEntries.length === 0) {
    log("No players this round — resetting timer.");
    resetTimer();
    return;
  }

  isPayingOut = true;
  const snapshot = [...leaderboardEntries]; // snapshot at payout time
  const n = snapshot.length;
  log(`\n${"═".repeat(50)}`);
  log(`PAYOUT — ${n} winner${n > 1 ? "s" : ""} | Round ${roundNumber}`);
  log(`${"═".repeat(50)}`);

  try {
    // Get available balance
    const balLam  = await getWalletBalance();
    const gasLam  = Math.ceil(GAS_RESERVE_SOL * LAMPORTS_PER_SOL);
    let sendLam   = balLam - gasLam;

    // If pot is empty, wait for fees to accumulate
    if (sendLam <= 0) {
      log("Pot empty — waiting 30s for fee claims to land...");
      await sleep(30000);
      const bal2   = await getWalletBalance();
      sendLam      = bal2 - gasLam;
      if (sendLam <= 0) {
        log("Still empty — starting new round without payout.");
        await startNewRound();
        isPayingOut = false;
        return;
      }
    }

    const potSOL = sendLam / LAMPORTS_PER_SOL;
    log(`Pot: ◎${potSOL.toFixed(6)} | Gas reserve: ◎${GAS_RESERVE_SOL}`);

    // Calculate each player's lamports
    const payouts = snapshot.map((entry, i) => {
      let lamports;
      if (n === 1) {
        lamports = sendLam;
      } else if (i === 0) {
        lamports = Math.floor(sendLam / 2);
      } else {
        lamports = Math.floor(sendLam / 2 / (n - 1));
      }
      return { ...entry, lamports, solAmount: lamports / LAMPORTS_PER_SOL };
    });

    // Send payouts sequentially
    const winners = [];
    for (const p of payouts) {
      try {
        log(`  → Sending ◎${p.solAmount.toFixed(6)} to ${p.wallet.slice(0,8)}... (pos ${p.position})`);
        const txSig = await sendSOL(p.wallet, p.lamports);
        log(`    ✓ TX: ${txSig}`);
        winners.push({ ...p, txSig, success: true });
      } catch (e) {
        log(`    ✗ Failed: ${e.message}`);
        winners.push({ ...p, txSig: null, success: false });
      }
    }

    // Record round in history
    const totalPaid = winners
      .filter(w => w.success)
      .reduce((sum, w) => sum + w.solAmount, 0);

    await db.collection("lbw_history").add({
      round:      roundNumber,
      pot:        potSOL,
      totalPaid,
      numWinners: n,
      timestamp:  Timestamp.now(),
      winners:    winners.map(w => ({
        position:     w.position,
        wallet:       w.wallet,
        buyAmount:    w.amount,
        payout:       w.success ? w.solAmount : 0,
        sharePercent: w.sharePercent,
        txSig:        w.txSig || null,
      })),
    });

    // Update global stats
    await db.doc("lbw_stats/global").set({
      totalPaid:    FieldValue.increment(totalPaid),
      totalRounds:  FieldValue.increment(1),
      lastRoundAt:  Timestamp.now(),
      lastWinners:  winners.slice(0, 3).map(w => ({
        position: w.position,
        wallet:   w.wallet,
        payout:   w.success ? w.solAmount : 0,
        txSig:    w.txSig || null,
      })),
    }, { merge: true });

    // Update biggestPot
    const gs = await db.doc("lbw_stats/global").get();
    if (gs.exists && potSOL > (gs.data().biggestPot || 0)) {
      await db.doc("lbw_stats/global").set({ biggestPot: potSOL }, { merge: true });
    }

    log(`Round ${roundNumber} complete — ◎${totalPaid.toFixed(6)} distributed to ${n} winner${n>1?"s":""}`);
    log(`${"═".repeat(50)}\n`);

  } catch (e) {
    log(`PAYOUT ERROR: ${e.message}`);
  }

  await startNewRound();
  isPayingOut = false;
}

// ── NEW ROUND ─────────────────────────────────────────────────────────────────
async function startNewRound() {
  roundNumber++;
  leaderboardEntries = [];
  processedSigs.clear();
  lastUpdateMs = 0;

  log(`Starting round ${roundNumber}...`);

  const bal = await getWalletBalance().catch(() => 0);
  await db.doc("lbw_stats/global").set({
    currentPotSOL: bal / LAMPORTS_PER_SOL,
    leaderboard:   [],
    lastBuyer:     null,
    lastBuyAt:     null,
    lastBuySOL:    null,
    nextWinAt:     Timestamp.fromMillis(Date.now() + TIMER_MS),
  }, { merge: true });

  resetTimer();
}

// ── PROCESS TRANSACTION ───────────────────────────────────────────────────────
async function processTx(sig, watchedAddrStr) {
  if (processedSigs.has(sig)) return;
  processedSigs.add(sig);
  if (processedSigs.size > 2000) {
    const arr = Array.from(processedSigs);
    processedSigs = new Set(arr.slice(-1000));
  }

  try {
    const tx = await withRetry(() => connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    }), 2);

    if (!tx?.meta) return;

    const accounts     = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [];
    const preBals      = tx.meta.preBalances  || [];
    const postBals     = tx.meta.postBalances || [];

    // Find the account whose SOL decreased most — that's the buyer
    let maxDecrease = 0;
    let buyerIdx    = -1;

    for (let i = 0; i < preBals.length; i++) {
      const dec = preBals[i] - postBals[i];
      if (dec > maxDecrease && dec > 10_000) {
        maxDecrease = dec;
        buyerIdx    = i;
      }
    }

    if (buyerIdx === -1) return;

    const solSpent = maxDecrease / LAMPORTS_PER_SOL;
    const buyer    = accounts[buyerIdx].toString();

    // Skip system/program accounts
    const skip = [
      watchedAddrStr,
      PUMP_PROGRAM_ID.toString(),
      PUMPSWAP_PROGRAM_ID.toString(),
      CREATOR_WALLET,
      "11111111111111111111111111111111", // SystemProgram
    ];
    if (skip.includes(buyer)) return;

    log(`  [tx] ${sig.slice(0,18)}... | ${buyer.slice(0,8)}... | ◎${solSpent.toFixed(4)}`);

    if (solSpent >= MIN_BUY_SOL && !isPayingOut) {
      await onQualifyingBuy(buyer, solSpent, sig);
    }

  } catch {
    // Silent — tx may not be confirmed yet
  }
}

// ── WEBSOCKET SUBSCRIPTION ────────────────────────────────────────────────────
function subscribeToAddress(address) {
  const str = address.toString();
  if (currentWatchAddr === str) return;
  currentWatchAddr = str;

  log(`Subscribing WebSocket to: ${str}`);
  connection.onLogs(
    address,
    async ({ signature, err }) => {
      if (err) return;
      log(`  [ws] ${signature.slice(0,18)}...`);
      await processTx(signature, str);
    },
    "confirmed"
  );
  log("WebSocket active — real-time buy detection enabled.");
}


// ── BALANCE UPDATE LOOP ───────────────────────────────────────────────────────
async function balanceUpdateLoop() {
  while (true) {
    await sleep(15_000);
    await updatePotDisplay().catch(() => {});
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
console.log(`
  ██╗      ██████╗ ██╗    ██╗
  ██║     ██╔══██╗██║    ██║
  ██║     ██████╔╝██║ █╗ ██║
  ██║     ██╔══██╗██║███╗██║
  ███████╗██████╔╝╚███╔███╔╝
  ╚══════╝╚═════╝  ╚══╝╚══╝ v2

  LAST BUYER WINS — Engine v2
`);

log(`Wallet      : ${CREATOR_WALLET}`);
log(`Token       : ${TOKEN_CA}`);
log(`Min Buy     : ◎${MIN_BUY_SOL} SOL`);
log(`Timer       : ${TIMER_MS/1000}s`);
log(`Gas Reserve : ◎${GAS_RESERVE_SOL}`);
log(`Detection   : Token mint WebSocket — works on any DEX`);
log("─".repeat(50));

// Init global stats doc if first time
db.doc("lbw_stats/global").get().then(snap => {
  if (!snap.exists) {
    db.doc("lbw_stats/global").set({
      currentPotSOL: 0,
      totalPaid:     0,
      totalRounds:   0,
      biggestPot:    0,
      leaderboard:   [],
      lastBuyer:     null,
      lastBuyAt:     null,
      lastBuySOL:    null,
      lastWinners:   [],
      nextWinAt:     Timestamp.fromMillis(Date.now() + TIMER_MS),
    });
    log("Firestore initialized.");
  }
}).catch(e => log(`Init error: ${e.message}`));

// Start auto-claim fees
startAutoClaimFees(connection, creatorKP, log);

// Subscribe to token mint directly — works on bonding curve,
// PumpSwap, Raydium, or any DEX. No pool address ever needed.
const mintPubkey = new PublicKey(TOKEN_CA);
log(`Watching token mint: ${TOKEN_CA}`);
subscribeToAddress(mintPubkey);

// Start game
startNewRound();
balanceUpdateLoop();
