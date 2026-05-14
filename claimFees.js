/**
 * claimFees.js — Auto-claim pump.fun + PumpSwap creator fees
 * Works for both bonding curve and post-graduation automatically.
 */

const {
  PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const PUMP_PROGRAM_ID     = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

// Anchor discriminators
const PUMP_DISCRIMINATOR     = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
const PUMPSWAP_DISCRIMINATOR = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);

const CLAIM_INTERVAL_MS  = 30_000;    // every 30 seconds
const MIN_CLAIM_LAMPORTS = 10_000_000; // 0.01 SOL minimum

// ── PDA derivations ───────────────────────────────────────────────────────────
function derivePumpVault(creatorPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creatorPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function derivePumpEventAuthority() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function derivePumpSwapVaultAuthority(creatorPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), creatorPubkey.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  );
  return pda;
}

function derivePumpSwapEventAuthority() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMPSWAP_PROGRAM_ID
  );
  return pda;
}

// ── Claim pump.fun fees ───────────────────────────────────────────────────────
async function claimPumpFees(connection, creatorKP, log) {
  const vaultPDA   = derivePumpVault(creatorKP.publicKey);
  const eventAuth  = derivePumpEventAuthority();

  let balance = 0;
  try { balance = await connection.getBalance(vaultPDA); } catch { return 0; }
  if (balance <= MIN_CLAIM_LAMPORTS) return 0;

  log(`  [pump.fun] Vault: ◎${(balance/LAMPORTS_PER_SOL).toFixed(6)} — claiming...`);

  try {
    const ix = new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      data: PUMP_DISCRIMINATOR,
      keys: [
        { pubkey: creatorKP.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: vaultPDA,                isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuth,               isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID,         isSigner: false, isWritable: false },
      ],
    });
    const sig = await sendAndConfirmTransaction(
      connection, new Transaction().add(ix), [creatorKP], { commitment: "confirmed" }
    );
    log(`  [pump.fun] Claimed ◎${(balance/LAMPORTS_PER_SOL).toFixed(6)} | TX: ${sig}`);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    const msg = e.message || "";
    if (!msg.includes("AccountNotFound") && !msg.includes("does not exist"))
      log(`  [pump.fun] Error: ${msg.split("\n")[0]}`);
    return 0;
  }
}

// ── Claim PumpSwap fees (post-graduation) ─────────────────────────────────────
async function claimPumpSwapFees(connection, creatorKP, log) {
  const vaultAuth  = derivePumpSwapVaultAuthority(creatorKP.publicKey);
  const eventAuth  = derivePumpSwapEventAuthority();
  const RENT_EXEMPT = 890_880;

  let balance = 0;
  try { balance = await connection.getBalance(vaultAuth); } catch { return 0; }
  if (balance <= RENT_EXEMPT + MIN_CLAIM_LAMPORTS) return 0;

  const claimable = balance - RENT_EXEMPT;
  log(`  [pumpswap] Vault: ◎${(claimable/LAMPORTS_PER_SOL).toFixed(6)} — claiming...`);

  try {
    const ix = new TransactionInstruction({
      programId: PUMPSWAP_PROGRAM_ID,
      data: PUMPSWAP_DISCRIMINATOR,
      keys: [
        { pubkey: creatorKP.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: vaultAuth,               isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuth,               isSigner: false, isWritable: false },
        { pubkey: PUMPSWAP_PROGRAM_ID,     isSigner: false, isWritable: false },
      ],
    });
    const sig = await sendAndConfirmTransaction(
      connection, new Transaction().add(ix), [creatorKP], { commitment: "confirmed" }
    );
    log(`  [pumpswap] Claimed ◎${(claimable/LAMPORTS_PER_SOL).toFixed(6)} | TX: ${sig}`);
    return claimable / LAMPORTS_PER_SOL;
  } catch (e) {
    const msg = e.message || "";
    if (!msg.includes("AccountNotFound") && !msg.includes("does not exist") && !msg.includes("custom program error"))
      log(`  [pumpswap] Error: ${msg.split("\n")[0]}`);
    return 0;
  }
}

// ── Start auto-claim loop ─────────────────────────────────────────────────────
function startAutoClaimFees(connection, creatorKP, log) {
  log(`[AutoClaim] pump.fun vault  : ${derivePumpVault(creatorKP.publicKey).toBase58()}`);
  log(`[AutoClaim] PumpSwap vault  : ${derivePumpSwapVaultAuthority(creatorKP.publicKey).toBase58()}`);
  log(`[AutoClaim] Interval: ${CLAIM_INTERVAL_MS/1000}s | Min: ◎${MIN_CLAIM_LAMPORTS/LAMPORTS_PER_SOL}`);

  const run = async () => {
    await claimPumpFees(connection, creatorKP, log).catch(() => {});
    await claimPumpSwapFees(connection, creatorKP, log).catch(() => {});
  };

  run();
  setInterval(run, CLAIM_INTERVAL_MS);
}

module.exports = { startAutoClaimFees };
