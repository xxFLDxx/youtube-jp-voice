// YouTube 公式 IFrame Player API の読み込みと、URL から動画IDを取り出す処理

let apiPromise = null;

export function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('YouTubeプレーヤーを読み込めませんでした。')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseVideoId(input) {
  const text = (input || '').trim();
  if (ID_RE.test(text)) return text;
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
      if (m) id = m[1];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

export const thumbnailUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
