import { Client, GatewayIntentBits, Partials } from 'discord.js';

import { config } from 'dotenv';
import fetch from 'node-fetch';
import pkg from 'pg';
import http from 'http';
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive!');
}).listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

config();

const { Client: PgClient } = pkg;

const db = new PgClient({ connectionString: process.env.DATABASE_URL });
await db.connect();



const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const MAX_EMOJIS_PER_USER = 5;
const messageTimestamps = new Map();
const badWords = ['nsfw', 'sex', 'porn', 'nude', 'xxx', 'hentai', 'milf'];
const scamLinks = ['discord.gift/', 'free-nitro', 'airdrop', 'steam-giveaway', 'nitro', 'claim-nitro'];

function isSpam(message, limit = 5, interval = 7000) {
  const userId = message.author.id;
  const now = Date.now();
  if (!messageTimestamps.has(userId)) messageTimestamps.set(userId, []);
  const timestamps = messageTimestamps.get(userId);
  timestamps.push(now);
  const recent = timestamps.filter(ts => now - ts < interval);
  messageTimestamps.set(userId, recent);
  return recent.length > limit;
}

function containsScamLink(content) {
  return scamLinks.some(link => content.toLowerCase().includes(link));
}

function containsBadWords(content) {
  return badWords.some(word => content.toLowerCase().includes(word));
}

function containsBannedLink(content) {
  const bannedPatterns = [
    /(?:onlyfans|0nlyfans)/i,
    /(?:pornhub|xvideos|redtube|xnxx)/i,
    /(?:\.ru|\.xyz|\.click|\.zip|discord\.gift)/i,
    /(?:https?:\/\/)?(?:www\.)?(?:[^ ]+\.)?(?:xxx|sex|cam|nsfw)/i,
  ];
  return bannedPatterns.some((regex) => regex.test(content));
}



async function isToxicMessage(content) {
  try {
    const response = await fetch("https://router.huggingface.co/hf-inference/models/unitary/toxic-bert", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: content }),
    });

    const result = await response.json();

    const toxicResult = result?.[0]?.find(r =>
    r.label.toLowerCase().includes("toxic")
    );

    console.log(`[ML] Toxicity score: ${toxicResult?.score ?? "unknown"}`);

    return toxicResult && toxicResult.score >= 0.7;

  } catch (err) {
    console.error("❌ Toxicity check failed:", err.message);
    return false;
  }
}


async function logModerationAction(targetUser, action, reason = null, message = null) {
  const guildId = message.guild.id;
  const moderatorId = bot.user.id;
  const targetId = targetUser.id;
  if (!message || !message.guild) {
    console.warn("⚠️ Tried to log without a valid message context.");
    return;
  }

  try {
    // Log to PostgreSQL
    await db.query(
      'INSERT INTO moderation_logs (guild_id, moderator_id, action, target_id, reason) VALUES ($1, $2, $3, $4, $5)',
                   [guildId, moderatorId, action, targetId, reason]
    );

    // Fetch log channel from DB
    const result = await db.query(
      'SELECT channel_id FROM log_channel_settings WHERE guild_id = $1',
      [guildId]
    );

    const logChannelId = result.rows[0]?.channel_id;
    if (!logChannelId) return;

    const logChannel = await bot.channels.fetch(logChannelId);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({
        embeds: [
          {
            color: 0xff0000,
            title: `🔨 Moderation Action: ${action}`,
            fields: [
              { name: "User", value: `<@${targetId}>`, inline: true },
              { name: "Action", value: action, inline: true },
              { name: "Reason", value: reason || "Not provided", inline: false },
            ],
            timestamp: new Date().toISOString(),
                            footer: { text: `Moderator: ${bot.user.username}` },
          },
        ],
      });
    }
  } catch (err) {
    console.error("Failed to log moderation action:", err);
  }
}

// === Unmute loop ===
setInterval(async () => {
  const now = new Date();
  try {
    const expired = await db.query(
      'SELECT * FROM muted_users WHERE unmute_at <= $1',
      [now]
    );

    for (const row of expired.rows) {
      const guild = bot.guilds.cache.get(row.guild_id);
      if (!guild) continue;
      const member = await guild.members.fetch(row.user_id).catch(() => null);
      if (!member) continue;

      const muteRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
      if (muteRole) await member.roles.remove(muteRole).catch(() => {});
      await db.query('DELETE FROM muted_users WHERE id = $1', [row.id]);
      const fakeMsg = { guild };
      await logModerationAction(member.user, 'unmute', 'Auto unmute (time expired)', fakeMsg);
    }
  } catch (err) {
    console.error("❌ Unmute check error:", err);
  }
}, 30_000);

