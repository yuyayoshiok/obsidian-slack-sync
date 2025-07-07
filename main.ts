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

    // Add user display names to messages
    newMessages.forEach((msg: any) => {
      if (msg.user) {
        msg.userDisplayName = userInfoMap.get(msg.user) || msg.user;
      }
    });

    // Update last sync timestamp to the newest message
    const newestTimestamp = Math.max(...newMessages.map((msg: any) => parseFloat(msg.ts))).toString();
    this.settings.lastSyncTimestamps[channelName] = newestTimestamp;
    await this.saveSettings();

    // Generate AI summary first to get the title and tags
    let aiSummary = '';
    let documentTitle = `${this.getDateString()}_slack_${channelName}`;
    let extractedTags: string[] = [];
    
    if (this.settings.enableAISummary) {
      console.log('AI Summary is enabled, generating summary...');
      try {
        aiSummary = await this.generateAISummary(channelName, newMessages);
        console.log('AI Summary result:', aiSummary);
        
        if (aiSummary && aiSummary.trim().length > 0) {
          console.log('AI Summary generated successfully');
          
          // Extract title from AI summary (improved extraction)
          const titleMatch = aiSummary.match(/## (.+?)(?:\n|$)/);
          console.log('Title match result:', titleMatch);
          
          if (titleMatch) {
            let rawTitle = titleMatch[1].trim();
            console.log('Raw title extracted:', rawTitle);
            
            // Remove common unwanted words like "タイトル", "title", etc.
            rawTitle = rawTitle
              .replace(/^(タイトル|title)[:：\s]*/, '') // Remove "タイトル:" or "title:" prefix
              .replace(/(タイトル|title)$/, '') // Remove "タイトル" or "title" suffix
              .trim();
            
            console.log('Title after cleaning:', rawTitle);
            
            // Clean title for filename
            const cleanTitle = rawTitle
              .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename characters
              .replace(/\s+/g, '_') // Replace spaces with underscores
              .substring(0, 50); // Limit length
            
            console.log('Clean title for filename:', cleanTitle);
            
            if (cleanTitle.length > 0 && cleanTitle !== 'タイトル' && cleanTitle !== 'title') {
              documentTitle = `${this.getDateString()}_${cleanTitle}`;
              console.log('Final document title:', documentTitle);
            } else {
              console.log('Title was empty or invalid after cleaning, using default');
            }
          } else {
            console.log('No title found in AI summary, using default');
          }
          
          // Extract tags from AI summary (improved extraction)
          console.log('AI Summary for tag extraction:', aiSummary);
          
          // Try multiple patterns to extract tags
          const tagPatterns = [
            /tags:\s*\n((?:\s*-\s*[^\n]+\n?)+)/i,  // YAML tags format
            /#([\w一-龯ひらがなカタカナ・]+)/g,      // Hashtag format
            /(?:タグ|tag)[:：]\s*([^\n]+)/i,        // Tag: format
            /(?:関連|related)[:：]\s*([^\n]+)/i     // Related: format
          ];
          
          for (const pattern of tagPatterns) {
            const matches = aiSummary.match(pattern);
            if (matches) {
              if (pattern.source.includes('tags:')) {
                // Extract from YAML format
                const yamlTags = matches[1].match(/- ([^\n]+)/g);
                if (yamlTags) {
                  extractedTags = yamlTags.map(tag => tag.replace('- ', '').trim());
                  console.log('Tags extracted from YAML:', extractedTags);
                  break;
                }
              } else if (pattern.global) {
                // Extract hashtags
                extractedTags = Array.from(aiSummary.matchAll(pattern)).map(match => match[1]);
                console.log('Tags extracted from hashtags:', extractedTags);
                break;
                             } else {
                 // Extract from other formats (including "タグ: tag1, tag2, tag3")
                 extractedTags = matches[1].split(/[,、\s]+/).filter(tag => tag.trim().length > 0);
                 console.log('Tags extracted from other format:', extractedTags);
                 break;
               }
            }
          }
          
          if (extractedTags.length === 0) {
            console.log('No tags found in AI summary');
          }
        } else {
          console.log('AI Summary was empty, generating fallback title');
          // Generate fallback title from message content
          const fallbackTitle = this.generateFallbackTitle(newMessages);
          if (fallbackTitle) {
            documentTitle = `${this.getDateString()}_${fallbackTitle}`;
            console.log('Using fallback title:', documentTitle);
          }
        }
      } catch (error) {
        console.error('Failed to generate AI summary:', error);
        new Notice(`AI Summary failed: ${error.message}`);
        
        // Generate fallback title from message content
        const fallbackTitle = this.generateFallbackTitle(newMessages);
        if (fallbackTitle) {
          documentTitle = `${this.getDateString()}_${fallbackTitle}`;
          console.log('Using fallback title after AI error:', documentTitle);
        }
      }
    } else {
      console.log('AI Summary is disabled in settings');
      
      // Generate fallback title from message content when AI is disabled
      const fallbackTitle = this.generateFallbackTitle(newMessages);
      if (fallbackTitle) {
        documentTitle = `${this.getDateString()}_${fallbackTitle}`;
        console.log('Using fallback title (AI disabled):', documentTitle);
      }
    }

    const fileName = `${documentTitle}.md`;
    const filePath = `${this.settings.outputFolder}/${fileName}`;

    let markdown = this.generateMarkdown(channelName, newMessages, aiSummary, extractedTags);

    // Check if file exists and append if it does
    const fileExists = await this.app.vault.adapter.exists(filePath);
    if (fileExists) {
      const existingContent = await this.app.vault.adapter.read(filePath);
      const newMessagesMarkdown = this.generateMessagesMarkdown(newMessages);
      let updatedContent = existingContent + '\n' + newMessagesMarkdown;
      
      // Add AI summary for new messages if enabled
      if (this.settings.enableAISummary && aiSummary) {
        updatedContent = existingContent + '\n\n' + aiSummary + '\n\n---\n\n' + newMessagesMarkdown;
      } else {
        updatedContent = existingContent + '\n\n---\n\n' + newMessagesMarkdown;
      }
      
      await this.app.vault.adapter.write(filePath, updatedContent);
    } else {
      await this.app.vault.create(filePath, markdown);
    }
  }

  generateMarkdown(channelName: string, messages: any[], aiSummary: string = '', extractedTags: string[] = []): string {
    const now = new Date();
    const dateString = now.toISOString().split('T')[0];
    
    // Only use AI extracted tags, no default tags
    const uniqueTags = extractedTags.length > 0 ? [...new Set(extractedTags)] : [];
    
    let markdown = `---
created: ${dateString}
updated: ${now.toISOString()}`;
    
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