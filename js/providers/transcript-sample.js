// 翻訳の部品（第1段階）: data/samples/ の見本JSONを読むだけ。
// 第2段階では、同じ形のデータを翻訳AIから受け取る部品に差し替えます。
//
// 返すデータの形:
//   { videoId, title, segments: [{ start: 秒, end: 秒, text: '日本語文' }, ...] }

export class TranscriptNotAvailableError extends Error {}

export function createSampleTranscriptProvider(baseUrl = 'data/samples/') {
  return {
    name: '見本データ',

    // 用意されている見本の一覧 [{ videoId, title }]
    async listAvailable() {
      const res = await fetch(baseUrl + 'index.json');
      if (!res.ok) return [];
      return res.json();
    },

    async getTranscript(videoId) {
      const res = await fetch(baseUrl + encodeURIComponent(videoId) + '.json');
      if (!res.ok) {
        throw new TranscriptNotAvailableError(
          'この段階では見本データのある動画だけ変換できます。');
      }
      const data = await res.json();
      const segments = (data.segments || [])
        .filter(s => s.text && s.end > s.start)
        .sort((a, b) => a.start - b.start);
      return { videoId, title: data.title || videoId, segments };
    },
  };
}
