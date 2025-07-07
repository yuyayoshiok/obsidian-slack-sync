# Obsidian Slack Sync v2.0

Slack のメッセージを Obsidian に自動同期し、AI要約機能付きのプラグインです。

## 🚀 機能

### 基本機能
- ✅ Slack チャンネルのメッセージを Markdown 形式で取得
- ✅ 重複メッセージの自動回避（差分同期）
- ✅ 設定画面で簡単にチャンネル設定
- ✅ 日本語対応
- ✅ カスタマイズ可能な出力フォルダ

### 🤖 AI要約機能
- ✅ **OpenAI (GPT-4o-mini)** 対応
- ✅ **Anthropic (Claude 3.5 Haiku)** 対応  
- ✅ **Google Gemini (2.0 Flash)** 対応
- ✅ template.md形式での構造化要約
- ✅ タイトル生成・タグ付け・内部リンク提案

### ⏰ 自動実行機能
- ✅ 1-24時間間隔での自動同期
- ✅ バックグラウンド実行
- ✅ 設定変更時の自動再開

## 📦 インストール方法

### 開発版（手動インストール）

1. このリポジトリをクローン
```bash
git clone https://github.com/yuyayoshiok/obsidian-slack-sync.git
```

2. 依存関係をインストール
```bash
npm install
```

3. プラグインをビルド
```bash
node esbuild.config.mjs
```

4. Obsidian のプラグインフォルダにコピー
```bash
mkdir -p ~/.obsidian/plugins/obsidian-slack-sync/
cp main.js manifest.json ~/.obsidian/plugins/obsidian-slack-sync/
```

## ⚙️ 設定

### Slack設定
1. Slack App を作成して Bot Token を取得
2. 必要なスコープを設定：
   - `channels:history`
   - `channels:read`
   - `users:read`
3. Obsidian の設定でトークンとチャンネルを設定

### AI要約設定（オプション）
1. **OpenAI**: [OpenAI API](https://platform.openai.com/api-keys) でAPIキーを取得
2. **Anthropic**: [Anthropic Console](https://console.anthropic.com/) でAPIキーを取得
3. **Gemini**: [Google AI Studio](https://makersuite.google.com/app/apikey) でAPIキーを取得
4. プラグイン設定で希望するAIプロバイダーを選択してAPIキーを設定

### 自動同期設定（オプション）
1. 「Enable Auto Sync」をオンにする
2. 同期間隔を設定（1-24時間）
3. 自動的にバックグラウンドで実行開始

## 🔧 使い方

1. 左サイドバーの同期アイコンをクリック
2. または コマンドパレット（Ctrl+P）→「Sync Slack messages」

## 📝 出力形式

### 通常の同期
```markdown
---
created: 2025-07-07
updated: 2025-07-07T20:00:00
tags:
  - タグ1
  - タグ2
  - タグ3
---

# Slack - #チャンネル名

## 20:00 - ユーザー名

メッセージ内容...
```

### AI要約付き
```markdown
## タイトル
Slackメッセージの要約タイトル

- 重要なポイント1
- 重要なポイント2
- 重要なポイント3

---
## 追加リンク一覧
- [[関連ノート]] … 関連理由

---

# Slack - #チャンネル名

## 20:00 - ユーザー名

メッセージ内容...
```