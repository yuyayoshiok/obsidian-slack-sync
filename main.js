var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SlackSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  slackToken: "",
  channels: ["general", "random"],
  syncInterval: 24,
  // hours
  outputFolder: "Slack",
  lastSyncTimestamps: {},
  enableAISummary: false,
  aiProvider: "openai",
  openaiApiKey: "",
  anthropicApiKey: "",
  geminiApiKey: "",
  autoSync: false
};
var SlackSyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.syncInterval = null;
  }
  async onload() {
    await this.loadSettings();
    this.addRibbonIcon("sync", "Sync Slack messages", (evt) => {
      this.syncSlackMessages();
    });
    this.addCommand({
      id: "sync-slack-messages",
      name: "Sync Slack messages",
      callback: () => {
        this.syncSlackMessages();
      }
    });
    this.addSettingTab(new SlackSyncSettingTab(this.app, this));
    this.startAutoSync();
  }
  onunload() {
    this.stopAutoSync();
  }
  startAutoSync() {
    if (this.settings.autoSync && this.settings.syncInterval > 0) {
      this.stopAutoSync();
      this.syncInterval = window.setInterval(() => {
        this.syncSlackMessages();
      }, this.settings.syncInterval * 60 * 60 * 1e3);
      new import_obsidian.Notice(`Auto sync enabled: every ${this.settings.syncInterval} hours`);
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
    this.startAutoSync();
  }
  async syncSlackMessages() {
    if (!this.settings.slackToken) {
      new import_obsidian.Notice("Please set your Slack token in settings");
      return;
    }
    new import_obsidian.Notice("Starting Slack sync...");
    try {
      for (const channel of this.settings.channels) {
        await this.syncChannel(channel);
      }
      new import_obsidian.Notice("Slack sync completed successfully!");
    } catch (error) {
      new import_obsidian.Notice("Error during Slack sync: " + error.message);
      console.error("Slack sync error:", error);
    }
  }
  async syncChannel(channelName) {
    const lastSyncTimestamp = this.settings.lastSyncTimestamps[channelName] || "0";
    const url = `https://slack.com/api/conversations.history?channel=${channelName}&limit=50&oldest=${lastSyncTimestamp}`;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.settings.slackToken}`,
        "Content-Type": "application/json"
      }
    });
    if (!response.json.ok) {
      throw new Error(`Failed to fetch messages from ${channelName}: ${response.json.error}`);
    }
    const messages = response.json.messages || [];
    if (messages.length === 0) {
      return;
    }
    const newMessages = messages.filter((msg) => msg.ts > lastSyncTimestamp);
    if (newMessages.length === 0) {
      return;
    }
    let workspaceUrl = "";
    try {
      const teamResponse = await (0, import_obsidian.requestUrl)({
        url: "https://slack.com/api/team.info",
        headers: {
          "Authorization": `Bearer ${this.settings.slackToken}`,
          "Content-Type": "application/json"
        }
      });
      if (teamResponse.json.ok) {
        workspaceUrl = `https://${teamResponse.json.team.domain}.slack.com`;
      }
    } catch (error) {
      console.error("Failed to get workspace info:", error);
    }
    const userIds = [...new Set(newMessages.map((msg) => msg.user).filter(Boolean))];
    const userInfoMap = /* @__PURE__ */ new Map();
    for (const userId of userIds) {
      try {
        const userResponse = await (0, import_obsidian.requestUrl)({
          url: `https://slack.com/api/users.info?user=${userId}`,
          headers: {
            "Authorization": `Bearer ${this.settings.slackToken}`,
            "Content-Type": "application/json"
          }
        });
        const userData = userResponse.json;
        if (userData.ok) {
          const displayName = userData.user.profile?.display_name || userData.user.profile?.real_name || userData.user.name || userId;
          userInfoMap.set(userId, displayName);
        } else {
          userInfoMap.set(userId, userId);
        }
      } catch (error) {
        console.error(`Failed to get user info for ${userId}:`, error);
        userInfoMap.set(userId, userId);
      }
    }
    newMessages.forEach((msg) => {
      if (msg.user) {
        msg.userDisplayName = userInfoMap.get(msg.user) || msg.user;
      }
      if (workspaceUrl && msg.ts) {
        msg.slackUrl = `${workspaceUrl}/archives/${channelName}/p${msg.ts.replace(".", "")}`;
      }
    });
    const newestTimestamp = Math.max(...newMessages.map((msg) => parseFloat(msg.ts))).toString();
    this.settings.lastSyncTimestamps[channelName] = newestTimestamp;
    await this.saveSettings();
    for (const message of newMessages) {
      await this.createMessageFile(message, channelName, workspaceUrl);
    }
  }
  async createMessageFile(message, channelName, workspaceUrl) {
    const timestamp = new Date(parseFloat(message.ts) * 1e3);
    const userName = message.userDisplayName || message.user || "Unknown";
    let threadMessages = [message];
    if (message.reply_count && message.reply_count > 0) {
      try {
        const threadResponse = await (0, import_obsidian.requestUrl)({
          url: `https://slack.com/api/conversations.replies?channel=${channelName}&ts=${message.ts}`,
          headers: {
            "Authorization": `Bearer ${this.settings.slackToken}`,
            "Content-Type": "application/json"
          }
        });
        if (threadResponse.json.ok && threadResponse.json.messages) {
          threadMessages = threadResponse.json.messages;
          const threadUserIds = [...new Set(threadMessages.map((msg) => msg.user).filter(Boolean))];
          const threadUserInfoMap = /* @__PURE__ */ new Map();
          for (const userId of threadUserIds) {
            try {
              const userResponse = await (0, import_obsidian.requestUrl)({
                url: `https://slack.com/api/users.info?user=${userId}`,
                headers: {
                  "Authorization": `Bearer ${this.settings.slackToken}`,
                  "Content-Type": "application/json"
                }
              });
              const userData = userResponse.json;
              if (userData.ok) {
                const displayName = userData.user.profile?.display_name || userData.user.profile?.real_name || userData.user.name || userId;
                threadUserInfoMap.set(userId, displayName);
              } else {
                threadUserInfoMap.set(userId, userId);
              }
            } catch (error) {
              console.error(`Failed to get user info for ${userId}:`, error);
              threadUserInfoMap.set(userId, userId);
            }
          }
          threadMessages.forEach((msg) => {
            if (msg.user) {
              msg.userDisplayName = threadUserInfoMap.get(msg.user) || msg.user;
            }
            if (workspaceUrl && msg.ts) {
              msg.slackUrl = `${workspaceUrl}/archives/${channelName}/p${msg.ts.replace(".", "")}`;
            }
          });
        }
      } catch (error) {
        console.error("Failed to fetch thread replies:", error);
      }
    }
    let aiSummary = "";
    let documentTitle = "";
    let extractedTags = [];
    if (this.settings.enableAISummary) {
      try {
        aiSummary = await this.generateAISummary(channelName, threadMessages);
        if (aiSummary && aiSummary.trim().length > 0) {
          const titleMatch = aiSummary.match(/## (.+?)(?:\n|$)/);
          if (titleMatch) {
            let rawTitle = titleMatch[1].trim();
            rawTitle = rawTitle.replace(/^(タイトル|title)[:：\s]*/, "").replace(/(タイトル|title)$/, "").trim();
            const cleanTitle = rawTitle.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_").substring(0, 50);
            if (cleanTitle.length > 0 && cleanTitle !== "\u30BF\u30A4\u30C8\u30EB" && cleanTitle !== "title") {
              documentTitle = cleanTitle;
            }
          }
          const tagPatterns = [
            /tags:\s*\n((?:\s*-\s*[^\n]+\n?)+)/i,
            /#([\w一-龯ひらがなカタカナ・]+)/g,
            /(?:タグ|tag)[:：]\s*([^\n]+)/i,
            /(?:関連|related)[:：]\s*([^\n]+)/i
          ];
          for (const pattern of tagPatterns) {
            const matches = aiSummary.match(pattern);
            if (matches) {
              if (pattern.source.includes("tags:")) {
                const yamlTags = matches[1].match(/- ([^\n]+)/g);
                if (yamlTags) {
                  extractedTags = yamlTags.map((tag) => tag.replace("- ", "").trim());
                  break;
                }
              } else if (pattern.global) {
                extractedTags = Array.from(aiSummary.matchAll(pattern)).map((match) => match[1]);
                break;
              } else {
                extractedTags = matches[1].split(/[,、\s]+/).filter((tag) => tag.trim().length > 0);
                break;
              }
            }
          }
        }
      } catch (error) {
        console.error("Failed to generate AI summary:", error);
      }
    }
    if (!documentTitle) {
      const fallbackTitle = this.generateFallbackTitle(threadMessages);
      const dateString = timestamp.toISOString().split("T")[0].replace(/-/g, "");
      documentTitle = fallbackTitle || `${dateString}_${userName}_${timestamp.getHours()}${timestamp.getMinutes()}`;
    }
    const fileName = `${documentTitle}.md`;
    const filePath = `${this.settings.outputFolder}/${fileName}`;
    const markdown = this.generateSingleMessageMarkdown(threadMessages, aiSummary, extractedTags, workspaceUrl, channelName);
    await this.app.vault.adapter.write(filePath, markdown);
  }
  generateMarkdown(channelName, messages, aiSummary = "", extractedTags = [], workspaceUrl = "") {
    const now = /* @__PURE__ */ new Date();
    const dateString = now.toISOString().split("T")[0];
    const uniqueTags = extractedTags.length > 0 ? [...new Set(extractedTags)] : [];
    let markdown = `---
created: ${dateString}
updated: ${now.toISOString()}`;
    if (workspaceUrl && channelName) {
      markdown += `
slack_url: ${workspaceUrl}/channels/${channelName}`;
    }
    if (uniqueTags.length > 0) {
      markdown += `
tags:`;
      uniqueTags.forEach((tag) => {
        markdown += `
  - ${tag}`;
      });
    }
    markdown += `
---

`;
    if (aiSummary) {
      markdown += aiSummary + "\n\n";
      markdown += "---\n\n";
    }
    markdown += this.generateMessagesMarkdown(messages);
    return markdown;
  }
  generateSingleMessageMarkdown(messages, aiSummary = "", extractedTags = [], workspaceUrl = "", channelName = "") {
    const now = /* @__PURE__ */ new Date();
    const dateString = now.toISOString().split("T")[0];
    const uniqueTags = extractedTags.length > 0 ? [...new Set(extractedTags)] : [];
    let markdown = `---
created: ${dateString}
updated: ${now.toISOString()}`;
    if (workspaceUrl && channelName && messages.length > 0) {
      const mainMessage = messages[0];
      if (mainMessage.ts) {
        markdown += `
slack_url: ${workspaceUrl}/archives/${channelName}/p${mainMessage.ts.replace(".", "")}`;
      }
    }
    if (uniqueTags.length > 0) {
      markdown += `
tags:`;
      uniqueTags.forEach((tag) => {
        markdown += `
  - ${tag}`;
      });
    }
    markdown += `
---

`;
    if (aiSummary) {
      markdown += aiSummary + "\n\n";
      markdown += "---\n\n";
    }
    messages.forEach((message, index) => {
      const timestamp = new Date(parseFloat(message.ts) * 1e3);
      const timeString = timestamp.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit"
      });
      const userName = message.userDisplayName || message.user || "Unknown";
      if (index === 0) {
        markdown += `## ${timeString} - ${userName}

`;
      } else {
        markdown += `### \u3000\u2514 ${timeString} - ${userName}

`;
      }
      markdown += `${message.text || ""}

`;
    });
    return markdown;
  }
  generateMessagesMarkdown(messages) {
    let markdown = "";
    messages.reverse().forEach((message) => {
      const timestamp = new Date(parseFloat(message.ts) * 1e3);
      const timeString = timestamp.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit"
      });
      const userName = message.userDisplayName || message.user || "Unknown";
      markdown += `## ${timeString} - ${userName}

`;
      markdown += `${message.text || ""}

`;
    });
    return markdown;
  }
  async generateAISummary(channelName, messages) {
    if (!this.settings.enableAISummary) {
      console.log("AI Summary is disabled");
      return "";
    }
    console.log(`Generating AI summary for ${channelName} with ${messages.length} messages`);
    const messagesText = messages.map((msg) => {
      const timestamp = new Date(parseFloat(msg.ts) * 1e3);
      const timeString = timestamp.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit"
      });
      const userName = msg.userDisplayName || msg.user || "Unknown";
      return `${timeString} - ${userName}: ${msg.text || ""}`;
    }).join("\n");
    const prompt = `\u4EE5\u4E0B\u306ESlack\u30E1\u30C3\u30BB\u30FC\u30B8\u3092\u5206\u6790\u3057\u3066\u3001template.md\u306E\u53B3\u5BC6\u306A\u5F62\u5F0F\u3067\u8981\u7D04\u3057\u3066\u304F\u3060\u3055\u3044\uFF1A

\u30C1\u30E3\u30F3\u30CD\u30EB: #${channelName}
\u30E1\u30C3\u30BB\u30FC\u30B8:
${messagesText}

\u3010\u91CD\u8981\u3011\u4EE5\u4E0B\u306E\u5F62\u5F0F\u3092\u53B3\u5BC6\u306B\u5B88\u3063\u3066\u51FA\u529B\u3057\u3066\u304F\u3060\u3055\u3044\uFF1A

## \u30BF\u30A4\u30C8\u30EB
\uFF0825\u5B57\u4EE5\u5185\u30FB\u53E5\u70B9\u306A\u3057\u30FB\u5185\u5BB9\u3092\u8868\u3059\u5177\u4F53\u7684\u306A\u540D\u8A5E\u53E5\u3067\u8981\u7D04\uFF09

\uFF08\u30E1\u30C3\u30BB\u30FC\u30B8\u306E\u8981\u7D04\u5185\u5BB9\u3092\u7B87\u6761\u66F8\u304D\uFF1A\uFF09
- \u91CD\u8981\u306A\u30DD\u30A4\u30F3\u30C81
- \u91CD\u8981\u306A\u30DD\u30A4\u30F3\u30C82  
- \u91CD\u8981\u306A\u30DD\u30A4\u30F3\u30C83

## \u8FFD\u52A0\u30EA\u30F3\u30AF\u4E00\u89A7
\uFF08\u30E1\u30C3\u30BB\u30FC\u30B8\u5185\u5BB9\u304B\u3089\u95A2\u9023\u3057\u305D\u3046\u306A\u30C8\u30D4\u30C3\u30AF\u30923-5\u500B\u63D0\u6848\uFF09
\u4F8B\uFF1A
- [[\u5065\u5EB7\u7BA1\u7406]] \u2026 \u4F53\u8ABF\u3001\u6539\u5584\u3001\u6563\u6B69\u306B\u95A2\u9023
- [[\u696D\u52D9\u7BA1\u7406]] \u2026 \u52E4\u52D9\u3001\u7A3C\u50CD\u3001\u4E88\u5B9A\u306B\u95A2\u9023
- [[\u6280\u8853\u958B\u767A]] \u2026 \u958B\u767A\u3001\u30D7\u30ED\u30B0\u30E9\u30DF\u30F3\u30B0\u3001\u30B7\u30B9\u30C6\u30E0\u306B\u95A2\u9023

\u3010\u30BF\u30B0\u6307\u91DD\uFF08front-matter\u306Etags\u30D7\u30ED\u30D1\u30C6\u30A3\u7528\u3001\u30CF\u30C3\u30B7\u30E5\u30BF\u30B0\u306F\u51FA\u529B\u3057\u306A\u3044\uFF09\u3011
\u30A8\u30F3\u30B8\u30CB\u30A2\u30EA\u30F3\u30B0: VBA, GAS, Python, \u81EA\u52D5\u5316\u30C4\u30FC\u30EB, Power_Automate
\u6280\u8853\u5B66\u7FD2: G\u691C\u5B9A, AWS, BigQuery, Looker_Studio  
\u696D\u52D9\u30FB\u4ED5\u4E8B: \u5348\u524D\u52E4\u52D9, \u5348\u5F8C\u52E4\u52D9, \u696D\u52D9\u52B9\u7387\u5316, \u793E\u5185\u30C4\u30FC\u30EB\u958B\u767A
\u5065\u5EB7\u30FB\u751F\u6D3B: \u30A6\u30A9\u30FC\u30AD\u30F3\u30B0, \u8AAD\u66F8, \u7761\u7720\u6539\u5584, \u4F53\u91CD\u7BA1\u7406
\u6210\u9577\u30FB\u5FA9\u8ABF: \u5403\u97F3\u514B\u670D, \u30C7\u30B9\u30AF\u30EF\u30FC\u30AF, \u30B9\u30AD\u30EB\u30A2\u30C3\u30D7, \u8EE2\u8077
\u5FC3\u7406\u30FB\u30E1\u30F3\u30BF\u30EB: \u4E0D\u7720\u75C7, \u81EA\u4FE1\u56DE\u5FA9, \u632F\u308A\u8FD4\u308A, \u6C17\u3065\u304D
\u30D7\u30ED\u30C0\u30AF\u30C8: \u732E\u7ACB\u30C4\u30FC\u30EB, \u5728\u5EAB\u7BA1\u7406, \u55B6\u696D\u4E8B\u52D9\u7BA1\u7406, \u30B7\u30D5\u30C8\u8868
\u72B6\u614B: \u8981\u5BFE\u5FDC, \u9AD8\u512A\u5148\u5EA6, \u9032\u884C\u4E2D, \u5B8C\u4E86

\u3010\u51FA\u529B\u30EB\u30FC\u30EB\u3011
- \u8981\u7D04\u306F\u300C\u301C\u3060\u300D\u307F\u305F\u3044\u306A\u611F\u3058\u306E\u6587\u8A9E\u8ABF\u3067\u8A18\u8FF0\u3059\u308B
- \u30CF\u30C3\u30B7\u30E5\u30BF\u30B0\u306F\u4E00\u5207\u51FA\u529B\u3057\u306A\u3044\uFF08\u30BF\u30B0\u306Ffront-matter\u3067\u7BA1\u7406\u3055\u308C\u308B\uFF09
- \u8FFD\u52A0\u30EA\u30F3\u30AF\u306F[[\u30EF\u30FC\u30C9]]\u5F62\u5F0F\u3067\u3001\u30E1\u30C3\u30BB\u30FC\u30B8\u5185\u5BB9\u306B\u95A2\u9023\u3059\u308B\u30C8\u30D4\u30C3\u30AF\u3092\u63D0\u6848\u3059\u308B

\u3010\u30BF\u30A4\u30C8\u30EB\u4F8B\u3011
- \u300C\u671D\u306E\u30A6\u30A9\u30FC\u30AD\u30F3\u30B0\u30EB\u30FC\u30C8\u691C\u8A0E\u300D
- \u300CPython\u81EA\u52D5\u5316\u30B9\u30AF\u30EA\u30D7\u30C8\u958B\u767A\u300D
- \u300C\u8AAD\u66F8\u8A18\u9332\u3068\u611F\u60F3\u5171\u6709\u300D
- \u300C\u696D\u52D9\u52B9\u7387\u5316\u30C4\u30FC\u30EB\u5C0E\u5165\u691C\u8A0E\u300D

\u5FC5\u305A\u4E0A\u8A18\u306E\u5F62\u5F0F\u901A\u308A\u306B\u51FA\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002`;
    try {
      console.log(`Using AI provider: ${this.settings.aiProvider}`);
      let result = "";
      switch (this.settings.aiProvider) {
        case "openai":
          result = await this.callOpenAI(prompt);
          break;
        case "anthropic":
          result = await this.callAnthropic(prompt);
          break;
        case "gemini":
          result = await this.callGemini(prompt);
          break;
        default:
          console.log("Unknown AI provider");
          return "";
      }
      console.log("AI Summary generated successfully");
      return result;
    } catch (error) {
      console.error("AI Summary error:", error);
      new import_obsidian.Notice(`AI Summary failed: ${error.message}`);
      return "";
    }
  }
  async callOpenAI(prompt) {
    if (!this.settings.openaiApiKey) {
      throw new Error("OpenAI API key not set");
    }
    const response = await (0, import_obsidian.requestUrl)({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.settings.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "\u3042\u306A\u305F\u306F\u65E5\u672C\u8A9E\u3067Slack\u30E1\u30C3\u30BB\u30FC\u30B8\u3092\u8981\u7D04\u3059\u308B\u5C02\u9580\u5BB6\u3067\u3059\u3002" },
          { role: "user", content: prompt }
        ],
        max_tokens: 1e3,
        temperature: 0.7
      })
    });
    if (response.status !== 200) {
      throw new Error(`OpenAI API error: ${response.status} - ${response.json.error?.message || "Unknown error"}`);
    }
    if (!response.json.choices || response.json.choices.length === 0) {
      throw new Error("No response from OpenAI");
    }
    return response.json.choices[0].message.content;
  }
  async callAnthropic(prompt) {
    if (!this.settings.anthropicApiKey) {
      throw new Error("Anthropic API key not set");
    }
    const response = await (0, import_obsidian.requestUrl)({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": this.settings.anthropicApiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1e3,
        messages: [
          { role: "user", content: prompt }
        ]
      })
    });
    if (response.status !== 200) {
      throw new Error(`Anthropic API error: ${response.status} - ${response.json.error?.message || "Unknown error"}`);
    }
    if (!response.json.content || response.json.content.length === 0) {
      throw new Error("No response from Anthropic");
    }
    return response.json.content[0].text;
  }
  async callGemini(prompt) {
    if (!this.settings.geminiApiKey) {
      throw new Error("Gemini API key not set");
    }
    const response = await (0, import_obsidian.requestUrl)({
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${this.settings.geminiApiKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
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
      throw new Error(`Gemini API error: ${response.status} - ${response.json.error?.message || "Unknown error"}`);
    }
    if (!response.json.candidates || response.json.candidates.length === 0) {
      throw new Error("No response from Gemini");
    }
    return response.json.candidates[0].content.parts[0].text;
  }
  generateFallbackTitle(messages) {
    if (!messages || messages.length === 0) {
      return "";
    }
    const allText = messages.map((msg) => msg.text || "").join(" ");
    const words = allText.replace(/[^\w\s一-龯ひらがなカタカナ]/g, " ").split(/\s+/).filter((word) => word.length > 1).filter((word) => !["\u3067\u3059", "\u307E\u3059", "\u3057\u305F", "\u3059\u308B", "\u3067\u3042\u308B", "\u3060\u3063\u305F", "\u306A\u308B", "\u3042\u308B", "\u3044\u308B", "\u3053\u3068", "\u3082\u306E", "\u305F\u3081", "\u306E\u3067", "\u3051\u3069", "\u3067\u3082", "\u3057\u304B\u3057", "\u305D\u3057\u3066", "\u307E\u305F", "\u3055\u3089\u306B", "\u305D\u308C", "\u3053\u308C", "\u3042\u308C", "\u3069\u308C", "\u305D\u306E", "\u3053\u306E", "\u3042\u306E", "\u3069\u306E", "\u304B\u3089", "\u307E\u3067", "\u3088\u308A"].includes(word));
    const titleWords = words.slice(0, 3);
    if (titleWords.length > 0) {
      return titleWords.join("_").substring(0, 30);
    }
    return "";
  }
  getDateString() {
    const now = /* @__PURE__ */ new Date();
    return now.toISOString().split("T")[0].replace(/-/g, "");
  }
};
var SlackSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Slack Sync Settings" });
    new import_obsidian.Setting(containerEl).setName("Slack Bot Token").setDesc("Your Slack Bot User OAuth Token (starts with xoxb-)").addText((text) => text.setPlaceholder("xoxb-your-token-here").setValue(this.plugin.settings.slackToken).onChange(async (value) => {
      this.plugin.settings.slackToken = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Channels").setDesc("Comma-separated list of channel names to sync").addText((text) => text.setPlaceholder("general,random,dev-team").setValue(this.plugin.settings.channels.join(",")).onChange(async (value) => {
      this.plugin.settings.channels = value.split(",").map((s) => s.trim());
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Output Folder").setDesc("Folder where synced messages will be saved").addText((text) => text.setPlaceholder("Slack").setValue(this.plugin.settings.outputFolder).onChange(async (value) => {
      this.plugin.settings.outputFolder = value;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "AI Summary Settings" });
    new import_obsidian.Setting(containerEl).setName("Enable AI Summary").setDesc("Generate AI-powered summaries of Slack messages").addToggle((toggle) => toggle.setValue(this.plugin.settings.enableAISummary).onChange(async (value) => {
      this.plugin.settings.enableAISummary = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("AI Provider").setDesc("Choose your preferred AI service").addDropdown((dropdown) => dropdown.addOption("openai", "OpenAI (GPT-4o-mini)").addOption("anthropic", "Anthropic (Claude 3.5 Haiku)").addOption("gemini", "Google Gemini (2.5 Flash)").setValue(this.plugin.settings.aiProvider).onChange(async (value) => {
      this.plugin.settings.aiProvider = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("OpenAI API Key").setDesc("Your OpenAI API key (starts with sk-)").addText((text) => text.setPlaceholder("sk-your-openai-key-here").setValue(this.plugin.settings.openaiApiKey).onChange(async (value) => {
      this.plugin.settings.openaiApiKey = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Anthropic API Key").setDesc("Your Anthropic API key (starts with sk-ant-)").addText((text) => text.setPlaceholder("sk-ant-your-anthropic-key-here").setValue(this.plugin.settings.anthropicApiKey).onChange(async (value) => {
      this.plugin.settings.anthropicApiKey = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Gemini API Key").setDesc("Your Google Gemini API key").addText((text) => text.setPlaceholder("your-gemini-key-here").setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => {
      this.plugin.settings.geminiApiKey = value;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Auto Sync Settings" });
    new import_obsidian.Setting(containerEl).setName("Enable Auto Sync").setDesc("Automatically sync messages at regular intervals").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
      this.plugin.settings.autoSync = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Sync Interval (hours)").setDesc("How often to automatically sync messages").addSlider((slider) => slider.setLimits(1, 24, 1).setValue(this.plugin.settings.syncInterval).setDynamicTooltip().onChange(async (value) => {
      this.plugin.settings.syncInterval = value;
      await this.plugin.saveSettings();
    }));
  }
};
