const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  DefaultWebSocketManagerOptions
} = require('discord.js');

const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();


const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SHAPE = process.env.SHAPE
const COOKIE_PATH = './shapes_cookies.json';
const CUSTOM_STATUS = process.env.CUSTOM_STATUS
const db = new Database('./shapes.db');

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  chat_id TEXT,
  active INTEGER DEFAULT 0,
  system_prompt TEXT,
  message_count INTEGER DEFAULT 0,
  created_at INTEGER,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  anonymous INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  value INTEGER
);
`);

db.prepare(`
INSERT OR IGNORE INTO stats (key, value)
VALUES ('messages', 0), ('start_time', ?)
`).run(Date.now());


process.on('unhandledRejection', e => {
  if ([10062, 50001, 50013].includes(e?.code)) return;
  console.error('[UNHANDLED]', e);
});

process.on('uncaughtException', e => {
  console.error('[UNCAUGHT]', e);
});

const streams = new Map();
const chatLocks = new Map();
const DISCORD_MAX = 2000;

function chunkMessage(text, max = DISCORD_MAX) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > max) {
    let slice = remaining.slice(0, max);
    let splitIndex = slice.lastIndexOf('\n');
    if (splitIndex === -1) splitIndex = slice.lastIndexOf(' ');
    if (splitIndex === -1 || splitIndex < max * 0.5) splitIndex = max;

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}



const getChannel = (g, c) =>
  db.prepare(`SELECT * FROM channels WHERE guild_id=? AND channel_id=?`).get(g, c);

const upsertChannel = (g, c, chatId, active = 0) =>
  db.prepare(`
    INSERT INTO channels (guild_id, channel_id, chat_id, active, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id)
    DO UPDATE SET chat_id=excluded.chat_id
  `).run(g, c, chatId, active, Date.now());

const setActive = (g, c, a) =>
  db.prepare(`UPDATE channels SET active=? WHERE guild_id=? AND channel_id=?`)
    .run(a ? 1 : 0, g, c);

const incrementStats = (g, c) => {
  db.prepare(`
    UPDATE channels SET message_count = message_count + 1
    WHERE guild_id=? AND channel_id=?
  `).run(g, c);
  db.prepare(`UPDATE stats SET value=value+1 WHERE key='messages'`).run();
};

async function getShapeData(shapeSlug) {
  try {
    const res = await fetch(`https://shapes.inc/api/public/shapes/${shapeSlug}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return {
      id: data.id,
      name: data.name || 'Shape',
      activation: data.shape_settings?.shape_initial_message || 'hello'
    };
  } catch (err) {
    console.error('Failed to fetch shape data:', err);
    return { id: null, name: 'Shape', activation: 'hello' };
  }
}



let browser, page;

function pageAlive() {
  return page && !page.isClosed();
}

async function safeEvaluate(fn, ...args) {
  if (!pageAlive()) return null;
  try {
    return await page.evaluate(fn, ...args);
  } catch {
    return null;
  }
}

async function initBrowser() {
  const hasCookies = fs.existsSync(COOKIE_PATH);

  browser = await puppeteer.launch({
    headless: hasCookies,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  page = await browser.newPage();

  if (hasCookies) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
      await page.setCookie(...cookies);
    } catch {}
  }

  await page.goto("https://talk.shapes.inc/login", {
    waitUntil: "networkidle2",
  });

  const loggedIn = await safeEvaluate(() => {
    return (
      !!document.querySelector('a[href^="/chat"]') ||
      !!document.querySelector('[data-testid="chat-list"]')
    );
  });

  if (!loggedIn) {
    await browser.close();

    browser = await puppeteer.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    page = await browser.newPage();
    await page.goto('https://talk.shapes.inc/login', { waitUntil: 'networkidle2' });

    console.log('Log in, then press Enter');
    await new Promise(r => process.stdin.once('data', r));
  }

  const cookies = await page.cookies();
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));

  if (!page.__emitSSEExposed) {
    await page.exposeFunction('emitSSE', data => {
      const entry = streams.get(data.chatId);
      if (!entry) return;
      entry.listeners.forEach(cb => cb(data));
    });
    page.__emitSSEExposed = true;
  }
}



