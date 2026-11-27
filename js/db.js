// 変換結果の保存（このブラウザの中の IndexedDB）。
//   transcripts: 動画ごとの日本語文  { videoId, title, segments:[{start,end,text,audioDur?}], ... }
//   audio:       文ごとの音声データ  キー "動画ID:文番号"
//   jobs:        変換途中の状態（中断しても続きから再開するため）
const NAME = 'ytjp';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('transcripts')) db.createObjectStore('transcripts', { keyPath: 'videoId' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'videoId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const audioKey = (videoId, i) => `${videoId}:${i}`;
const audioRange = (videoId) => IDBKeyRange.bound(`${videoId}:`, `${videoId}:￿`);

export const getTranscript = (videoId) => run('transcripts', 'readonly', s => s.get(videoId));
export const putTranscript = (rec) => run('transcripts', 'readwrite', s => s.put(rec));

export const getJob = (videoId) => run('jobs', 'readonly', s => s.get(videoId));
export const putJob = (job) => run('jobs', 'readwrite', s => s.put(job));
export const deleteJob = (videoId) => run('jobs', 'readwrite', s => s.delete(videoId));

export const getAudio = (videoId, i) => run('audio', 'readonly', s => s.get(audioKey(videoId, i)));
export const putAudio = (videoId, i, blob) => run('audio', 'readwrite', s => s.put(blob, audioKey(videoId, i)));
export const countAudio = (videoId) => run('audio', 'readonly', s => s.count(audioRange(videoId)));
export const deleteAudio = (videoId) => run('audio', 'readwrite', s => s.delete(audioRange(videoId)));

export async function deleteVideo(videoId) {
  await Promise.all([
    run('transcripts', 'readwrite', s => s.delete(videoId)),
    deleteJob(videoId),
    deleteAudio(videoId),
  ]);
}
