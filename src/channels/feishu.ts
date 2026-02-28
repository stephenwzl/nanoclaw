import * as Lark from '@larksuiteoapi/node-sdk';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

interface FeishuMessage {
  text?: string;
}

interface FeishuMessageEvent {
  message: {
    chat_id: string;
    content: string;
    message_type: string;
    chat_type: string;
    message_id: string;
    sender: {
      nickname?: string;
      name?: string;
    };
  };
  sender_id?: {
    open_id?: string;
  };
}

function getFeishuConfig() {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  return {
    appId: env.FEISHU_APP_ID || process.env.FEISHU_APP_ID || '',
    appSecret: env.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET || '',
  };
}

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private connected = false;
  private processedMessageIds = new Set<string>();
  private wsClient: Lark.WSClient | null = null;
  private client: Lark.Client | null = null;
  private opts: FeishuChannelOpts;
  private eventDispatcher: Lark.EventDispatcher;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;
    this.eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': this.handleMessage.bind(this),
    });
  }

  async connect(): Promise<void> {
    // 延迟读取配置
    const config = getFeishuConfig();

    // 验证配置
    if (!config.appId || !config.appSecret) {
      throw new Error(
        '飞书配置缺失：请在 .env 中设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET',
      );
    }

    this.client = new Lark.Client(config);
    this.wsClient = new Lark.WSClient(config);

    try {
      this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      this.connected = true;
      logger.info(`飞书机器人已启动，App ID: ${config.appId}`);
    } catch (error) {
      logger.error({ error }, '飞书连接失败');
      throw error;
    }
  }

  async sendMessage(jid: string, text: string, replyToId?: string): Promise<void> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    try {
      // jid 格式: "chat_type:chat_id" 或 "chat_id"
      let chatType = 'p2p';
      let chatId = jid;

      if (jid.includes(':')) {
        const parts = jid.split(':');
        chatType = parts[0];
        chatId = parts[1];
      }

      const content = JSON.stringify({ text });

      if (chatType === 'p2p') {
        // 私聊：用 chat_id 主动发送
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content,
            msg_type: 'text',
          },
        });
      } else {
        // 群聊：回复原消息（消息会显示在同一上下文）
        if (replyToId) {
          await this.client.im.v1.message.reply({
            path: { message_id: replyToId },
            data: {
              content,
              msg_type: 'text',
            },
          });
        } else {
          // 群聊也可以主动发送
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content,
              msg_type: 'text',
            },
          });
        }
      }

      logger.debug({ chatId, length: text.length }, '飞书消息已发送');
    } catch (error) {
      logger.error({ error, jid }, '飞书发送消息失败');
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // 飞书的 jid 格式: "feishu:chat_id" 或 "p2p:chat_id"
    return jid.startsWith('feishu:') || jid.startsWith('p2p:') || jid.startsWith('group:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // WSClient 可能没有 stop 方法，这里只是标记断开
    logger.info('飞书机器人已断开连接');
  }

  // ---- 消息去重 ----
  private isMessageProcessed(messageId: string): boolean {
    if (this.processedMessageIds.has(messageId)) return true;
    this.processedMessageIds.add(messageId);
    // 超过 1000 条时删最旧的，防止内存无限增长
    if (this.processedMessageIds.size > 1000) {
      const first = this.processedMessageIds.values().next().value;
      if (first) {
        this.processedMessageIds.delete(first);
      }
    }
    return false;
  }

  // ---- 处理接收到的消息 ----
  private async handleMessage(data: unknown): Promise<void> {
    const eventData = data as FeishuMessageEvent;
    const {
      message: {
        chat_id,
        content,
        message_type,
        chat_type,
        message_id,
        sender,
      },
      sender_id,
    } = eventData;

    // 去重检查
    if (this.isMessageProcessed(message_id)) return;

    // 只处理文本消息
    if (message_type !== 'text') {
      logger.debug({ messageId: message_id, messageType: message_type }, '跳过非文本消息');
      return;
    }

    // 解析消息内容
    let text = '';
    try {
      const parsed = JSON.parse(content) as FeishuMessage;
      text = parsed.text || '';
    } catch {
      logger.warn({ content }, '飞书消息内容解析失败');
      return;
    }

    if (!text) return;

    // 构造 JID: "feishu:chat_id" 或 "p2p:chat_id"
    const chatJid = chat_type === 'p2p' ? `p2p:${chat_id}` : `group:${chat_id}`;
    const senderId = sender_id?.open_id || 'unknown';
    const senderName = sender?.nickname || sender?.name || 'Unknown';

    // 群聊中需要被 @ 才响应（飞书默认行为）
    const isFromMe = this.isSelfMessage(senderId);

    // 记录聊天元数据
    this.opts.onChatMetadata?.(
      chatJid,
      new Date().toISOString(),
      undefined,
      'feishu',
      chat_type === 'group',
    );

    // 分发消息
    this.opts.onMessage?.(chatJid, {
      id: message_id,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: isFromMe,
      is_bot_message: false,
    });

    logger.debug(
      { chatType: chat_type, chatId: chat_id, senderName, text: text.slice(0, 50) },
      '飞书收到消息',
    );
  }

  // 判断是否是机器人自己发的消息
  private isSelfMessage(senderId: string): boolean {
    // 飞书机器人的 open_id 通常以 ou_ 开头
    // 这里需要根据实际情况判断
    return false;
  }

  // 设置正在输入指示器（飞书不支持）
  async setTyping?(jid: string, isTyping: boolean): Promise<void> {
    // 飞书不支持正在输入指示器
  }
}
