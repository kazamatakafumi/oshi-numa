// 推し沼深度計の公式Xアカウントに、posts/queue.json の投稿を1件ずつ流す。
// GitHub Actions から月・水・金に呼ばれる。Xのキーが未設定なら何もしないで終わる。
import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const SITE_URL = 'https://kazamatakafumi.github.io/oshi-numa/';
const HASHTAG = '#推し沼深度計';
const SKIP_IF_OLDER_THAN_DAYS = 3; // これより古い予定は流さない
const DRY = !!process.env.DRY_RUN;

const QUEUE = new URL('../posts/queue.json', import.meta.url);
const STATE = new URL('../posts/state.json', import.meta.url);

const todayJST = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

function compose(item) {
  return [item.text, '', item.link ? SITE_URL : null, HASHTAG].filter((l) => l !== null).join('\n');
}

// X の文字数（日本語などは2、URLは一律23）
function xLength(s) {
  const urls = s.match(/https?:\/\/\S+/g) ?? [];
  let rest = s;
  for (const u of urls) rest = rest.replace(u, '');
  let n = urls.length * 23;
  for (const ch of rest) n += ch.codePointAt(0) <= 0x10ff ? 1 : 2;
  return n;
}

const pct = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function postX(text) {
  const url = 'https://api.x.com/2/tweets';
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  const oauth = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const params = Object.keys(oauth).sort().map((k) => `${pct(k)}=${pct(oauth[k])}`).join('&');
  const base = ['POST', pct(url), pct(params)].join('&');
  oauth.oauth_signature = crypto
    .createHmac('sha1', `${pct(X_API_SECRET)}&${pct(X_ACCESS_SECRET)}`)
    .update(base)
    .digest('base64');
  const auth = 'OAuth ' + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(', ');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      res.status === 401 ? '→ キーが違う。Secrets の4つを入れ直す'
      : res.status === 403 ? '→ アプリの権限が Read and write になっているか、Access Token を作り直したか確認'
      : res.status === 402 ? '→ クレジット残高が足りない可能性'
      : res.status === 429 ? '→ 投稿しすぎ。時間をおいて再実行'
      : '';
    throw new Error(`X ${res.status}: ${JSON.stringify(json)} ${hint}`);
  }
  return json.data?.id;
}

async function main() {
  const queue = JSON.parse(await readFile(QUEUE, 'utf8'));
  let state;
  try { state = JSON.parse(await readFile(STATE, 'utf8')); } catch { state = { posted: {}, skipped: {} }; }
  const today = todayJST();

  // 今日までの日付で、まだ流していないもの
  const due = queue.filter((q) => q.date <= today && !state.posted[q.date] && !state.skipped[q.date]);
  // いちばん新しい1件だけを流し、それより前の未投稿分は飛ばす（遅れがたまって季節ネタがずれないように）
  const next = due.filter((q) => days(q.date, today) <= SKIP_IF_OLDER_THAN_DAYS).at(-1);
  for (const q of due) if (q !== next) state.skipped[q.date] = today;
  const left = queue.filter((q) => q.date > today).length;

  if (!next) {
    console.log(`今日流す投稿はありません（残り ${left} 件）`);
  } else {
    const text = compose(next);
    if (xLength(text) > 280) throw new Error(`文字数オーバー: ${next.date}`);
    console.log(`----- ${next.date} -----\n${text}\n`);
    if (DRY) {
      console.log('DRY RUN なので投稿しません');
    } else if (!process.env.X_API_KEY) {
      console.log('Xのキーが未設定なので投稿しません（Secrets に X_API_KEY などを入れると動き出します）');
      return;
    } else {
      const id = await postX(text);
      state.posted[next.date] = id;
      console.log(`投稿しました: https://x.com/i/status/${id}`);
    }
  }
  if (left <= 6) console.log(`::warning::予約投稿の残りが ${left} 件です。Claude に追加を頼んでください`);
  if (!DRY) await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
