// 設定（APIの鍵・声の種類）の保存。このブラウザの中（localStorage）だけに置きます。
// 鍵はここ以外のファイルに書かず、ログにも出しません。
const KEY = 'ytjp.settings.v1';

export const DEFAULT_VOICE = 'ja-JP-Chirp3-HD-Aoede';

export function getSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* 壊れていたら空として扱う */ }
  return {
    claudeKey: s.claudeKey || '',
    googleKey: s.googleKey || '',
    voice: s.voice || DEFAULT_VOICE,
  };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

// 画面表示用: 鍵そのものは見せず、末尾4文字だけ
export const maskKey = (key) => (key ? `保存済み（末尾 …${key.slice(-4)}）` : '未設定');
