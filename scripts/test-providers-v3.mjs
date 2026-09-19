const providers = ["https://mempool.space/api", "https://blockstream.info/api"];
async function publicSample() {
  const tip = await fetch(`${providers[0]}/blocks/tip/hash`).then((r) =>
    r.text(),
  );
  const txs = await fetch(`${providers[0]}/block/${tip}/txs`).then((r) =>
    r.json(),
  );
  for (const tx of txs)
    for (const out of tx.vout)
      if (out.scriptpubkey_address) {
        const r = await fetch(
          `${providers[0]}/address/${out.scriptpubkey_address}/utxo`,
        );
        if (r.ok) return { address: out.scriptpubkey_address, txid: tx.txid };
      }
  throw new Error("No usable public sample found");
}
async function check(base, { address, txid }) {
  const paths = [
    `/address/${address}`,
    `/address/${address}/utxo`,
    `/address/${address}/txs`,
    `/tx/${txid}/status`,
    "/fee-estimates",
  ];
  for (const path of paths) {
    const res = await fetch(base + path);
    if (!res.ok) throw new Error(`${base}${path}: ${res.status}`);
    if (!res.headers.get("access-control-allow-origin"))
      throw new Error(`${base}${path}: missing CORS header`);
    await res.text();
  }
  const invalidBroadcast = await fetch(`${base}/tx`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "00",
  });
  if (invalidBroadcast.status < 400)
    throw new Error(`${base}/tx accepted invalid raw transaction`);
  return `${base} OK (address, UTXO, history, status, fee, CORS; broadcast rejects invalid raw tx)`;
}
const sample = await publicSample();
console.log(`Cross-checking public mainnet address ${sample.address}`);
const results = await Promise.allSettled(
  providers.map((base) => check(base, sample)),
);
for (const result of results)
  console.log(
    result.status === "fulfilled" ? result.value : result.reason.message,
  );
if (results.some((result) => result.status !== "fulfilled"))
  process.exitCode = 1;
