const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { Client: PgClient } = require('pg');
const http = require('http');
require('dotenv').config();

// ========== Simple HTTP server to keep port open for Render ==========
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is alive!');
}).listen(PORT, () => {
    console.log(`🌐 HTTP server running on port ${PORT}`);
});

// ========== Discord Bot Initialization ==========
const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ========== PostgreSQL Initialization ==========
const db = new PgClient({ connectionString: process.env.DATABASE_URL });
db.connect();

const MAX_EMOJIS_PER_USER = 5;

bot.once('ready', () => {
    console.log(`🤖 Logged in as ${bot.user.tag}`);
});

// ========== Message Event ==========
bot.on('messageCreate', async (message) => {
    const OWNER_ID = '541763571357319168';
    // ========== Global Command Access Check ==========
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

    if (message.author.bot) return;
    const args = message.content.trim().split(/\s+/);


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

    if (args[0] === '!kick') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
            return message.reply('❌ You don’t have permission to kick members.');
        }

        const user = message.mentions.members.first();
        const reason = args.slice(2).join(' ') || 'No reason provided';

        if (!user) return message.reply('Usage: `!kick @user [reason]`');
        if (!user.kickable) return message.reply('❌ I cannot kick this user.');

        try {
            await user.kick(reason);
            await message.reply(`✅ ${user.user.tag} has been kicked. Reason: ${reason}`);
        } catch (err) {
            console.error('❌ Kick error:', err);
            message.reply('❌ Failed to kick the user.');
        }
    }


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

    // === !tagmessage @user Your message here ===
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

    // === !removeTagMessage @user ===
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

    // === !taglist ===
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
