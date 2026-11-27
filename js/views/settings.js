import { h } from '../dom.js';
import { getSettings, saveSettings, maskKey, DEFAULT_VOICE } from '../settings.js';
import { createClaudeTranslator, describeClaudeError } from '../providers/translate-claude.js';
import { createGoogleTts, describeGoogleError } from '../providers/tts-google.js';

const SAMPLE_TEXT = 'こんにちは。この声で動画を読み上げます。';

export function renderSettings(root) {
  // 鍵1つ分の入力欄（保存・確認・削除）
  function keySection({ id, title, field, placeholder, check, help }) {
    const state = h('span', { class: 'key-state' });
    const status = h('p', { class: 'status', role: 'status' });
    const input = h('input', { type: 'password', id, autocomplete: 'off', spellcheck: 'false', placeholder });
    const refresh = () => { state.textContent = maskKey(getSettings()[field]); };
    const say = (msg, error) => { status.textContent = msg; status.className = error ? 'status error' : 'status'; };
    refresh();

    async function save(e) {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return say('鍵を入力してください。', true);
      saveSettings({ [field]: value });
      input.value = '';
      refresh();
      say('保存しました。使えるか確認しています…');
      try {
        await check(value);
        say('保存しました。この鍵は使えます。');
      } catch (err) {
        say(`保存しましたが、確認に失敗しました。${err.userMessage || err.message}`, true);
      }
    }

    return h('section', { class: 'card' },
      h('h2', {}, title),
      h('p', { class: 'key-line' }, '現在: ', state),
      h('form', { onsubmit: save, novalidate: true },
        h('label', { for: id }, '鍵を貼り付けて保存'),
        h('div', { class: 'row' }, input, h('button', { type: 'submit', class: 'primary' }, '保存')),
      ),
      h('div', { class: 'row gap' },
        h('button', {
          type: 'button', class: 'danger',
          onclick: () => {
            if (!getSettings()[field]) return say('鍵は保存されていません。');
            if (!confirm(`${title}をこのブラウザから削除しますか？`)) return;
            saveSettings({ [field]: '' });
            refresh();
            say('削除しました。');
          },
        }, 'このブラウザから削除'),
      ),
      status,
      h('p', { class: 'note' }, help),
    );
  }

  // 声の選択
  const voiceSel = h('select', { id: 'voice-select' }, h('option', { value: getSettings().voice }, getSettings().voice));
  const voiceStatus = h('p', { class: 'status', role: 'status' });
  const sayVoice = (msg, error) => { voiceStatus.textContent = msg; voiceStatus.className = error ? 'status error' : 'status'; };
  voiceSel.addEventListener('change', () => { saveSettings({ voice: voiceSel.value }); sayVoice('声を保存しました。'); });

  function needGoogle() {
    const { googleKey } = getSettings();
    if (!googleKey) sayVoice('先にGoogleの鍵を保存してください。', true);
    return googleKey ? createGoogleTts(googleKey) : null;
  }

  async function loadVoices() {
    const tts = needGoogle();
    if (!tts) return;
    sayVoice('声の一覧を読み込んでいます…');
    try {
      const voices = await tts.listVoices();
      if (!voices.length) return sayVoice('日本語の Chirp 3 HD の声が見つかりませんでした。', true);
      const current = getSettings().voice;
      voiceSel.replaceChildren(...voices.map(v => h('option', { value: v.name, selected: v.name === current },
        `${v.name.replace('ja-JP-Chirp3-HD-', '')}（${v.gender === 'FEMALE' ? '女性' : v.gender === 'MALE' ? '男性' : '—'}）`)));
      if (!voices.some(v => v.name === current)) saveSettings({ voice: voiceSel.value });
      sayVoice(`${voices.length} 種類の声を読み込みました。`);
    } catch (err) {
      sayVoice(describeGoogleError(err), true);
    }
  }

  async function preview() {
    const tts = needGoogle();
    if (!tts) return;
    sayVoice('試聴用の音声を作っています…');
    try {
      const blob = await tts.synthesize(SAMPLE_TEXT, getSettings().voice);
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
      sayVoice(`試聴中です（${SAMPLE_TEXT.length}文字ぶんの利用になります）。`);
    } catch (err) {
      sayVoice(describeGoogleError(err), true);
    }
  }

  root.append(h('div', { class: 'stack' },
    h('h1', {}, '設定'),
    h('p', { class: 'note lead' },
      '鍵は、このブラウザの中だけに保存されます。送り先は Anthropic（翻訳）と Google（音声）だけです。',
      '共用のパソコンでは保存しないでください。'),
    keySection({
      id: 'claude-key', title: 'Claudeの鍵（翻訳用）', field: 'claudeKey', placeholder: 'sk-ant-…',
      check: async (key) => {
        try { await createClaudeTranslator(key).check(); }
        catch (err) { err.userMessage = describeClaudeError(err); throw err; }
      },
      help: '未設定のときは、見本データの動画だけ再生できます。鍵の取り方は README の「Claudeの鍵の取り方」を見てください。',
    }),
    keySection({
      id: 'google-key', title: 'Googleの鍵（音声用）', field: 'googleKey', placeholder: 'AIza…',
      check: async (key) => {
        try { await createGoogleTts(key).listVoices(); }
        catch (err) { err.userMessage = describeGoogleError(err); throw err; }
      },
      help: '未設定のときは、翻訳した文をブラウザの読み上げ機能で読みます。鍵の取り方は README の「Googleの鍵の取り方」を見てください。',
    }),
    h('section', { class: 'card' },
      h('h2', {}, '日本語の声'),
      h('label', { for: 'voice-select' }, '変換に使う声（Chirp 3 HD）'),
      h('div', { class: 'row' }, voiceSel),
      h('div', { class: 'row gap' },
        h('button', { type: 'button', onclick: loadVoices }, '声の一覧を読み込む'),
        h('button', { type: 'button', onclick: preview }, 'この声を試聴'),
      ),
      voiceStatus,
      h('p', { class: 'note' }, `初期設定は ${DEFAULT_VOICE} です。声を変えても、変換済みの動画の声は変わりません（変換し直すと新しい声になります）。`),
    ),
  ));
}
