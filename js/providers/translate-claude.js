// 翻訳の部品（第2段階）: Claude API で、時刻つきの英語の文字起こしを
// 「開始秒・終了秒・日本語文」のリストにする。公式SDKを使い、ブラウザから直接呼びます。
import Anthropic from '../../vendor/anthropic-sdk.js';

export const MODEL = 'claude-sonnet-5-5';
export const CHUNK_CHARS = 5000;   // 1回の翻訳に渡す英語の文字数の目安

const SYSTEM = `You write Japanese dubbing lines for an English YouTube video.

The input is the video's transcript as caption fragments, each prefixed with its start time in seconds, like "[12.3] so today we're going to". Fragments are arbitrary slices of speech, not sentences. A text-to-speech voice will read your Japanese lines aloud over the muted video, each line starting at its "start" time, so the listener hears Japanese roughly when the speaker says the same thing.

Produce one line per sentence:
- "start": the time of the fragment in which the sentence begins.
- "end": the time at which the sentence finishes (normally the start time of the fragment where the next sentence begins). Always greater than "start".
- "text": the sentence in natural spoken Japanese (です・ます調), as a good interpreter would say it. It is read aloud, so write numbers, units and names the way they are easy to say, and keep widely used English names as they are normally written in Japanese.

Timing matters as much as wording. The Japanese voice speaks about 7 characters per second, and each line must fit between its own start and the next line's start. Aim for at most about 6 Japanese characters per second of that window. English speech is denser than that, so translate concisely: keep the meaning, drop fillers, false starts, repetition and asides. If a sentence runs longer than about 12 seconds, split it into two lines at a natural break.

Leave out anything that is not speech (for example "[Music]", "[Applause]") and stray chapter headings. Do not add information that is not in the transcript.

The transcript arrives in consecutive chunks. A chunk can stop in the middle of a sentence. Unless the user message says it is the final chunk, do not translate a sentence that is cut off at the end of the chunk: set "incomplete_from" to the start time of the fragment where that unfinished sentence begins, and it will be sent again with the next chunk. Otherwise set "incomplete_from" to null.`;

const SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['start', 'end', 'text'],
        additionalProperties: false,
      },
    },
    incomplete_from: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  },
  required: ['segments', 'incomplete_from'],
  additionalProperties: false,
};

// 利用者に見せる日本語のエラー文にする（元のメッセージも添える）
export function describeClaudeError(err) {
  const detail = err?.message ? `（詳細: ${err.message}）` : '';
  if (err instanceof Anthropic.AuthenticationError) return `Claudeの鍵が正しくないようです。設定画面で入れ直してください。${detail}`;
  if (err instanceof Anthropic.PermissionDeniedError) return `このClaudeの鍵では利用が許可されていません。${detail}`;
  if (err instanceof Anthropic.RateLimitError) return `Claudeの利用上限に当たりました。少し待ってから「続きから再開」を押してください。${detail}`;
  if (err instanceof Anthropic.BadRequestError) return `Claudeがリクエストを受け付けませんでした。残高（クレジット）が不足している場合もここに出ます。${detail}`;
  if (err instanceof Anthropic.APIConnectionError) return `Claudeに接続できませんでした。通信状態を確認して、もう一度お試しください。${detail}`;
  if (err instanceof Anthropic.APIError) return `Claude側でエラーが起きました（${err.status ?? '不明'}）。少し待ってから再開してください。${detail}`;
  return err?.message || '翻訳に失敗しました。';
}

export function createClaudeTranslator(apiKey) {
  // dangerouslyAllowBrowser: 鍵を利用者自身のブラウザに置いて直接呼ぶ、という今回の使い方を明示する指定
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });

  async function request(params, signal) {
    // 安全上の理由でモデルが応答を断った場合に、別モデルで自動的にやり直してもらう指定（fallbacks）つきで送る。
    // この指定自体が受け付けられなかった場合（400）に限り、指定なしで1回だけ送り直す。
    try {
      return await client.beta.messages.stream({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }, { signal }).finalMessage();
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      return await client.messages.stream(params, { signal }).finalMessage();
    }
  }

  return {
    name: 'Claude',
    model: MODEL,

    // 鍵とモデルが使えるかの確認（料金はかかりません）
    async check() {
      await client.models.retrieve(MODEL);
    },

    // cues: [{t, text}]（この回に渡す分） / chunkEnd: この回の末尾の時刻
    // 戻り値: { segments:[{start,end,text}], incompleteFrom: 秒 | null, usage:{inputTokens, outputTokens} }
    async translateChunk({ cues, chunkEnd, isLast, previousLines = [] }, { signal } = {}) {
      const lines = cues.map(c => `[${c.t}] ${c.text}`).join('\n');
      const context = previousLines.length
        ? `The Japanese lines just before this chunk, for continuity of wording (do not repeat them):\n${previousLines.join('\n')}\n\n`
        : '';
      const tail = isLast
        ? `This is the final chunk; the video's speech ends at about ${chunkEnd} seconds. Translate everything.`
        : `This chunk ends at ${chunkEnd} seconds and more follows.`;

      const message = await request({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM,
        messages: [{ role: 'user', content: `${context}Transcript chunk:\n${lines}\n\n${tail}` }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      }, signal);

      if (message.stop_reason === 'refusal') throw new Error('Claudeがこの内容の翻訳を断りました。');
      if (message.stop_reason === 'max_tokens') throw new Error('翻訳結果が長すぎて途中で切れました。');

      const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('翻訳結果を読み取れませんでした。もう一度お試しください。'); }
      return {
        segments: Array.isArray(data.segments) ? data.segments : [],
        incompleteFrom: typeof data.incomplete_from === 'number' ? data.incomplete_from : null,
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}
