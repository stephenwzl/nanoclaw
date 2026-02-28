---
name: feishu-bot-agent
description: 在 Node.js 项目中接入飞书机器人，实现消息监听与收发。包含飞书开发者后台配置、WebSocket 长连接、收发消息 API、消息去重、私聊/群聊差异处理等。当用户需要接入飞书机器人、监听飞书消息或通过飞书发送消息时使用。
---

# 飞书机器人消息收发

## 飞书开发者后台配置

1. 进入 [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用
2. **添加机器人能力**：应用功能 → 机器人 → 开启
3. **配置事件订阅**：
   - 订阅方式选「**使用长连接接收事件**」（无需公网服务器）
   - 添加事件：`im.message.receive_v1`
4. **开通权限**：权限管理 → 搜索添加：
   - `im:message`（读取消息）
   - `im:message:send_as_bot`（发送消息）
5. **发布应用**（或在「版本管理与发布」添加测试人员）
6. 记录 **App ID** 和 **App Secret**

---

## 依赖安装

```bash
npm install @larksuiteoapi/node-sdk dotenv
```

---

## 完整示例

```javascript
import * as Lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';
dotenv.config();

const baseConfig = {
  appId: process.env.APP_ID,
  appSecret: process.env.APP_SECRET,
};

// REST 客户端（发消息用）
const client = new Lark.Client(baseConfig);
// WebSocket 客户端（收消息用）
const wsClient = new Lark.WSClient(baseConfig);

// ---- 消息去重（飞书 WebSocket 会重复推送同一条消息）----
const processedMessageIds = new Set();
function isMessageProcessed(messageId) {
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  // 超过 1000 条时删最旧的，防止内存无限增长
  if (processedMessageIds.size > 1000) {
    processedMessageIds.delete(processedMessageIds.values().next().value);
  }
  return false;
}

// ---- 发送消息 ----
async function sendMessage(chatId, text, chatType, messageId) {
  try {
    if (chatType === 'p2p') {
      // 私聊：用 chat_id 主动发送
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } else {
      // 群聊：回复原消息（消息会显示在同一上下文）
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    }
  } catch (error) {
    console.error('发送消息失败:', error.message);
  }
}

// ---- 注册事件处理器 ----
const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const {
      message: { chat_id, content, message_type, chat_type, message_id },
    } = data;

    // 去重
    if (isMessageProcessed(message_id)) return;

    // 只处理文本消息
    if (message_type !== 'text') {
      await sendMessage(chat_id, '暂只支持文本消息', chat_type, message_id);
      return;
    }

    // 解析消息内容
    const text = JSON.parse(content).text;
    console.log(`收到消息 [${chat_type}]: ${text}`);

    // 你的业务逻辑
    await sendMessage(chat_id, `你说了：${text}`, chat_type, message_id);
  },
});

// ---- 启动 ----
wsClient.start({ eventDispatcher });
console.log('飞书机器人已启动，等待消息...');
```

---

## 关键细节

### 私聊 vs 群聊

| | `chat_type` | 发送方式 | 备注 |
|---|---|---|---|
| 私聊 | `p2p` | `message.create` + `chat_id` | 主动发送给用户 |
| 群聊 | `group` | `message.reply` + `message_id` | 回复原消息保持上下文 |

### 消息内容格式

飞书的 `content` 字段是 JSON 字符串，文本消息需双重解析：

```javascript
// content 原始值：'{"text":"用户输入的内容"}'
const text = JSON.parse(content).text;
```

### .env 配置

```bash
APP_ID=cli_xxxxxxxxx
APP_SECRET=xxxxxxxxx
```

---

## 常见问题

**消息被处理多次**：飞书 WebSocket 在网络波动时会重复推送事件，必须用 `message_id` 去重。

**群聊收不到消息**：机器人需要被 @ 才会收到事件，或在飞书后台将订阅范围改为「接收所有消息」（需额外权限 `im:message:group_at_msg:readonly`）。

**发消息报权限错误**：确认已在后台开通 `im:message:send_as_bot`，且应用已发布/测试人员已添加。