async function ensureStream(chatId) {
  if (streams.has(chatId)) return streams.get(chatId);

  const entry = {
    listeners: new Set(),
    subscribe(cb) {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }
  };

  streams.set(chatId, entry);

  await safeEvaluate(chatId => {
    window.__sse ||= {};
    if (window.__sse[chatId]) return;
    const es = new EventSource(
      `https://talk.shapes.inc/api/chat/${chatId}/stream`,
      { withCredentials: true }
    );
    es.onmessage = e => {
      try { window.emitSSE({ chatId, ...JSON.parse(e.data) }); } catch {}
    };
    window.__sse[chatId] = es;
  }, chatId);

  return entry;
}


async function createChannelChat(shapeSlug, channelName, channelId) {
  const chatId = await page.evaluate(async (slug, name, id) => {
    const payload = {
      title: `${name} (${id})`,
      shapes: [slug],
      visibility: "private",
      isPrivate: true,
      useCase: "roleplay",
      freeWillMode: "low",
    };
    const res = await fetch("https://talk.shapes.inc/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return data?.id || data?.room?.id || null;
  }, shapeSlug, channelName, channelId);

  return chatId;
}



async function sendCommand(chatId, cmd) {
  await safeEvaluate((chatId, cmd, shape) => {
    fetch('https://talk.shapes.inc/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        id: chatId,
        message: {
          role: 'user',
          content: cmd,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          parts: [{ type: 'text', text: cmd }]
        },
        selectedChatModel: `shapesinc/${shape}`,
        selectedVisibilityType: 'private',
        initialInterlocutors: [`shapesinc/${shape}`]
      })
    });
  }, chatId, cmd, SHAPE);
}

async function safeInteractionReply(i, payload) {
  try {
    if (i.replied || i.deferred) {
      return await i.followUp(payload);
    }
    return await i.reply(payload);
  } catch (err) {
    if ([10062, 50001, 50013].includes(err?.code)) return;
    console.warn('Interaction reply failed:', err);
  }
}


async function sendMessage(chatId, text, attachments = []) {
  if (chatLocks.get(chatId)) return null;
  chatLocks.set(chatId, true);

  const userMessageId = crypto.randomUUID();
  let resolved = false;

  try {
    await ensureStream(chatId);
    const stream = streams.get(chatId);

    return await new Promise(async resolve => {
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        unsub();
        console.warn('sendMessage timeout', { chatId });
        resolve(null);
      }, 20000);

      let seenUserMessage = false;

      const unsub = stream.subscribe(e => {
        if (resolved || e?.type !== 'new_message') return;

        const msg = e.message;

        if (msg?.id === userMessageId && msg.role === 'user') {
          seenUserMessage = true;
          return;
        }

        if (seenUserMessage && msg?.role === 'assistant') {
          resolved = true;
          clearTimeout(timeout);
          unsub();

          resolve(
            msg.parts
              .filter(p => p.type === 'text')
              .map(p => p.text)
              .join('\n\n')
          );
        }
      });

      await safeEvaluate((chatId, text, shape, attachments, id) => {
        fetch('https://talk.shapes.inc/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            id: chatId,
            message: {
              id,
              role: 'user',
              content: text || ' ',
              createdAt: new Date().toISOString(),
              parts: [{ type: 'text', text: text || ' ' }],
              ...(attachments.length && { experimental_attachments: attachments })
            },
            selectedChatModel: `shapesinc/${shape}`,
            selectedVisibilityType: 'private',
            initialInterlocutors: [`shapesinc/${shape}`]
          })
        });
      }, chatId, text, SHAPE, attachments, userMessageId);
    });
  } finally {
    chatLocks.delete(chatId);
  }
}


async function withTypingIndicator(channel, task) {
  let active = true;

  const interval = setInterval(() => {
    if (active) channel.sendTyping().catch(() => {});
  }, 4000);

  const failsafe = setTimeout(() => {
    active = false;
  }, 30000);

  try {
    return await task();
  } finally {
    active = false;
    clearInterval(interval);
    clearTimeout(failsafe);
  }
}


async function sendShapeCommandAndWait(chatId, command, waitMs = 15000) {
  if (!chatId) return null;

  await ensureStream(chatId);
  const stream = streams.get(chatId);

  return new Promise(async resolve => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsub();
        resolve(null);
      }
    }, waitMs);

    const unsub = stream.subscribe(e => {
      if (resolved) return;

      if (e?.type === 'new_message' && e.message?.role === 'assistant') {
        resolved = true;
        clearTimeout(timeout);
        unsub();

        resolve(
          e.message.parts
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n')
        );
      }
    });

    await sendCommand(chatId, command);
  });
}


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});


