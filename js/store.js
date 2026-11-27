// 変換一覧の保存（このブラウザの中だけ。サーバーには送りません）
const KEY = 'ytjp.items.v1';

export function listItems() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

function save(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* 保存できなくても動作は続ける */ }
}

export function getItem(videoId) {
  return listItems().find(i => i.videoId === videoId) || null;
}

export function addItem(item) {
  const items = listItems().filter(i => i.videoId !== item.videoId);
  items.unshift({ ...item, addedAt: Date.now() });
  save(items);
}

export function removeItem(videoId) {
  save(listItems().filter(i => i.videoId !== videoId));
}
