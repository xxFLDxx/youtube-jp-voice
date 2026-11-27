// YouTube の「文字起こしを表示」からコピーした文章を、時刻つきの行に読み取る。
// 想定する形（時刻と文が別の行でも、同じ行でもよい）:
//   0:00
//   hello everyone
//   0:03 welcome back
//   1:02:15
//   ...
const TIME_LINE = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*(.*)$/;

function toSeconds(stamp) {
  return stamp.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

// 戻り値: [{ t: 開始秒, text: 英文 }]（時刻の前にある見出しなどは捨てる）
export function parseTranscript(raw) {
  const cues = [];
  let cur = null;
  for (const line of (raw || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const m = text.match(TIME_LINE);
    if (m) {
      cur = { t: toSeconds(m[1]), text: m[2].trim() };
      cues.push(cur);
    } else if (cur) {
      cur.text = cur.text ? `${cur.text} ${text}` : text;
    }
  }
  return cues.filter(c => c.text).sort((a, b) => a.t - b.t);
}

export function summarize(cues) {
  const chars = cues.reduce((n, c) => n + c.text.length, 0);
  const last = cues[cues.length - 1];
  return { lines: cues.length, chars, durationSec: last ? last.t : 0 };
}
