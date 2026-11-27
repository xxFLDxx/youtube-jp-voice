// 音声合成の部品（第2段階）: Google Cloud Text-to-Speech（Chirp 3 HD）。
// 文を渡すと音声データ（MP3）を返します。鍵は利用者のブラウザから Google に直接送ります。
const BASE = 'https://texttospeech.googleapis.com/v1';

// Googleの「1分あたり60回」の上限に当たらないよう、送信は1分に50回まで（1.2秒に1回）に抑える
const MIN_INTERVAL_MS = 60_000 / 50;
const MINUTE_WAIT_MS = 60_000;   // 1分あたりの上限に当たったときに待つ時間
const MAX_MINUTE_WAITS = 5;      // 同じ文で何回まで待ってやり直すか（超えたら止めて知らせる）

class GoogleTtsError extends Error {
  constructor(status, message, raw = '') {
    super(message);
    this.status = status;
    // 上限エラー(429)が「1日あたり」のものか（待っても直らないので、止めて知らせる）
    this.daily = status === 429 && /per\s*day|perday|\/d\/|daily/i.test(`${message} ${raw}`);
  }
}

export function describeGoogleError(err) {
  const detail = err?.message ? `（詳細: ${err.message}）` : '';
  if (err?.status === 400) return `Googleの鍵か声の指定が正しくないようです。設定画面を確認してください。${detail}`;
  if (err?.status === 403) return `Googleに拒否されました。Text-to-Speech APIが有効か、支払い設定が済んでいるか、鍵の制限（使えるサイト・API）が合っているかを確認してください。${detail}`;
  if (err?.status === 429 && err.daily) return `Googleの1日あたりの上限に当たりました。上限が元に戻ってから（通常は翌日）「続きから再開」を押してください。${detail}`;
  if (err?.status === 429) return `Googleの1分あたりの上限に続けて当たったため、止めました。数分待ってから「続きから再開」を押してください。${detail}`;
  if (err?.status >= 500) return `Google側でエラーが起きました。少し待ってから再開してください。${detail}`;
  if (err instanceof GoogleTtsError) return `音声の作成に失敗しました。${detail}`;
  return `Googleに接続できませんでした。通信状態を確認して、もう一度お試しください。${detail}`;
}

// 中断（signal）に対応した待機
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createGoogleTts(apiKey) {
  async function call(path, init = {}, { signal, retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(BASE + path, {
          ...init,
          signal,
          headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        if (signal?.aborted || attempt >= retries) throw err;
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      if (res.ok) return res.json();
      const body = await res.json().catch(() => null);
      // 一時的なサーバーエラーだけ、少し待ってやり直す（上限エラー 429 は synthesize 側で扱う）
      if (res.status < 500 || attempt >= retries) {
        throw new GoogleTtsError(res.status, body?.error?.message || `HTTP ${res.status}`, JSON.stringify(body ?? ''));
      }
      await sleep(1000 * 2 ** attempt, signal);
    }
  }

  // 送信の間隔と、上限に当たったときの一時停止。並行して動く処理すべてで共有する
  let nextSlot = 0;       // 次に送信してよい時刻
  let pausedUntil = 0;    // 上限に当たって待っている場合、その終了時刻

  // 送信してよくなるまで待つ。待っている間は onWait(残り秒) を1秒ごとに呼ぶ
  async function waitForTurn(signal, onWait) {
    for (;;) {
      while (Date.now() < pausedUntil) {
        const left = pausedUntil - Date.now();
        onWait?.(Math.ceil(left / 1000));
        await sleep(Math.min(1000, left), signal);
      }
      onWait?.(0);
      const now = Date.now();
      const at = Math.max(now, nextSlot);
      nextSlot = at + MIN_INTERVAL_MS;
      if (at > now) await sleep(at - now, signal);
      if (Date.now() >= pausedUntil) return;
    }
  }

  return {
    name: 'Google Chirp 3 HD',

    // 日本語の Chirp 3 HD の声の一覧（鍵の確認も兼ねる。料金はかかりません）
    async listVoices({ signal } = {}) {
      const data = await call('/voices?languageCode=ja-JP', { method: 'GET' }, { signal });
      return (data.voices || [])
        .filter(v => /Chirp3-HD/i.test(v.name))
        .map(v => ({ name: v.name, gender: v.ssmlGender }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    // 戻り値: 音声データ（Blob, audio/mpeg）
    // 1分あたりの上限(429)に当たったら、1分待って自動でやり直す。1日あたりの上限なら、すぐにエラーにする。
    async synthesize(text, voice, { signal, onWait } = {}) {
      let data;
      for (let waits = 0; ; waits++) {
        await waitForTurn(signal, onWait);
        try {
          data = await call('/text:synthesize', {
            method: 'POST',
            body: JSON.stringify({
              input: { text },
              voice: { languageCode: 'ja-JP', name: voice },
              audioConfig: { audioEncoding: 'MP3' },
            }),
          }, { signal });
          break;
        } catch (err) {
          if (err.status !== 429 || err.daily || waits >= MAX_MINUTE_WAITS) throw err;
          pausedUntil = Math.max(pausedUntil, Date.now() + MINUTE_WAIT_MS);
        }
      }
      const bytes = Uint8Array.from(atob(data.audioContent), ch => ch.charCodeAt(0));
      return new Blob([bytes], { type: 'audio/mpeg' });
    },
  };
}

// 音声データの長さ（秒）を調べる。分からなければ null
export function audioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const finish = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.onloadedmetadata = () => finish(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => finish(null);
    setTimeout(() => finish(null), 5000);
    a.preload = 'metadata';
    a.src = url;
  });
}
