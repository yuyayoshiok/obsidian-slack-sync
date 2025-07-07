import { App, Plugin, PluginSettingTab, Setting, Notice, requestUrl } from 'obsidian';

interface SlackSyncSettings {
  slackToken: string;
  channels: string[];
  syncInterval: number;
  outputFolder: string;
  lastSyncTimestamps: { [channel: string]: string };
  enableAISummary: boolean;
  aiProvider: 'openai' | 'anthropic' | 'gemini';
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  autoSync: boolean;
}

const DEFAULT_SETTINGS: SlackSyncSettings = {
  slackToken: '',
  channels: ['general', 'random'],
  syncInterval: 24, // hours
  outputFolder: 'Slack',
  lastSyncTimestamps: {},
  enableAISummary: false,
  aiProvider: 'openai',
  openaiApiKey: '',
  anthropicApiKey: '',
  geminiApiKey: '',
  autoSync: false
};

export default class SlackSyncPlugin extends Plugin {
  settings: SlackSyncSettings;
  syncInterval: number | null = null;

  async onload() {
    await this.loadSettings();

    // Add ribbon icon
    this.addRibbonIcon('sync', 'Sync Slack messages', (evt: MouseEvent) => {
      this.syncSlackMessages();
    });

    // Add command
    this.addCommand({
      id: 'sync-slack-messages',
      name: 'Sync Slack messages',
      callback: () => {
        this.syncSlackMessages();
      }
    });

    // Add settings tab
    this.addSettingTab(new SlackSyncSettingTab(this.app, this));

    // Start auto sync if enabled
    this.startAutoSync();
  }

  onunload() {
    this.stopAutoSync();
  }

  startAutoSync() {
    if (this.settings.autoSync && this.settings.syncInterval > 0) {
      this.stopAutoSync(); // Clear existing interval
      this.syncInterval = window.setInterval(() => {
        this.syncSlackMessages();
      }, this.settings.syncInterval * 60 * 60 * 1000); // Convert hours to milliseconds
      
      new Notice(`Auto sync enabled: every ${this.settings.syncInterval} hours`);
    }
  }

