import "./bitastra.css";
import { argon2id } from "hash-wasm";
import * as bitcoin from "bitcoinjs-lib";
import { BIP32Factory } from "bip32";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  chooseLanguage,
  languages,
  setLanguage,
  providerFetch,
} from "./bitastra-common.js";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc),
  ECPair = ECPairFactory(ecc),
  network = bitcoin.networks.bitcoin;
const $ = (id) => document.getElementById(id);
let secret = null,
  wallet = null,
  cachedUtxos = [],
  currentAddress = "";
const enc = new TextEncoder(),
  dec = new TextDecoder();
function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function unb64(value) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function notice(text, error = false) {
  const el = $("notice");
  el.textContent = text;
  el.classList.toggle("error", error);
}
function isTxid(value) {
  return /^[a-f0-9]{64}$/i.test(value);
}
function transactionLink(txid, label = txid) {
  const link = document.createElement("a");
  link.href = `https://mempool.space/tx/${txid}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}
function wipe() {
  if (secret) secret.fill(0);
  secret = null;
  wallet = null;
  cachedUtxos = [];
  currentAddress = "";
}
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("bitastra-vault", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("vault");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function getVault() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("vault", "readonly");
    const r = t.objectStore("vault").get("main");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function putVault(vault) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("vault", "readwrite");
    t.objectStore("vault").put(vault, "main");
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
async function deleteVault() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("vault", "readwrite");
    t.objectStore("vault").delete("main");
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
async function kdf(password, salt) {
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "binary",
  });
}
async function seal(seed, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await kdf(password, salt);
  const wek = crypto.getRandomValues(new Uint8Array(32));
  const vaultIv = crypto.getRandomValues(new Uint8Array(12)),
    wekIv = crypto.getRandomValues(new Uint8Array(12));
  const c = crypto.subtle;
  const encryptedVault = await c.encrypt(
    { name: "AES-GCM", iv: vaultIv },
    await c.importKey("raw", wek, "AES-GCM", false, ["encrypt"]),
    enc.encode(seed),
  );
  const encryptedWek = await c.encrypt(
    { name: "AES-GCM", iv: wekIv },
    await c.importKey("raw", kek, "AES-GCM", false, ["encrypt"]),
    wek,
  );
  wek.fill(0);
  kek.fill(0);
  return {
    v: 1,
    kdf: "Argon2id",
    cipher: "AES-256-GCM",
    salt: b64(salt),
    vaultIv: b64(vaultIv),
    wekIv: b64(wekIv),
    encryptedWek: b64(encryptedWek),
    encryptedVault: b64(encryptedVault),
  };
}
async function open(vault, password) {
  const kek = await kdf(password, unb64(vault.salt));
  const c = crypto.subtle;
  let wek;
  try {
    wek = new Uint8Array(
      await c.decrypt(
        { name: "AES-GCM", iv: unb64(vault.wekIv) },
        await c.importKey("raw", kek, "AES-GCM", false, ["decrypt"]),
        unb64(vault.encryptedWek),
      ),
    );
    const seed = new Uint8Array(
      await c.decrypt(
        { name: "AES-GCM", iv: unb64(vault.vaultIv) },
        await c.importKey("raw", wek, "AES-GCM", false, ["decrypt"]),
        unb64(vault.encryptedVault),
      ),
    );
    return dec.decode(seed);
  } finally {
    kek.fill(0);
    if (wek) wek.fill(0);
  }
}
function derive(seedPhrase) {
  const root = bip32.fromSeed(mnemonicToSeedSync(seedPhrase), network);
  const node = root.derivePath("m/84'/0'/0'/0/0");
  const payment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(node.publicKey),
    network,
  });
  return { node, address: payment.address, script: payment.output };
}
function showWallet() {
  wallet = derive(dec.decode(secret));
  currentAddress = wallet.address;
  $("address").textContent = currentAddress;
  $("gate").classList.add("hidden");
  $("wallet").classList.remove("hidden");
}
async function saveAndShow(seed, password, reveal) {
  await putVault(await seal(seed, password));
  secret = enc.encode(seed);
  if (reveal) {
    $("onboard").classList.add("hidden");
    $("backup").classList.remove("hidden");
    $("seed-words").textContent = seed;
  } else showWallet();
}
async function sync() {
  notice("Syncing independent providers…");
  try {
    const [a, u, h] = await Promise.all([
      providerFetch(`/address/${currentAddress}`),
      providerFetch(`/address/${currentAddress}/utxo`),
      providerFetch(`/address/${currentAddress}/txs`),
    ]);
    const address = await a.response.json(),
      utxos = await u.response.json(),
      history = await h.response.json();
    cachedUtxos = utxos;
    $("balance").textContent =
      `${(Number(address.chain_stats.funded_txo_sum - address.chain_stats.spent_txo_sum) / 1e8).toFixed(8)} BTC`;
    $("provider").textContent =
      `Data: ${a.provider.replace("https://", "")} · ${utxos.length} UTXO(s)`;
    const historyEl = $("history");
    historyEl.replaceChildren();
    const validHistory = history.filter((tx) => isTxid(tx.txid)).slice(0, 12);
    if (!validHistory.length) historyEl.textContent = "No transaction history.";
    for (const tx of validHistory) {
      const link = transactionLink(tx.txid, `${tx.txid.slice(0, 18)}… ${tx.status.confirmed ? "confirmed" : "pending"}`);
      historyEl.append(link);
    }
    notice("Synced.");
  } catch (_) {
    notice(
      "Network unavailable — neither independent provider responded. Your balance has not been changed.",
      true,
    );
  }
}
async function send() {
  const recipient = $("recipient").value.trim(),
    btc = Number($("amount").value),
    feeRate = Number($("fee-rate").value);
  if (
    !recipient ||
    !Number.isFinite(btc) ||
    btc <= 0 ||
    !Number.isFinite(feeRate) ||
    feeRate < 1
  )
    return notice("Enter a valid recipient, amount, and fee rate.", true);
  if (!cachedUtxos.length)
    return notice("Sync first; no spendable UTXOs are available.", true);
  let output;
  try {
    output = bitcoin.address.toOutputScript(recipient, network);
  } catch (_) {
    return notice("Invalid Bitcoin mainnet recipient address.", true);
  }
  const target = BigInt(Math.round(btc * 1e8));
  let total = 0n,
    selected = [];
  for (const u of cachedUtxos) {
    selected.push(u);
    total += BigInt(u.value);
    if (
      total >=
      target + BigInt(Math.ceil(feeRate * (10 + selected.length * 68 + 62)))
    )
      break;
  }
  const fee = BigInt(Math.ceil(feeRate * (10 + selected.length * 68 + 62)));
  if (total < target + fee)
    return notice(
      "Insufficient confirmed balance for this amount and fee.",
      true,
    );
  const change = total - target - fee;
  if (
    !confirm(
      `Send ${btc} BTC to ${recipient}?\nEstimated fee: ${Number(fee) / 1e8} BTC\nThis action cannot be undone.`,
    )
  )
    return;
  try {
    const psbt = new bitcoin.Psbt({ network });
    for (const u of selected)
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: { script: wallet.script, value: BigInt(u.value) },
      });
    psbt.addOutput({ script: output, value: target });
    if (change > 546n) {
      const changeNode = bip32
        .fromSeed(mnemonicToSeedSync(dec.decode(secret)), network)
        .derivePath("m/84'/0'/0'/1/0");
      const changeAddress = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(changeNode.publicKey),
        network,
      }).address;
      psbt.addOutput({ address: changeAddress, value: change });
    }
    const signer = ECPair.fromPrivateKey(Buffer.from(wallet.node.privateKey));
    selected.forEach((_, i) => psbt.signInput(i, signer));
    psbt.finalizeAllInputs();
    const raw = psbt.extractTransaction().toHex();
    $("send-result").textContent = "Broadcasting signed raw transaction…";
    const { response, provider } = await providerFetch("/tx", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: raw,
    });
    const txid = (await response.text()).trim();
    if (!isTxid(txid)) throw new Error("Provider returned an invalid transaction ID");
    const result = $("send-result");
    result.replaceChildren(`Broadcast by ${provider.replace("https://", "")}: `, transactionLink(txid));
    await sync();
  } catch (error) {
    notice(`Transaction was not reported as broadcast: ${error.message}`, true);
  }
}
function initLanguage() {
  const p = $("language");
  const lang = chooseLanguage();
  for (const [value, label] of Object.entries(languages))
    p.add(new Option(label, value));
  p.value = lang;
  document.documentElement.lang = lang;
  p.addEventListener("change", () => {
    setLanguage(p.value);
    document.documentElement.lang = p.value;
  });
}
function mode(name) {
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === name));
  $("create-form").classList.toggle("hidden", name !== "create");
  $("restore-form").classList.toggle("hidden", name !== "restore");
}
document
  .querySelectorAll("[data-mode]")
  .forEach((b) => b.addEventListener("click", () => mode(b.dataset.mode)));
$("create-wallet").onclick = async () => {
  const p = $("create-password").value;
  if (p.length < 12)
    return notice("Use a password of at least 12 characters.", true);
  try {
    await saveAndShow(generateMnemonic(wordlist, 128), p, true);
  } catch (_) {
    notice("Could not create local vault.", true);
  }
};
$("restore-wallet").onclick = async () => {
  const seed = $("restore-seed").value.trim().replace(/\s+/g, " "),
    p = $("restore-password").value;
  if (!validateMnemonic(seed, wordlist))
    return notice("That recovery phrase is not valid BIP39 English.", true);
  if (p.length < 12)
    return notice("Use a password of at least 12 characters.", true);
  try {
    await saveAndShow(seed, p, true);
  } catch (_) {
    notice("Could not restore local vault.", true);
  }
};
$("seed-saved").onclick = () => {
  $("backup").classList.add("hidden");
  showWallet();
};
$("unlock-wallet").onclick = async () => {
  try {
    const seed = await open(await getVault(), $("unlock-password").value);
    secret = enc.encode(seed);
    $("unlock-password").value = "";
    showWallet();
  } catch (_) {
    notice("Could not unlock this local vault. Check your password.", true);
  }
};
$("sync").onclick = sync;
$("lock").onclick = () => {
  wipe();
  $("wallet").classList.add("hidden");
  $("gate").classList.remove("hidden");
  $("onboard").classList.add("hidden");
  $("unlock").classList.remove("hidden");
  notice("Wallet locked.");
};
$("copy-address").onclick = async () => {
  try {
    await navigator.clipboard.writeText(currentAddress);
    notice("Address copied. Verify it before sharing.");
  } catch (_) {
    notice(
      "Clipboard access was unavailable; copy the address manually.",
      true,
    );
  }
};
$("review-send").onclick = send;
$("delete-vault").onclick = async () => {
  if (
    confirm(
      "Delete this local vault? This cannot be undone. Make sure your recovery phrase is safely backed up.",
    )
  ) {
    await deleteVault();
    wipe();
    location.reload();
  }
};
initLanguage();
(async () => {
  if (await getVault()) {
    $("onboard").classList.add("hidden");
    $("unlock").classList.remove("hidden");
  }
})();
window.addEventListener("beforeunload", wipe);
setInterval(
  () => {
    if (secret) {
      wipe();
      $("wallet").classList.add("hidden");
      $("gate").classList.remove("hidden");
      $("onboard").classList.add("hidden");
      $("unlock").classList.remove("hidden");
      notice("Wallet locked after inactivity.");
    }
  },
  5 * 60 * 1000,
);
