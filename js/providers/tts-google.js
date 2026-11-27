// 音声合成の部品（第2段階）: Google Cloud Text-to-Speech（Chirp 3 HD）。
// 文を渡すと音声データ（MP3）を返します。鍵は利用者のブラウザから Google に直接送ります。
const BASE = 'https://texttospeech.googleapis.com/v1';

class GoogleTtsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function describeGoogleError(err) {
  const detail = err?.message ? `（詳細: ${err.message}）` : '';
  if (err?.status === 400) return `Googleの鍵か声の指定が正しくないようです。設定画面を確認してください。${detail}`;
  if (err?.status === 403) return `Googleに拒否されました。Text-to-Speech APIが有効か、支払い設定が済んでいるか、鍵の制限（使えるサイト・API）が合っているかを確認してください。${detail}`;
  if (err?.status === 429) return `Googleの利用上限に当たりました。少し待ってから「続きから再開」を押してください。${detail}`;
  if (err?.status >= 500) return `Google側でエラーが起きました。少し待ってから再開してください。${detail}`;
  if (err instanceof GoogleTtsError) return `音声の作成に失敗しました。${detail}`;
  return `Googleに接続できませんでした。通信状態を確認して、もう一度お試しください。${detail}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
        if (err.name === 'AbortError' || attempt >= retries) throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res.json();
      const body = await res.json().catch(() => null);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        throw new GoogleTtsError(res.status, body?.error?.message || `HTTP ${res.status}`);
      }
      await sleep(1000 * 2 ** attempt);
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
    async synthesize(text, voice, { signal } = {}) {
      const data = await call('/text:synthesize', {
        method: 'POST',
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'ja-JP', name: voice },
          audioConfig: { audioEncoding: 'MP3' },
        }),
      }, { signal });
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