function parseDuration(input) {
  const match = input.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const [_, value, unit] = match;
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(value) * multipliers[unit] * 1000;
}


bot.once('ready', () => {
  console.log(`\uD83E\uDD16 Logged in as ${bot.user.tag}`);
});

bot.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.toLowerCase();
  const guildId = message.guild.id;
  const targetId = message.author.id;
  const moderatorId = bot.user.id;

  if (await isToxicMessage(message.content)) {
    try {
      await message.delete();
      await message.channel.send(`⚠️ Message from ${message.author} deleted for toxic language.`);
      await logModerationAction(message.author, "delete", "Toxic language", message);

    } catch (err) { console.error("Toxic delete error:", err); }
    return;
  }

  if (containsBannedLink(content)) {
    try {
      await message.delete();
      await message.channel.send(`${message.author}, your message was removed for inappropriate links.`);
      await logModerationAction(message.author, "delete", "Inappropriate/porn link", message);
    } catch (err) { console.error("Banned link error:", err); }
    return;
  }

  if (isSpam(message)) {
    try {
      await message.delete();
      await message.channel.send(`${message.author}, slow down with messages.`);
      await logModerationAction(message.author, "delete", "Scam link detected", message);

    } catch (err) { console.error("Spam delete error:", err); }
    return;
  }

  if (containsScamLink(content)) {
    try {
      await message.delete();
      await message.channel.send(`${message.author}, scam links are not allowed.`);
      await logModerationAction(message.author, "delete", "Scam link detected", message);

    } catch (err) { console.error("Scam delete error:", err); }
    return;
  }

  if (containsBadWords(content)) {
    try {
      await message.delete();
      await message.channel.send(`${message.author}, watch your language.`);
      await logModerationAction(message.author, "delete", "Inappropriate language", message);

    } catch (err) { console.error("Bad word delete error:", err); }
    return;
  }
  // ========== Commands ==========
  const OWNER_ID = '541763571357319168';
  const isOwner = message.author.id === OWNER_ID;

  const accessAllowed = async () => {
    if (isOwner) return true;

    const res = await db.query('SELECT 1 FROM authorized_users WHERE user_id = $1 LIMIT 1', [message.author.id]);
    return res.rowCount > 0;
  };

  const allowed = await accessAllowed();
  if (!allowed && message.content.startsWith('!')) {
    return message.reply('❌ You are not authorized to use this bot.');
  }

  const args = message.content.trim().split(/\s+/);


  if (args[0] === '!generate') {
    const prompt = args.slice(1).join(' ').trim();

    if (!prompt) {
      return message.reply('❌ Please provide a prompt.\nExample: `!generate cyberpunk cat playing piano`');
    }

    try {
      await message.channel.send('🎨 Generating image, please wait...');

      const response = await fetch('https://router.huggingface.co/nebius/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'stability-ai/sdxl',
          prompt,
          parameters: { num_inference_steps: 5 },
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error('❌ HuggingFace API Error:', error);
        return message.reply(`❌ API Error: ${error?.detail?.[0]?.msg || 'Image generation failed'}`);
      }

      const result = await response.json();
      const imageUrl = result.data?.[0]?.url;

      if (!imageUrl) {
        console.error('🎯 Hugging Face API result:', result);
        return message.reply('❌ No image URL returned from the API.');
      }

      message.channel.send({
        content: `🖼️ Generated image for: **${prompt}**`,
        files: [imageUrl],
      });
    } catch (err) {
      console.error('❌ Error during image generation:', err);
      message.reply('❌ Failed to generate image.');
    }

    return;
  }

  // ===== Log channel command =====
  if (args[0] === '!setlogchannel') {
    const mentionedChannel = message.mentions.channels.first();
    if (!mentionedChannel) {
      return message.reply('❌ Please mention a valid channel. Example: `!setlogchannel #mod-logs`');
    }

    try {
      await db.query(
        `INSERT INTO log_channel_settings (guild_id, channel_id)
        VALUES ($1, $2)
        ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
                     [message.guild.id, mentionedChannel.id]
      );
      message.reply(`✅ Log channel has been set to ${mentionedChannel}.`);
    } catch (err) {
      console.error('❌ DB Error (setlogchannel):', err);
      message.reply('❌ Failed to set log channel.');
    }
    return;
  }

  // ===== Show log channel =====
  if (args[0] === '!showlogchannel') {
    try {
      const result = await db.query(
        `SELECT channel_id FROM log_channel_settings WHERE guild_id = $1`,
        [message.guild.id]
      );

      if (result.rows.length === 0) {
        return message.reply('ℹ️ No log channel has been set for this server.');
      }

      const channel = message.guild.channels.cache.get(result.rows[0].channel_id);
      if (!channel) {
        return message.reply('⚠️ The log channel set in the database no longer exists.');
      }

      message.reply(`📋 Current log channel: <#${channel.id}>`);
    } catch (err) {
      console.error('❌ DB Error (showlogchannel):', err);
      message.reply('❌ Failed to fetch log channel.');
    }
    return;
  }

  // ===== Remove log channel =====
  if (args[0] === '!removelogchannel') {
    try {
      await db.query(
        `DELETE FROM log_channel_settings WHERE guild_id = $1`,
        [message.guild.id]
      );
      message.reply('🗑️ Log channel setting has been removed.');
    } catch (err) {
      console.error('❌ DB Error (removelogchannel):', err);
      message.reply('❌ Failed to remove log channel.');
    }
    return;
  }

  // Add to the command handler (inside messageCreate):
   if (args[0] === '!mute') {
     if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return message.reply('❌ You need **Moderate Members** permission.');
     }

     const userMention = message.mentions.users.first();
     const timeArg = args[2];
     const reason = args.slice(3).join(' ') || 'No reason';

      if (!userMention || !timeArg) {
        return message.reply('Usage: `!mute @user 10m reason`');
      }

      const durationMs = parseDuration(timeArg);
      if (!durationMs) return message.reply('❌ Invalid time. Use formats like 10m, 1h, 1d');
      const member = await message.guild.members.fetch(userMention.id);
      const muteRole = message.guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
      if (!muteRole) return message.reply('❌ Could not find a role named `muted`.');

     await member.roles.add(muteRole);

     const unmuteAt = new Date(Date.now() + durationMs);
     await db.query(
       'INSERT INTO muted_users (guild_id, user_id, muted_by, unmute_at) VALUES ($1, $2, $3, $4)',
       [message.guild.id, userMention.id, message.author.id, unmuteAt]
     );
     await logModerationAction(userMention, 'mute', reason, message);
     message.reply(`🔇 ${userMention.tag} has been muted for ${timeArg}.`);
   }

  if (args[0] === '!allow' && isOwner) {
    const userMention = message.mentions.users.first();
    if (!userMention) return message.reply('Usage: `!allow @user`');

    try {
      await db.query(
        'INSERT INTO authorized_users (user_id, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                     [userMention.id, message.author.id]
      );
      message.reply(`✅ Authorized ${userMention.tag} to use the bot.`);
    } catch (err) {
      console.error('❌ DB Error (allow):', err);
      message.reply('❌ Failed to authorize user.');
    }
  }

  if (args[0] === '!warn') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return message.reply('❌ You need **Moderate Members** permission.');
    }

    const userMention = message.mentions.users.first();
    const reason = args.slice(2).join(' ') || 'No reason';

    if (!userMention) {
      return message.reply('Usage: `!warn @user reason`');
    }

    try {
      await db.query(
        'INSERT INTO user_warnings (guild_id, user_id, warned_by, reason) VALUES ($1, $2, $3, $4)',
                     [message.guild.id, userMention.id, message.author.id, reason]
      );

      await logModerationAction(userMention, 'warn', reason, message);
      message.reply(`⚠️ ${userMention.tag} has been warned. Reason: ${reason}`);
    } catch (err) {
      console.error('❌ DB Error (warn):', err);
      message.reply('❌ Failed to warn user.');
    }
  }


  if (args[0] === '!warnings') {
    const userMention = message.mentions.users.first();
    if (!userMention) {
      return message.reply('Usage: `!warnings @user`');
    }

    try {
      const { rows } = await db.query(
        'SELECT reason, warned_by, created_at FROM user_warnings WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 10',
        [message.guild.id, userMention.id]
      );

      if (rows.length === 0) {
        return message.reply(`✅ ${userMention.tag} has no warnings.`);
      }

      const formattedWarnings = rows.map((w, i) => {
        const mod = `<@${w.warned_by}>`;
        const time = new Date(w.created_at).toLocaleString();
        return `**${i + 1}.** Warned by ${mod} on ${time} — *${w.reason}*`;
      }).join('\n');

      message.reply(`📄 Warnings for **${userMention.tag}**:\n\n${formattedWarnings}`);
    } catch (err) {
      console.error('❌ DB Error (warnings):', err);
      message.reply('❌ Failed to fetch warnings.');
    }
  }

  if (args[0] === '!kick') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return message.reply('❌ You need **Kick Members** permission.');
    }

    const userMention = message.mentions.users.first();
    const reason = args.slice(2).join(' ') || 'No reason';

    if (!userMention) {
      return message.reply('Usage: `!kick @user reason`');
    }

    try {
      const member = await message.guild.members.fetch(userMention.id);
      await member.kick(reason);
      await logModerationAction(userMention, 'kick', reason, message);
      message.reply(`👢 Kicked ${userMention.tag}. Reason: ${reason}`);
    } catch (err) {
      console.error('❌ Kick Error:', err);
      message.reply('❌ Failed to kick the user.');
    }
  }

  if (args[0] === '!ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return message.reply('❌ You need **Ban Members** permission.');
    }

    const userMention = message.mentions.users.first();
    const reason = args.slice(2).join(' ') || 'No reason';

    if (!userMention) {
      return message.reply('Usage: `!ban @user reason`');
    }

    try {
      const member = await message.guild.members.fetch(userMention.id);
      await member.ban({ reason });
      await logModerationAction(userMention, 'ban', reason, message);
      message.reply(`🔨 Banned ${userMention.tag}. Reason: ${reason}`);
    } catch (err) {
      console.error('❌ Ban Error:', err);
      message.reply('❌ Failed to ban the user.');
    }
  }

  if (args[0] === '!unmute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return message.reply('❌ You need **Moderate Members** permission.');
    }

    const userMention = message.mentions.users.first();
    const reason = args.slice(2).join(' ') || 'No reason';

    if (!userMention) {
      return message.reply('Usage: `!unmute @user reason`');
    }

    try {
      const member = await message.guild.members.fetch(userMention.id);
      const muteRole = message.guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
      if (!muteRole) return message.reply('❌ Could not find a role named `muted`.');

      await member.roles.remove(muteRole);
      await db.query(
        'DELETE FROM muted_users WHERE guild_id = $1 AND user_id = $2',
        [message.guild.id, userMention.id]
      );
      await logModerationAction(userMention, 'unmute', reason, message);
      message.reply(`🔈 ${userMention.tag} has been unmuted.`);
    } catch (err) {
      console.error('❌ Unmute Error:', err);
      message.reply('❌ Failed to unmute the user.');
    }
  }

  if (args[0] === '!unban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return message.reply('❌ You need **Ban Members** permission.');
    }

    const userId = args[1];
    const reason = args.slice(2).join(' ') || 'No reason';

    if (!userId || isNaN(userId)) {
      return message.reply('Usage: `!unban <userID> reason`');
    }

    try {
      await message.guild.bans.fetch(); // ensure the cache is populated
      await message.guild.members.unban(userId, reason);

      const fakeUser = { id: userId, tag: `User#${userId.slice(-4)}` }; // placeholder
      await logModerationAction(fakeUser, 'unban', reason, message);

      message.reply(`✅ Unbanned user with ID: ${userId}`);
    } catch (err) {
      console.error('❌ Unban Error:', err);
      message.reply('❌ Failed to unban the user. Make sure the ID is correct and the user is banned.');
    }
  }

  if (args[0] === '!disallow' && isOwner) {
    const userMention = message.mentions.users.first();
    if (!userMention) return message.reply('Usage: `!disallow @user`');

    try {
      await db.query('DELETE FROM authorized_users WHERE user_id = $1', [userMention.id]);
      message.reply(`✅ Revoked access from ${userMention.tag}.`);
    } catch (err) {
      console.error('❌ DB Error (disallow):', err);
      message.reply('❌ Failed to remove user access.');
    }
  }

  if (args[0] === '!tagreact') {
    const userMention = message.mentions.users.first();
    const emojiArgs = args.slice(2);

    if (!userMention || emojiArgs.length === 0) {
      return message.reply('Usage: `!tagreact @user 😄 🤖 ...`');
    }

    if (emojiArgs.length > MAX_EMOJIS_PER_USER) {
      return message.reply(`❌ You can only set up to ${MAX_EMOJIS_PER_USER} emojis per user.`);
    }

    try {
      await db.query('DELETE FROM tag_reacts WHERE user_id = $1 AND emoji IS NOT NULL', [userMention.id]);
      for (const emoji of emojiArgs) {
        await db.query('INSERT INTO tag_reacts (user_id, emoji) VALUES ($1, $2)', [userMention.id, emoji]);
      }
      message.reply(`✅ Set tag reactions for ${userMention.tag}: ${emojiArgs.join(' ')}`);
    } catch (err) {
      console.error('❌ DB Error (tagreact):', err);
      message.reply('❌ Failed to save reactions.');
    }
  }

  if (args[0] === '!tagmessage') {
    const userMention = message.mentions.users.first();
    const msg = args.slice(2).join(' ');

    if (!userMention || !msg) {
      return message.reply('Usage: `!tagmessage @user Your message here`');
    }

    try {
      await db.query(`
      INSERT INTO tag_reacts (user_id, emoji, custom_message)
      VALUES ($1, NULL, $2)
      ON CONFLICT (user_id, emoji) DO UPDATE SET custom_message = EXCLUDED.custom_message
      `, [userMention.id, msg]);

      message.reply(`✅ Set custom tag message for ${userMention.tag}: "${msg}"`);
    } catch (err) {
      console.error('❌ DB Error (tagmessage):', err);
      message.reply('❌ Failed to save custom message.');
    }
  }

  if (args[0] === '!removeTagMessage') {
    const userMention = message.mentions.users.first();
    if (!userMention) {
      return message.reply('Usage: `!removeTagMessage @user`');
    }

    try {
      await db.query('DELETE FROM tag_reacts WHERE user_id = $1 AND emoji IS NULL', [userMention.id]);
      message.reply(`✅ Removed custom message for ${userMention.tag}.`);
    } catch (err) {
      console.error('❌ DB Error (removeTagMessage):', err);
      message.reply('❌ Failed to remove custom message.');
    }
  }

  if (args[0] === '!taglist') {
    try {
      const res = await db.query('SELECT user_id, emoji, custom_message FROM tag_reacts ORDER BY user_id');
      if (res.rowCount === 0) return message.reply('📭 No tag reactions or messages found.');

      const map = new Map();

      for (const row of res.rows) {
        const key = row.user_id;
        if (!map.has(key)) map.set(key, { emojis: [], message: null });
        if (row.emoji) map.get(key).emojis.push(row.emoji);
        if (row.custom_message) map.get(key).message = row.custom_message;
      }

      let output = '';
      for (const [userId, { emojis, message }] of map.entries()) {
        const user = await bot.users.fetch(userId).catch(() => null);
        const tag = user ? user.tag : `Unknown (${userId})`;

        output += `👤 **${tag}**\n`;
        if (emojis.length) output += `  🧷 Emojis: ${emojis.join(' ')}\n`;
        if (message) output += `  💬 Message: "${message}"\n`;
        output += '\n';
      }

      const chunks = output.match(/[\s\S]{1,1900}/g) || [];
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    } catch (err) {
      console.error('❌ DB Error (taglist):', err);
      message.reply('❌ Failed to fetch list.');
    }
  }

  if (args[0] === '!addemoji') {
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageEmojisAndStickers)) {
      return message.reply('❌ I need **Manage Emojis and Stickers** permission.');
    }

    const name = args[1];
    const emojiArg = args[2];
    const match = emojiArg?.match(/^<a?:\w+:(\d+)>$/);

    if (!name || !match) {
      return message.reply('Usage: `!addemoji name <:emoji:>`');
    }

    const emojiId = match[1];
    const isAnimated = emojiArg.startsWith('<a:');
    const url = `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}`;

    try {
      const emoji = await message.guild.emojis.create({ name, attachment: url });
      message.reply(`✅ Emoji uploaded: <${isAnimated ? 'a' : ''}:${emoji.name}:${emoji.id}>`);
    } catch (err) {
      console.error('❌ Failed to upload emoji:', err);
      message.reply('❌ Could not upload emoji. Maybe invalid or server is full.');
    }
  }

  // === Auto-react and message when someone is mentioned ===
  for (const [id] of message.mentions.users) {
    try {
      const res = await db.query('SELECT emoji, custom_message FROM tag_reacts WHERE user_id = $1', [id]);

      const emojis = res.rows.map(r => r.emoji).filter(Boolean);
      const messages = res.rows.map(r => r.custom_message).filter(Boolean);

      for (const emoji of emojis) {
        try {
          await message.react(emoji);
        } catch (err) {
          console.error(`❌ Failed to react with ${emoji}:`, err);
        }
      }

      for (const msg of messages) {
        try {
          await message.channel.send(msg);
        } catch (err) {
          console.error('❌ Failed to send custom message:', err);
        }
      }
    } catch (err) {
      console.error('❌ DB Error (mention auto-action):', err);
    }
  }
});

// ========== Bot Login ==========
bot.login(process.env.BOT_TOKEN);