  stopAutoSync() {
    if (this.syncInterval) {
      window.clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Restart auto sync when settings change
    this.startAutoSync();
  }

  async syncSlackMessages() {
    if (!this.settings.slackToken) {
      new Notice('Please set your Slack token in settings');
      return;
    }

    new Notice('Starting Slack sync...');

    try {
      for (const channel of this.settings.channels) {
        await this.syncChannel(channel);
      }
      new Notice('Slack sync completed successfully!');
    } catch (error) {
      new Notice('Error during Slack sync: ' + error.message);
      console.error('Slack sync error:', error);
    }
  }

  async syncChannel(channelName: string) {
    // Get last sync timestamp for this channel
    const lastSyncTimestamp = this.settings.lastSyncTimestamps[channelName] || '0';
    
    const url = `https://slack.com/api/conversations.history?channel=${channelName}&limit=50&oldest=${lastSyncTimestamp}`;
    
    const response = await requestUrl({
      url: url,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.settings.slackToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.json.ok) {
      throw new Error(`Failed to fetch messages from ${channelName}: ${response.json.error}`);
    }

    const messages = response.json.messages || [];
    if (messages.length === 0) {
      return;
    }

    // Filter out messages that are exactly at the last sync timestamp
    const newMessages = messages.filter((msg: any) => msg.ts > lastSyncTimestamp);
    if (newMessages.length === 0) {
      return;
    }

    // Get workspace info for URL generation
    let workspaceUrl = '';
    try {
      const teamResponse = await requestUrl({
        url: 'https://slack.com/api/team.info',
        headers: {
          'Authorization': `Bearer ${this.settings.slackToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Team info response:', teamResponse.json);
      if (teamResponse.json.ok) {
        workspaceUrl = `https://${teamResponse.json.team.domain}.slack.com`;
        console.log('Workspace URL generated:', workspaceUrl);
      } else {
        console.error('Team info API error:', teamResponse.json.error);
      }
    } catch (error) {
      console.error('Failed to get workspace info:', error);
    }

    // Get user information for all users in the messages
    const userIds = [...new Set(newMessages.map((msg: any) => msg.user).filter(Boolean))];
    const userInfoMap = new Map();
    
    for (const userId of userIds) {
      try {
        const userResponse = await requestUrl({
          url: `https://slack.com/api/users.info?user=${userId}`,
          headers: {
            'Authorization': `Bearer ${this.settings.slackToken}`,
            'Content-Type': 'application/json'
          }
        });
        
        const userData = userResponse.json;
        if (userData.ok) {
          // Use display name, real name, or username in that order
          const displayName = userData.user.profile?.display_name || 
                             userData.user.profile?.real_name || 
                             userData.user.name || 
                             userId;
          userInfoMap.set(userId, displayName);
        } else {
          userInfoMap.set(userId, userId);
        }
      } catch (error) {
        console.error(`Failed to get user info for ${userId}:`, error);
        userInfoMap.set(userId, userId);
      }
    }

    // Add user display names and URLs to messages
    newMessages.forEach((msg: any) => {
      if (msg.user) {
        msg.userDisplayName = userInfoMap.get(msg.user) || msg.user;
      }
      // Generate Slack permalink URL
      if (workspaceUrl && msg.ts) {
        msg.slackUrl = `${workspaceUrl}/archives/${channelName}/p${msg.ts.replace('.', '')}`;
      }
    });

    // Update last sync timestamp to the newest message
    const newestTimestamp = Math.max(...newMessages.map((msg: any) => parseFloat(msg.ts))).toString();
    this.settings.lastSyncTimestamps[channelName] = newestTimestamp;
    await this.saveSettings();

    // Process each message individually
    for (const message of newMessages) {
      await this.createMessageFile(message, channelName, workspaceUrl);
    }
  }

  async createMessageFile(message: any, channelName: string, workspaceUrl: string) {
    const timestamp = new Date(parseFloat(message.ts) * 1000);
    const userName = message.userDisplayName || message.user || 'Unknown';
    
    // Fetch thread replies if this message has replies
    let threadMessages = [message];
    if (message.reply_count && message.reply_count > 0) {
      try {
        const threadResponse = await requestUrl({
          url: `https://slack.com/api/conversations.replies?channel=${channelName}&ts=${message.ts}`,
          headers: {
            'Authorization': `Bearer ${this.settings.slackToken}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (threadResponse.json.ok && threadResponse.json.messages) {
          threadMessages = threadResponse.json.messages;
          
          // Get user info for thread replies
          const threadUserIds = [...new Set(threadMessages.map((msg: any) => msg.user).filter(Boolean))];
          const threadUserInfoMap = new Map();
          
          for (const userId of threadUserIds) {
            try {
              const userResponse = await requestUrl({
                url: `https://slack.com/api/users.info?user=${userId}`,
                headers: {
                  'Authorization': `Bearer ${this.settings.slackToken}`,
                  'Content-Type': 'application/json'
                }
              });
              
              const userData = userResponse.json;
              if (userData.ok) {
                const displayName = userData.user.profile?.display_name || 
                                 userData.user.profile?.real_name || 
                                 userData.user.name || 
                                 userId;
                threadUserInfoMap.set(userId, displayName);
              } else {
                threadUserInfoMap.set(userId, userId);
              }
            } catch (error) {
              console.error(`Failed to get user info for ${userId}:`, error);
              threadUserInfoMap.set(userId, userId);
            }
          }
          
          // Add user display names and URLs to thread messages
          threadMessages.forEach((msg: any) => {
            if (msg.user) {
              msg.userDisplayName = threadUserInfoMap.get(msg.user) || msg.user;
            }
            if (workspaceUrl && msg.ts) {
              msg.slackUrl = `${workspaceUrl}/archives/${channelName}/p${msg.ts.replace('.', '')}`;
            }
          });
        }
      } catch (error) {
        console.error('Failed to fetch thread replies:', error);
      }
    }

    // Generate AI summary for the message (and thread if exists)
    let aiSummary = '';
    let documentTitle = '';
    let extractedTags: string[] = [];
    
    if (this.settings.enableAISummary) {
      try {
        aiSummary = await this.generateAISummary(channelName, threadMessages);
        
        if (aiSummary && aiSummary.trim().length > 0) {
          // Extract title from AI summary
          const titleMatch = aiSummary.match(/## (.+?)(?:\n|$)/);
          
          if (titleMatch) {
            let rawTitle = titleMatch[1].trim();
            rawTitle = rawTitle
              .replace(/^(タイトル|title)[:：\s]*/, '')
              .replace(/(タイトル|title)$/, '')
              .trim();
            
            const cleanTitle = rawTitle
              .replace(/[<>:"/\\|?*]/g, '')
              .replace(/\s+/g, '_')
              .substring(0, 50);
            
            if (cleanTitle.length > 0 && cleanTitle !== 'タイトル' && cleanTitle !== 'title') {
              documentTitle = cleanTitle;
            }
          }
          
          // Extract tags from AI summary
          const tagPatterns = [
            /tags:\s*\n((?:\s*-\s*[^\n]+\n?)+)/i,
            /#([\w一-龯ひらがなカタカナ・]+)/g,
            /(?:タグ|tag)[:：]\s*([^\n]+)/i,
            /(?:関連|related)[:：]\s*([^\n]+)/i
          ];
          
          for (const pattern of tagPatterns) {
            const matches = aiSummary.match(pattern);
            if (matches) {
              if (pattern.source.includes('tags:')) {
                const yamlTags = matches[1].match(/- ([^\n]+)/g);
                if (yamlTags) {
                  extractedTags = yamlTags.map(tag => tag.replace('- ', '').trim());
                  break;
                }
              } else if (pattern.global) {
                extractedTags = Array.from(aiSummary.matchAll(pattern)).map(match => match[1]);
                break;
              } else {
                extractedTags = matches[1].split(/[,、\s]+/).filter(tag => tag.trim().length > 0);
                break;
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to generate AI summary:', error);
      }
    }

    // Add date prefix to title
    const dateString = timestamp.toISOString().split('T')[0].replace(/-/g, '');
    if (!documentTitle) {
      const fallbackTitle = this.generateFallbackTitle(threadMessages);
      documentTitle = fallbackTitle || `${userName}_${timestamp.getHours()}${timestamp.getMinutes()}`;
    }

    const fileName = `${dateString}_${documentTitle}.md`;
    const filePath = `${this.settings.outputFolder}/${fileName}`;

    const markdown = this.generateSingleMessageMarkdown(threadMessages, aiSummary, extractedTags, workspaceUrl, channelName);

    // Create the file (overwrite if exists for individual messages)
    await this.app.vault.adapter.write(filePath, markdown);
  }

  generateMarkdown(channelName: string, messages: any[], aiSummary: string = '', extractedTags: string[] = [], workspaceUrl: string = ''): string {
    const now = new Date();
    const dateString = now.toISOString().split('T')[0];
    
    // Only use AI extracted tags, no default tags
    const uniqueTags = extractedTags.length > 0 ? [...new Set(extractedTags)] : [];
    
    let markdown = `---
created: ${dateString}
updated: ${now.toISOString()}`;
    
    // Add Slack URL if available
    if (workspaceUrl && channelName) {
      markdown += `\nslack_url: ${workspaceUrl}/channels/${channelName}`;
    }
    
    // Add tags only if there are any
    if (uniqueTags.length > 0) {
      markdown += `\ntags:`;
      uniqueTags.forEach(tag => {
        markdown += `\n  - ${tag}`;
      });
    }
    
    markdown += `
---

`;

    // Add AI summary if available
    if (aiSummary) {
      markdown += aiSummary + '\n\n';
      // Add separator line before Slack messages
      markdown += '---\n\n';
    }

    markdown += this.generateMessagesMarkdown(messages);
    return markdown;
  }

  generateSingleMessageMarkdown(messages: any[], aiSummary: string = '', extractedTags: string[] = [], workspaceUrl: string = '', channelName: string = ''): string {
    const now = new Date();
    const dateString = now.toISOString().split('T')[0];
    
    // Only use AI extracted tags, no default tags
    const uniqueTags = extractedTags.length > 0 ? [...new Set(extractedTags)] : [];
    
    let markdown = `---
created: ${dateString}
updated: ${now.toISOString()}`;
    
    // Add Slack URL if available (link to the main message)
    if (workspaceUrl && channelName && messages.length > 0) {
      const mainMessage = messages[0];
      if (mainMessage.ts) {
        const slackUrl = `${workspaceUrl}/archives/${channelName}/p${mainMessage.ts.replace('.', '')}`;
        console.log('Adding Slack URL to front-matter:', slackUrl);
        markdown += `\nslack_url: ${slackUrl}`;
      }
    } else {
      console.log('Slack URL not added:', { workspaceUrl, channelName, messagesLength: messages.length });
    }
    
    // Add tags only if there are any
    if (uniqueTags.length > 0) {
      markdown += `\ntags:`;
      uniqueTags.forEach(tag => {
        markdown += `\n  - ${tag}`;
      });
    }
    
    markdown += `
---

`;

    // Add AI summary if available
    if (aiSummary) {
      markdown += aiSummary + '\n\n';
      // Add separator line before Slack messages
      markdown += '---\n\n';
    }

    // Add messages (main message + thread replies)
    messages.forEach((message, index) => {
      const timestamp = new Date(parseFloat(message.ts) * 1000);
      const timeString = timestamp.toLocaleTimeString('ja-JP', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      const userName = message.userDisplayName || message.user || 'Unknown';
      
      if (index === 0) {
        // Main message
        markdown += `## ${timeString} - ${userName}\n\n`;
      } else {
        // Thread reply
        markdown += `### 　└ ${timeString} - ${userName}\n\n`;
      }
      
      markdown += `${message.text || ''}\n\n`;
    });
    
    return markdown;
  }

  generateMessagesMarkdown(messages: any[]): string {
    let markdown = '';
    messages.reverse().forEach((message) => {
      const timestamp = new Date(parseFloat(message.ts) * 1000);
      const timeString = timestamp.toLocaleTimeString('ja-JP', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      const userName = message.userDisplayName || message.user || 'Unknown';
      markdown += `## ${timeString} - ${userName}\n\n`;
      markdown += `${message.text || ''}\n\n`;
    });
    return markdown;
  }

  async generateAISummary(channelName: string, messages: any[]): Promise<string> {
    if (!this.settings.enableAISummary) {
      console.log('AI Summary is disabled');
      return '';
    }

    console.log(`Generating AI summary for ${channelName} with ${messages.length} messages`);

    const messagesText = messages.map(msg => {
      const timestamp = new Date(parseFloat(msg.ts) * 1000);
      const timeString = timestamp.toLocaleTimeString('ja-JP', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      const userName = msg.userDisplayName || msg.user || 'Unknown';
      return `${timeString} - ${userName}: ${msg.text || ''}`;
    }).join('\n');

    const prompt = `以下のSlackメッセージを分析して、template.mdの厳密な形式で要約してください：

チャンネル: #${channelName}
メッセージ:
${messagesText}

【重要】以下の形式を厳密に守って出力してください：

## タイトル
（25字以内・句点なし・内容を表す具体的な名詞句で要約）

（メッセージの要約内容を箇条書き：）
- 重要なポイント1
- 重要なポイント2  
- 重要なポイント3

## 追加リンク一覧
（メッセージ内容から関連しそうなトピックを3-5個提案）
例：
- [[健康管理]] … 体調、改善、散歩に関連
- [[業務管理]] … 勤務、稼働、予定に関連
- [[技術開発]] … 開発、プログラミング、システムに関連

【タグ指針（front-matterのtagsプロパティ用、ハッシュタグは出力しない）】
エンジニアリング: VBA, GAS, Python, 自動化ツール, Power_Automate
技術学習: G検定, AWS, BigQuery, Looker_Studio  
業務・仕事: 午前勤務, 午後勤務, 業務効率化, 社内ツール開発
健康・生活: ウォーキング, 読書, 睡眠改善, 体重管理
成長・復調: 吃音克服, デスクワーク, スキルアップ, 転職
心理・メンタル: 不眠症, 自信回復, 振り返り, 気づき
プロダクト: 献立ツール, 在庫管理, 営業事務管理, シフト表
状態: 要対応, 高優先度, 進行中, 完了

【出力ルール】
- 要約は「〜だ」みたいな感じの文語調で記述する
- ハッシュタグは一切出力しない（タグはfront-matterで管理される）
- 追加リンクは[[ワード]]形式で、メッセージ内容に関連するトピックを提案する

【タイトル例】
- 「朝のウォーキングルート検討」
- 「Python自動化スクリプト開発」
- 「読書記録と感想共有」
- 「業務効率化ツール導入検討」

必ず上記の形式通りに出力してください。`;

    try {
      console.log(`Using AI provider: ${this.settings.aiProvider}`);
      let result = '';
      switch (this.settings.aiProvider) {
        case 'openai':
          result = await this.callOpenAI(prompt);
          break;
        case 'anthropic':
          result = await this.callAnthropic(prompt);
          break;
        case 'gemini':
          result = await this.callGemini(prompt);
          break;
        default:
          console.log('Unknown AI provider');
          return '';
      }
      console.log('AI Summary generated successfully');
      return result;
    } catch (error) {
      console.error('AI Summary error:', error);
      new Notice(`AI Summary failed: ${error.message}`);
      return '';
    }
  }

  async callOpenAI(prompt: string): Promise<string> {
    if (!this.settings.openaiApiKey) {
      throw new Error('OpenAI API key not set');
    }

    const response = await requestUrl({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.settings.openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'あなたは日本語でSlackメッセージを要約する専門家です。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    if (response.status !== 200) {
      throw new Error(`OpenAI API error: ${response.status} - ${response.json.error?.message || 'Unknown error'}`);
    }

    if (!response.json.choices || response.json.choices.length === 0) {
      throw new Error('No response from OpenAI');
    }

    return response.json.choices[0].message.content;
  }

  async callAnthropic(prompt: string): Promise<string> {
    if (!this.settings.anthropicApiKey) {
      throw new Error('Anthropic API key not set');
    }

    const response = await requestUrl({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': this.settings.anthropicApiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1000,
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    if (response.status !== 200) {
      throw new Error(`Anthropic API error: ${response.status} - ${response.json.error?.message || 'Unknown error'}`);
    }

    if (!response.json.content || response.json.content.length === 0) {
      throw new Error('No response from Anthropic');
    }

    return response.json.content[0].text;
  }

  async callGemini(prompt: string): Promise<string> {
    if (!this.settings.geminiApiKey) {
      throw new Error('Gemini API key not set');
    }

    const response = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${this.settings.geminiApiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt }
            ]
          }
        ]
      })
    });

    if (response.status !== 200) {
      throw new Error(`Gemini API error: ${response.status} - ${response.json.error?.message || 'Unknown error'}`);
    }

    if (!response.json.candidates || response.json.candidates.length === 0) {
      throw new Error('No response from Gemini');
    }

    return response.json.candidates[0].content.parts[0].text;
  }



  generateFallbackTitle(messages: any[]): string {
    if (!messages || messages.length === 0) {
      return '';
    }
    
    // Extract keywords from messages for title generation
    const allText = messages.map(msg => msg.text || '').join(' ');
    const words = allText
      .replace(/[^\w\s一-龯ひらがなカタカナ]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 1)
      .filter(word => !['です', 'ます', 'した', 'する', 'である', 'だった', 'なる', 'ある', 'いる', 'こと', 'もの', 'ため', 'ので', 'けど', 'でも', 'しかし', 'そして', 'また', 'さらに', 'それ', 'これ', 'あれ', 'どれ', 'その', 'この', 'あの', 'どの', 'から', 'まで', 'より'].includes(word));
    
    // Take first few meaningful words for title
    const titleWords = words.slice(0, 3);
    if (titleWords.length > 0) {
      return titleWords.join('_').substring(0, 30);
    }
    
    return '';
  }

  getDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0].replace(/-/g, '');
  }
}

class SlackSyncSettingTab extends PluginSettingTab {
  plugin: SlackSyncPlugin;

  constructor(app: App, plugin: SlackSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Slack Sync Settings' });

    new Setting(containerEl)
      .setName('Slack Bot Token')
      .setDesc('Your Slack Bot User OAuth Token (starts with xoxb-)')
      .addText(text => text
        .setPlaceholder('xoxb-your-token-here')
        .setValue(this.plugin.settings.slackToken)
        .onChange(async (value) => {
          this.plugin.settings.slackToken = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Channels')
      .setDesc('Comma-separated list of channel names to sync')
      .addText(text => text
        .setPlaceholder('general,random,dev-team')
        .setValue(this.plugin.settings.channels.join(','))
        .onChange(async (value) => {
          this.plugin.settings.channels = value.split(',').map(s => s.trim());
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Output Folder')
      .setDesc('Folder where synced messages will be saved')
      .addText(text => text
        .setPlaceholder('Slack')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'AI Summary Settings' });

    new Setting(containerEl)
      .setName('Enable AI Summary')
      .setDesc('Generate AI-powered summaries of Slack messages')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAISummary)
        .onChange(async (value) => {
          this.plugin.settings.enableAISummary = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('AI Provider')
      .setDesc('Choose your preferred AI service')
      .addDropdown(dropdown => dropdown
        .addOption('openai', 'OpenAI (GPT-4o-mini)')
        .addOption('anthropic', 'Anthropic (Claude 3.5 Haiku)')
        .addOption('gemini', 'Google Gemini (2.5 Flash)')
        .setValue(this.plugin.settings.aiProvider)
        .onChange(async (value: 'openai' | 'anthropic' | 'gemini') => {
          this.plugin.settings.aiProvider = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('OpenAI API Key')
      .setDesc('Your OpenAI API key (starts with sk-)')
      .addText(text => text
        .setPlaceholder('sk-your-openai-key-here')
        .setValue(this.plugin.settings.openaiApiKey)
        .onChange(async (value) => {
          this.plugin.settings.openaiApiKey = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Anthropic API Key')
      .setDesc('Your Anthropic API key (starts with sk-ant-)')
      .addText(text => text
        .setPlaceholder('sk-ant-your-anthropic-key-here')
        .setValue(this.plugin.settings.anthropicApiKey)
        .onChange(async (value) => {
          this.plugin.settings.anthropicApiKey = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Your Google Gemini API key')
      .addText(text => text
        .setPlaceholder('your-gemini-key-here')
        .setValue(this.plugin.settings.geminiApiKey)
        .onChange(async (value) => {
          this.plugin.settings.geminiApiKey = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Auto Sync Settings' });

    new Setting(containerEl)
      .setName('Enable Auto Sync')
      .setDesc('Automatically sync messages at regular intervals')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync Interval (hours)')
      .setDesc('How often to automatically sync messages')
      .addSlider(slider => slider
        .setLimits(1, 24, 1)
        .setValue(this.plugin.settings.syncInterval)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.syncInterval = value;
          await this.plugin.saveSettings();
        }));
  }
} 