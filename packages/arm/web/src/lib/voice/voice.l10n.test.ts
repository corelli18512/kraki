import { afterEach, describe, expect, it } from 'vitest';
import { i18next } from '../../i18n';
import { consentMessage, consentTitle, editWords, startDictation, transcriptPieces, useVoice } from './voice';

const text = (phase: 'connecting' | 'recording' | 'finishing', rawText = '') => transcriptPieces({ phase, rawText, correctionText: '' })[0].text;

afterEach(async () => { await i18next.changeLanguage('en'); });

describe('voice localization', () => {
  it('evaluates consent, status and validation copy at call time while leaving transcripts untouched', async () => {
    expect(consentTitle()).toBe('Voice input uses cloud services');
    expect(text('recording')).toBe('Listening…');
    await i18next.changeLanguage('zh-Hans');
    expect(consentTitle()).toBe('语音输入使用云服务');
    expect(consentMessage()).toContain('端到端加密聊天');
    expect(text('connecting')).toBe('正在连接…');
    expect(text('recording')).toBe('正在聆听…');
    expect(text('finishing')).toBe('正在修正…');
    expect(text('recording', 'User transcript')).toBe('User transcript');
    expect(editWords([{ op: 'add', term: '#invalid' }])).toBe('词汇不能包含“=”、以“#”开头或超过 120 个字符。');
  });

  it('localizes preflight errors without changing the failed state', async () => {
    await i18next.changeLanguage('zh-Hans');
    useVoice.setState({ capability: null });
    await startDictation('new', { fields: {}, vocabulary: [] }, () => {});
    expect(useVoice.getState()).toMatchObject({ phase: 'failed', owner: 'new', error: '此地区暂不支持语音输入。' });
  });
});
