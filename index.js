const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { Client: PgClient } = require('pg');
require('dotenv').config();

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const db = new PgClient({ connectionString: process.env.DATABASE_URL });
db.connect();

const MAX_EMOJIS_PER_USER = 5;

bot.once('ready', () => {
  console.log(`🤖 Logged in as ${bot.user.tag}`);
});

bot.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const args = message.content.trim().split(/\s+/);

  // === !tagreact @user 😀 😂 ===
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

  // === !tagmessage @user your custom message ===
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
      ON CONFLICT (user_id, emoji) DO UPDATE SET custom_message = $2
      `, [userMention.id, msg]);

      message.reply(`✅ Set custom tag message for ${userMention.tag}: "${msg}"`);
    } catch (err) {
      console.error('❌ DB Error (tagmessage):', err);
      message.reply('❌ Failed to save custom message.');
    }
  }

  // === !removeTagMessage @user ===
  if (args[0] === '!removeTagMessage') {
    const userMention = message.mentions.users.first();

    if (!userMention) {
      return message.reply('Usage: `!removeTagMessage @user`');
    }

    try {
      await db.query(`
      DELETE FROM tag_reacts
      WHERE user_id = $1 AND emoji IS NULL
      `, [userMention.id]);

      message.reply(`✅ Removed custom message for ${userMention.tag}.`);
    } catch (err) {
      console.error('❌ DB Error (removeTagMessage):', err);
      message.reply('❌ Failed to remove custom message.');
    }
  }

  // === !taglist ===
  if (args[0] === '!taglist') {
    try {
      const res = await db.query('SELECT user_id, emoji, custom_message FROM tag_reacts ORDER BY user_id');

      if (res.rowCount === 0) {
        return message.reply('📭 No tag reactions or messages found.');
      }

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
        const tag = user ? user.tag : userId;

        output += `👤 **${tag}**\n`;
        if (emojis.length) output += `  🧷 Emojis: ${emojis.join(' ')}\n`;
        if (message) output += `  💬 Message: "${message}"\n`;
        output += '\n';
      }

      message.reply({ content: output.slice(0, 2000) || '📭 Nothing found.' });
    } catch (err) {
      console.error('❌ DB Error (taglist):', err);
      message.reply('❌ Failed to fetch list.');
    }
  }

  // === !addemoji name <:custom_emoji:> ===
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
      return message.reply(`✅ Emoji uploaded: <${isAnimated ? 'a' : ''}:${emoji.name}:${emoji.id}>`);
    } catch (err) {
      console.error('❌ Failed to upload emoji:', err);
      return message.reply('❌ Could not upload emoji. Maybe invalid or server is full.');
    }
  }

  // === Auto react/message when user is mentioned ===
  for (const [id] of message.mentions.users) {
    try {
      const res = await db.query(
        'SELECT emoji, custom_message FROM tag_reacts WHERE user_id = $1',
        [id]
      );

      const emojis = res.rows.map(r => r.emoji).filter(Boolean);
      const customMessages = res.rows.map(r => r.custom_message).filter(Boolean);

      for (const emoji of emojis) {
        try {
          await message.react(emoji);
        } catch (err) {
          console.error(`❌ Failed to react with ${emoji}:`, err);
        }
      }

      for (const msg of customMessages) {
        try {
          await message.channel.send(msg);
        } catch (err) {
          console.error('❌ Failed to send custom message:', err);
        }
      }
    } catch (err) {
      console.error('❌ DB Error (mention check):', err);
    }
  }
});

bot.login(process.env.BOT_TOKEN);