if (process.env.MOBILE === 'true') {
DefaultWebSocketManagerOptions.identifyProperties.browser = 'Discord iOS';
};


const commands = [
  new SlashCommandBuilder()
    .setName('activate')
    .setDescription('Activate shape in this channel'),

  new SlashCommandBuilder()
    .setName('deactivate')
    .setDescription('Deactivate shape in this channel'),

  new SlashCommandBuilder()
    .setName('wack')
    .setDescription('Clear short term memory'),

  new SlashCommandBuilder()
    .setName('sleep')
    .setDescription('Sleep (create memory now)'),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset (delete all memories)'),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Say anything as the shape')
    .addStringOption(o =>
      o
        .setName('text')
        .setDescription('Text for the shape to say')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show uptime and message statistics'),

  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename yourself for the shape')
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Name the shape will see')
        .setRequired(true)
    )
    .addBooleanOption(o =>
      o
        .setName('anonymous')
        .setDescription('Hide rename message (ephemeral)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('custominstructions')
    .setDescription('Set, view, or clear custom instructions for this chat')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set custom instructions')
      .addStringOption(o => o
        .setName('text')
        .setDescription('Instructions to set (max 1500 characters)')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('clear')
      .setDescription('Clear custom instructions'))
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View current custom instructions')
    )  
].map(c => c.toJSON());



(async () => {
  await initBrowser();
  await new REST({ version: '10' })
    .setToken(DISCORD_BOT_TOKEN)
    .put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  await client.login(DISCORD_BOT_TOKEN);
})();


client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  const g = i.guild.id;
  const c = i.channel.id;
  let row = getChannel(g, c);

if (i.commandName === 'activate') {
  let chatId = row?.chat_id;

  if (!chatId) {
    chatId = await createChannelChat(SHAPE, i.channel.name, i.channel.id);
    if (!chatId) {
      return i.reply("Failed to create chat");
    }
    upsertChannel(g, c, chatId, 1);
  } else {
    setActive(g, c, true);
  }

  const { name: shapeName, activation: shapeActivation } = await getShapeData(SHAPE);

  await i.reply(`${shapeName} activated.`);
  await i.followUp(shapeActivation);
}



if (i.commandName === 'deactivate') {
  setActive(g, c, false);

  const { name: shapeName } = await getShapeData(SHAPE);
  return i.reply(`${shapeName} deactivated.`);
}


if (['wack', 'sleep', 'reset'].includes(i.commandName)) {
  if (!row?.chat_id) {
    return safeInteractionReply(i, 'No active chat to do this');
  }

  await i.deferReply();

  const reply = await sendShapeCommandAndWait(
    row.chat_id,
    `!${i.commandName}`
  );

  if (!reply) {
    return safeInteractionReply(i, 'No response from shape.');
  }

  return safeInteractionReply(i, reply);
}


if (i.commandName === 'say') {
  const username = i.user.username;
  const text = i.options.getString('text');

  if (text.length > 1983) {
    return i.reply({
      content: "Text too long, please use something shorter",
      ephemeral: true,
    });
  }

  const payload = `${text}\n\`${username}\``;
  return i.reply(payload);
}



  if (i.commandName === 'stats') {
    const s = db.prepare(`SELECT * FROM stats`).all();
    const uptime = Date.now() - s.find(x => x.key === 'start_time').value;
    const hours = (uptime / 3_600_000).toFixed(2);
    const total = s.find(x => x.key === 'messages').value;
    const pct = row ? ((row.message_count / total) * 100).toFixed(1) : 0;
    return i.reply(`Uptime: ${hours}h\nMessages: ${total}\nChannel %: ${pct}%\n`);
  }

if (i.commandName === 'rename') {
  const newName = i.options.getString('name').trim();
  const ephemeralReply = i.options.getBoolean('anonymous') ?? false;

  if (newName.length > 1983) {
    return i.reply({
      content: "Name too long, please try a shorter name",
      ephemeral: true,
    });
  }
  db.prepare(`
    INSERT INTO users (user_id, display_name)
    VALUES (?, ?)
    ON CONFLICT(user_id)
    DO UPDATE SET display_name=excluded.display_name
  `).run(i.user.id, newName);

  return i.reply({ content: `Your name is now ${newName}`, ephemeral: ephemeralReply });
}

