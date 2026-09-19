export const LANG_KEY = "bitastra-language";
export const languages = {
  en: "English",
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
};

const en = {
  open: "Open Wallet",
  security: "Security",
  privacy: "Privacy",
  about: "About",
  hero: "Hold it. Own it.",
  heroCopy:
    "A private self-custody wallet built for the assets you want to keep under your own control.",
  noise: "SELF-CUSTODY. WITHOUT THE NOISE.",
  skip: "Keep the wallet. Skip the exchange.",
  keys: "Your keys stay on your device.",
  connected: "The blockchain, without giving up your keys.",
  local: "Sensitive data stays local.",
  foundation: "Built from proven wallet technology.",
  create: "Create wallet",
  restore: "Restore wallet",
  unlock: "Unlock wallet",
  password: "Password",
  seed: "Recovery phrase",
  receive: "Receive",
  send: "Send",
  assets: "Assets",
  activity: "Activity",
  settings: "Settings",
  lock: "Lock",
  sync: "Sync",
  unavailable:
    "Network unavailable — neither independent provider responded. Your balance has not been changed.",
  localOnly:
    "Your recovery phrase, password and signing keys stay in this browser. Only public addresses, transaction IDs and signed raw transactions are sent to blockchain providers.",
  noExchange: "BitAstra does not provide buying, selling or swapping.",
};
const zhTW = {
  ...en,
  open: "開啟錢包",
  security: "安全性",
  privacy: "隱私",
  about: "關於",
  hero: "持有它。掌握它。",
  heroCopy: "為您想完全掌握的資產打造的私密自我託管錢包。",
  noise: "自我託管，沒有雜訊。",
  skip: "保留錢包，跳過交易所。",
  keys: "你的金鑰留在裝置上。",
  connected: "連上區塊鏈，不交出金鑰。",
  local: "敏感資料留在本機。",
  foundation: "建立於經驗證的錢包技術。",
  create: "建立錢包",
  restore: "恢復錢包",
  unlock: "解鎖錢包",
  password: "密碼",
  seed: "助記詞",
  receive: "收款",
  send: "發送",
  assets: "資產",
  activity: "活動",
  settings: "設定",
  lock: "鎖定",
  sync: "同步",
  unavailable: "網路無法使用：兩個獨立服務供應商皆未回應。餘額未被改動。",
  localOnly:
    "助記詞、密碼與簽名金鑰只留在此瀏覽器。區塊鏈服務商只會收到公開地址、交易 ID 與已簽署的原始交易。",
  noExchange: "BitAstra 不提供購買、出售或兌換。",
};
const zhCN = {
  ...zhTW,
  open: "打开钱包",
  hero: "持有它。掌握它。",
  heroCopy: "为您想完全掌握的资产打造的私密自托管钱包。",
  noise: "自托管，没有噪音。",
  skip: "保留钱包，跳过交易所。",
  keys: "你的密钥留在设备上。",
  connected: "连上区块链，不交出密钥。",
  local: "敏感数据留在本机。",
  create: "创建钱包",
  restore: "恢复钱包",
  unlock: "解锁钱包",
  password: "密码",
  seed: "助记词",
  receive: "收款",
  send: "发送",
  assets: "资产",
  activity: "活动",
  settings: "设置",
  lock: "锁定",
  sync: "同步",
  unavailable: "网络不可用：两个独立服务商均未响应。余额没有被更改。",
  localOnly:
    "助记词、密码和签名密钥只留在此浏览器。区块链服务商只会收到公开地址、交易 ID 和已签名原始交易。",
  noExchange: "BitAstra 不提供购买、出售或兑换。",
};
const short = (hero, open) => ({ ...en, hero, open });
export const copy = {
  en,
  "zh-TW": zhTW,
  "zh-CN": zhCN,
  ja: short("保有する。自分のものにする。", "ウォレットを開く"),
  ko: short("보유하세요. 소유하세요.", "지갑 열기"),
  es: short("Consérvalo. Hazlo tuyo.", "Abrir billetera"),
  de: short("Behalte es. Es gehört dir.", "Wallet öffnen"),
  fr: short("Gardez-le. Possédez-le.", "Ouvrir le portefeuille"),
};

export function chooseLanguage() {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored && languages[stored]) return stored;
  for (const raw of navigator.languages || [navigator.language || "en"]) {
    const l = raw.toLowerCase();
    if (l.startsWith("zh")) return /tw|hk|hant/.test(l) ? "zh-TW" : "zh-CN";
    for (const key of ["ja", "ko", "es", "de", "fr"])
      if (l.startsWith(key)) return key;
  }
  return "en";
}
export function setLanguage(lang) {
  localStorage.setItem(LANG_KEY, languages[lang] ? lang : "en");
}
export function providerFetch(path, options = {}) {
  const endpoints = [
    "https://mempool.space/api",
    "https://blockstream.info/api",
  ];
  const timeout = (url) =>
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out: ${url}`)), 12000),
    );
  return (async () => {
    let last;
    for (const base of endpoints) {
      try {
        const response = await Promise.race([
          fetch(base + path, {
            ...options,
            referrerPolicy: "no-referrer",
            credentials: "omit",
          }),
          timeout(base),
        ]);
        if (!response.ok) throw new Error(`${base}: ${response.status}`);
        return { response, provider: base };
      } catch (error) {
        last = error;
      }
    }
    throw last || new Error("Network unavailable");
  })();
}
