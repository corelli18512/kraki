# Voice input: privacy policy text and App Store labels

Kraki's privacy policy lives outside this repository. This file holds the
text to paste for voice input, so the policy matches what the apps do
(`docs/security.md` → "Voice input" is the technical reference). Keep the two
in sync when voice input changes.

Providers are described by category, not by name. Neither the App Store
(guideline 5.1.1, privacy labels), GDPR (Art. 13: "recipients or categories of
recipients") nor China's PIPL (entrusted processing) requires naming them, as
long as the categories, purposes and data are stated.

## Privacy policy — English

> **Voice input.** Your conversations with your computers are end-to-end
> encrypted. Voice input is the exception: when you dictate, your recording is
> sent through Kraki's voice service to a third-party speech recognition
> provider, which turns it into text. If "Correct Transcripts" is on (the
> default), the resulting text, your Custom Words, and limited conversation
> context — the conversation's title, the agent and model, and names or terms
> taken from recent messages (never whole messages, and never anything that
> looks like a key, token, password, URL or file path) — are sent to a
> third-party AI service that corrects recognition mistakes. These providers
> process the data only to return the transcript to you. Kraki records how many
> seconds of voice input each account uses per day, to enforce usage limits.
> You can turn off correction and conversation context in Settings → Voice
> Input, or not use voice input at all. The app explains this before your first
> recording.

## 隐私政策 — 中文

> **语音输入。** 你与电脑之间的对话是端到端加密的，语音输入是例外：当你使用
> 语音输入时，录音会经由 Kraki 的语音服务发送给第三方语音识别服务商，转写为
> 文字。如果开启了"校正转写"（默认开启），转写文本、你的自定义词汇，以及有限
> 的会话上下文——会话标题、所用的 agent 和模型、从最近消息中提取的名称或术语
> （绝不包括完整消息，也不包括任何看起来像密钥、令牌、密码、网址或文件路径的
> 内容）——会发送给第三方 AI 服务，用于纠正识别错误。上述服务商仅为向你返回转
> 写结果而处理这些数据。Kraki 会记录每个账号每天使用语音输入的秒数，用于用量
> 限制。你可以在"设置 → 语音输入"中关闭校正和会话上下文，也可以不使用语音输入。
> App 会在你第一次录音前说明这些。

## App Store privacy labels (iOS and Mac)

Add, or confirm, these entries under **Data Linked to You**:

| Data type | Purpose | Notes |
|---|---|---|
| Audio Data | App Functionality | Dictation recordings, sent to the speech recognition provider |
| Other User Content | App Functionality | Transcript, Custom Words and conversation context sent for correction |
| Product Interaction → (usage) | App Functionality | Daily voice seconds per account, for usage limits |

Not used for tracking. Linked to the user because voice use is authorized per
account.

## Purpose strings

The iOS and Mac `NSMicrophoneUsageDescription` already say recordings go to a
cloud speech service ("Kraki records your voice while you dictate and sends it
to its cloud speech service to turn it into text."). No change needed.