if (i.commandName === 'custominstructions') {
  if (!row?.chat_id) {
    return i.reply({ content: "No active chat in this channel.", ephemeral: true });
  }

  const chatId = row.chat_id;
  const sub = i.options.getSubcommand();

  if (sub === 'set') {
    let text = i.options.getString('text').trim();
    if (text.length > 1500) {
      return i.reply({ content: "Instructions too long (max 1500 characters).", ephemeral: true });
    }
    await safeEvaluate(async (chatId, text) => {
      await fetch(`https://talk.shapes.inc/api/chat/${chatId}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: '*/*' },
        credentials: 'include',
        body: JSON.stringify({ preset: text })
      });
    }, chatId, text);

    db.prepare(`
      UPDATE channels SET system_prompt=? WHERE guild_id=? AND channel_id=?
    `).run(text, i.guild.id, i.channel.id);

    return i.reply("Custom instructions updated.");
  }

  if (sub === 'clear') {
    await safeEvaluate(async (chatId) => {
      await fetch(`https://talk.shapes.inc/api/chat/${chatId}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: '*/*' },
        credentials: 'include',
        body: JSON.stringify({ preset: "" })
      });
    }, chatId);

    db.prepare(`
      UPDATE channels SET system_prompt=NULL WHERE guild_id=? AND channel_id=?
    `).run(i.guild.id, i.channel.id);

    return i.reply("Custom instructions cleared.");
  }

  if (sub === 'view') {
    const instructions = row.system_prompt;
    return i.reply(instructions ? `Current instructions:\n${instructions}` : "No custom instructions set.");
  }
}

});


client.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  const perms = msg.channel.permissionsFor(msg.guild.members.me);
  if (!perms?.has('SendMessages')) return;

  let row = getChannel(msg.guild.id, msg.channel.id);

let chatId;
if (!row) {
  chatId = await createChannelChat(SHAPE, msg.channel.name, msg.channel.id);
  if (!chatId) return console.warn('Failed to create chat');
  upsertChannel(msg.guild.id, msg.channel.id, chatId, 0);
  row = getChannel(msg.guild.id, msg.channel.id);
} else {
  chatId = row.chat_id;
}



  const active = row.active;
  const mentioned = msg.mentions.has(client.user);
  if (!active && !mentioned) return;

  const user = db.prepare(`SELECT * FROM users WHERE user_id=?`).get(msg.author.id);
  const name = user?.anonymous ? 'Anonymous' : user?.display_name ?? msg.author.username;

  const imageAttachments = msg.attachments
    .filter(att => att.contentType?.startsWith('image/'))
    .map(att => ({
      url: att.url,
      name: att.name ?? 'image',
      contentType: att.contentType,
      width: att.width,
      height: att.height
    }));
  
  
  const shapeData = await getShapeData(SHAPE);

  let content = msg.content || '';

  if (shapeData.id) {
  const botMentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
  const shapeMention = `[@${SHAPE}](shape:${shapeData.id}|${SHAPE})`;
  content = content.replace(botMentionRegex, shapeMention);
  }

  const text = `>>>${name}: ${content}`;


  await ensureStream(chatId);

  const reply = await withTypingIndicator(msg.channel, async () =>
    sendMessage(chatId, text, imageAttachments)
  ).catch(() => null);

  if (!reply) {
    console.warn('No response from shape', { chatId, text });
    return;
  }

  for (const chunk of chunkMessage(reply)) {
    try {
      await msg.reply(chunk);
    } catch {}
  }

  incrementStats(msg.guild.id, msg.channel.id);
});

const statusCode = Number(process.env.ONLINE_STATUS);
let status;
switch (statusCode) {
  case 1:
    status = 'dnd';
    break;
  case 2:
    status = 'idle';
    break;
  case 3:
    status = 'invisible';
    break;
  default:
    status = 'online';
}


client.once('clientReady', () => {
  try {
    client.user.setPresence({
      activities: [{ name: `${CUSTOM_STATUS}`, type: 4 }], 
      status: status
    });
  } catch (err) {
    console.error('Failed to set presence:', err);
  }

  console.log(`${client.user.tag} online`);
});
