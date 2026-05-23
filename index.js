const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits,
        EmbedBuilder, ActivityType, MessageFlags, ActionRowBuilder,
        ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder } = require('discord.js');
const { Pool } = require('pg');
const dns = require('dns'); dns.setDefaultResultOrder('ipv4first');
const http = require('http');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── DB ───────────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS counting (
            guild_id TEXT PRIMARY KEY,
            data JSONB NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS user_stats (
            guild_id TEXT NOT NULL,
            user_id  TEXT NOT NULL,
            data     JSONB NOT NULL DEFAULT '{}',
            PRIMARY KEY (guild_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS user_stats_user ON user_stats(user_id);
    `);
}

const stateCache = new Map();

async function getState(guildId) {
    if (stateCache.has(guildId)) return stateCache.get(guildId);
    const res = await pool.query('SELECT data FROM counting WHERE guild_id = $1', [guildId]);
    const data = res.rows[0]?.data ?? defaultState();
    stateCache.set(guildId, data);
    return data;
}

function saveState(guildId, data) {
    stateCache.set(guildId, data);
    pool.query(
        'INSERT INTO counting (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET data = $2',
        [guildId, data]
    ).catch(e => console.error('saveState:', e.message));
}

function defaultState() {
    return {
        channelId: null,
        current: 0,
        lastUserId: null,
        consecutiveCount: 0,
        maxStreak: 1,
        allowExpressions: true,
        highScore: 0,
        accessRoleId: null,
    };
}

// ── Stats ────────────────────────────────────────────────────────────────────
async function updateUserStat(guildId, userId, delta) {
    try {
        const res = await pool.query('SELECT data FROM user_stats WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
        const cur = res.rows[0]?.data ?? { correct: 0, ruined: 0 };
        for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + v;
        await pool.query(
            'INSERT INTO user_stats (guild_id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO UPDATE SET data = $3',
            [guildId, userId, cur]
        );
    } catch (e) { console.error('updateUserStat:', e.message); }
}

async function getUserStats(guildId, userId) {
    const res = await pool.query('SELECT data FROM user_stats WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    return res.rows[0]?.data ?? { correct: 0, ruined: 0 };
}

async function getUserRank(guildId, userId) {
    const res = await pool.query(`
        SELECT COUNT(*) + 1 AS rank FROM user_stats
        WHERE guild_id = $1
          AND COALESCE((data->>'correct')::int, 0) > COALESCE(
              (SELECT (data->>'correct')::int FROM user_stats WHERE guild_id = $1 AND user_id = $2), 0
          )
    `, [guildId, userId]);
    return parseInt(res.rows[0]?.rank ?? 1);
}

async function getServerLeaderboard(guildId) {
    const res = await pool.query(`
        SELECT user_id, data FROM user_stats
        WHERE guild_id = $1
        ORDER BY COALESCE((data->>'correct')::int, 0) DESC
        LIMIT 10
    `, [guildId]);
    return res.rows;
}

async function getGlobalLeaderboard() {
    const res = await pool.query(`
        SELECT user_id,
               SUM(COALESCE((data->>'correct')::int, 0)) AS correct,
               SUM(COALESCE((data->>'ruined')::int,  0)) AS ruined
        FROM user_stats
        GROUP BY user_id
        ORDER BY correct DESC
        LIMIT 10
    `);
    return res.rows;
}

// ── Safe math evaluator ──────────────────────────────────────────────────────
const CONSTANTS = {
    phi:   (1 + Math.sqrt(5)) / 2,
    pi:    Math.PI,
    e:     Math.E,
    tau:   Math.PI * 2,
    sqrt2: Math.SQRT2,
};

function safeMath(expr) {
    let cleaned = expr.trim().toLowerCase().replace(/\s+/g, '');
    if (!cleaned) return null;
    for (const [name, val] of Object.entries(CONSTANTS))
        cleaned = cleaned.replaceAll(name, `(${val})`);
    if (!/^[\d.+\-*/^()]+$/.test(cleaned)) return null;
    const safe = cleaned.replace(/\^/g, '**');
    if (/\*\*\s*\d{4,}/.test(safe)) return null;
    try {
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + safe + ')')();
        if (typeof result !== 'number' || !isFinite(result) || isNaN(result)) return null;
        return Math.round(result);
    } catch { return null; }
}

// ── Expression generator ─────────────────────────────────────────────────────
function generateExpressions(n) {
    const candidates = [];
    const phi = (1 + Math.sqrt(5)) / 2;
    const consts = [['phi', phi], ['pi', Math.PI], ['e', Math.E], ['sqrt2', Math.SQRT2], ['tau', Math.PI * 2]];

    for (let base = 2; base <= 50; base++)
        for (let exp = 2; exp <= 8; exp++)
            if (Math.pow(base, exp) === n) candidates.push(`${base}^${exp}`);

    for (const [name, val] of consts) {
        for (let exp = 1; exp <= 20; exp++)
            if (Math.round(Math.pow(val, exp)) === n) { candidates.push(`${name}^${exp}`); break; }
        for (let exp = 1; exp <= 10; exp++) {
            const base = Math.round(Math.pow(val, exp));
            const diff = n - base;
            if (diff !== 0 && Math.abs(diff) <= 20)
                candidates.push(`${name}^${exp}${diff > 0 ? '+' + diff : diff}`);
        }
    }

    if (n > 4) for (let a = 2; a <= Math.sqrt(n); a++) if (n % a === 0) { candidates.push(`${a}*${n/a}`); break; }

    if (n > 8) {
        outer: for (let a = 2; a <= Math.cbrt(n); a++) if (n % a === 0) {
            const rest = n / a;
            for (let b = a; b <= Math.sqrt(rest); b++)
                if (rest % b === 0) { candidates.push(`${a}*${b}*${rest/b}`); break outer; }
        }
    }

    if (n > 2) { const a = Math.max(1, Math.floor(n * 0.35)); candidates.push(`${a}+${n-a}`); }
    candidates.push(`${n + Math.round(n * 0.6) + 1}-${Math.round(n * 0.6) + 1}`);
    candidates.push(`${n * (n <= 10 ? 2 : 3)}/${n <= 10 ? 2 : 3}`);
    if (n > 5) for (let a = 2; a <= 10; a++) {
        const base = Math.floor(n/a)*a, diff = n - base;
        if (base > 0 && diff > 0 && diff < a) { candidates.push(`${a}*${Math.floor(n/a)}+${diff}`); break; }
    }

    const seen = new Set(), result = [];
    for (const c of candidates.sort((a, b) => (/[a-z]/.test(b) ? 1 : 0) - (/[a-z]/.test(a) ? 1 : 0) || a.length - b.length))
        if (!seen.has(c) && result.length < 3) { seen.add(c); result.push(c); }

    if (result.length < 3) result.push(`${n-1}+1`);
    if (result.length < 3) result.push(`${n*2}/2`);
    if (result.length < 3) result.push(`${n+3}-3`);
    return result.slice(0, 3);
}

// ── Help pages ───────────────────────────────────────────────────────────────
function buildHelpPage(page) {
    const titles = ['🎮 How to Play', '📋 Commands', '⚙️ Config & Admin', '🧮 Expressions'];
    const embeds = [
        new EmbedBuilder().setColor('#5865F2').setTitle(titles[0])
            .setDescription('Count up together in the counting channel! One number at a time — anyone who breaks the chain resets it back to 1.')
            .addFields(
                { name: '📌 Rules', value: '• Type the next number in the sequence\n• You can\'t count twice in a row (by default)\n• Wrong number? The count resets to 1!\n• Math expressions like `2+2`, `pi^2` are supported' },
                { name: '✅ Correct count', value: 'React gets added, count goes up' },
                { name: '❌ Wrong / too fast', value: 'Count resets — everyone starts over!' },
                { name: '🏆 Milestones', value: 'The bot celebrates every 100 counts' }
            ).setFooter({ text: 'Page 1/4 • Counting Bot' }),

        new EmbedBuilder().setColor('#5865F2').setTitle(titles[1])
            .setDescription('All available commands:')
            .addFields(
                { name: '🔢 Counting', value: '`/counting channel` — set the counting channel\n`/counting status` — view current count & settings\n`/counting reset` — reset the count *(requires permission)*' },
                { name: '📊 Stats & Leaderboards', value: '`/stats [user]` — view counting stats for you or someone else\n`/leaderboard server` — top counters in this server\n`/leaderboard global` — top counters across all servers' },
                { name: '🛠️ Utilities', value: '`/calculate <number>` — get 3 expressions for any number\n`/invite` — get the bot invite link\n`/help` — this menu' }
            ).setFooter({ text: 'Page 2/4 • Counting Bot' }),

        new EmbedBuilder().setColor('#5865F2').setTitle(titles[2])
            .setDescription('Admin & configuration commands. Requires **Administrator** or the configured access role.')
            .addFields(
                { name: '⚙️ /config maxstreak <n>', value: 'How many times one person can count in a row (1–20). Default: **1**' },
                { name: '⚙️ /config expressions <bool>', value: 'Allow or block math expressions. Default: **enabled**' },
                { name: '🔒 /config access', value: 'Pick a role that can use config commands. Admins always have access.' },
                { name: '📍 /counting channel', value: 'Set or change the counting channel.' },
                { name: '🔄 /counting reset', value: 'Manually reset the count back to 0.' }
            ).setFooter({ text: 'Page 3/4 • Counting Bot' }),

        new EmbedBuilder().setColor('#5865F2').setTitle(titles[3])
            .setDescription('When expressions are enabled, you can type math instead of plain numbers. The result is **rounded** to the nearest whole number.')
            .addFields(
                { name: '➕ Operators', value: '`+` add  •  `-` subtract  •  `*` multiply  •  `/` divide  •  `^` power' },
                { name: '📐 Constants', value: '`pi` ≈ 3.14159\n`phi` ≈ 1.61803 *(golden ratio)*\n`e` ≈ 2.71828\n`tau` ≈ 6.28318\n`sqrt2` ≈ 1.41421' },
                { name: '💡 Examples', value: '`2+2` → **4**\n`pi^2` → **10**\n`phi^10` → **11**\n`phi+phi^pi+pi` → **9**\n`2^8` → **256**' },
                { name: '🧮 /calculate', value: 'Use `/calculate <number>` to get 3 ready-made expressions for any number!' }
            ).setFooter({ text: 'Page 4/4 • Counting Bot' }),
    ];

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_1').setLabel('How to Play').setStyle(page === 1 ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_2').setLabel('Commands').setStyle(page === 2 ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_3').setLabel('Config').setStyle(page === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_4').setLabel('Expressions').setStyle(page === 4 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    return { embeds: [embeds[page - 1]], components: [row] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function E(color, title) { return new EmbedBuilder().setColor(color).setTitle(title); }

async function hasPermission(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const state = await getState(guildId);
    return state.accessRoleId ? interaction.member.roles.cache.has(state.accessRoleId) : false;
}

// ── Keep-alive ───────────────────────────────────────────────────────────────
function keepAlive() {
    const ping = () => {
        const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        const mod = url.startsWith('https') ? require('https') : http;
        mod.get(url, () => {}).on('error', () => {});
    };
    setTimeout(ping, 5000);
    setInterval(ping, 14 * 60 * 1000);
}

// ── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`✅ Counting bot online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Counting things', type: ActivityType.Watching }], status: 'online' });

    const commands = [
        new SlashCommandBuilder().setName('counting').setDescription('Configure or view the counting game')
            .addSubcommand(s => s.setName('channel').setDescription('Set the counting channel')
                .addChannelOption(o => o.setName('channel').setDescription('The channel to use for counting').setRequired(true)))
            .addSubcommand(s => s.setName('status').setDescription('View the current count and settings'))
            .addSubcommand(s => s.setName('reset').setDescription('Manually reset the count to 0')),

        new SlashCommandBuilder().setName('config').setDescription('Configure bot settings')
            .addSubcommand(s => s.setName('maxstreak').setDescription('How many counts one person can do in a row (default: 1)')
                .addIntegerOption(o => o.setName('amount').setDescription('Max consecutive counts per user (1–20)').setRequired(true).setMinValue(1).setMaxValue(20)))
            .addSubcommand(s => s.setName('expressions').setDescription('Allow or disallow math expressions like 1+1')
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable expressions').setRequired(true)))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can use config commands (admins always have access)')),

        new SlashCommandBuilder().setName('leaderboard').setDescription('View counting leaderboards')
            .addSubcommand(s => s.setName('server').setDescription('Top counters in this server'))
            .addSubcommand(s => s.setName('global').setDescription('Top counters across all servers')),

        new SlashCommandBuilder().setName('stats').setDescription('View counting stats for a user')
            .addUserOption(o => o.setName('user').setDescription('User to check (defaults to yourself)')),

        new SlashCommandBuilder().setName('calculate').setDescription('Get 3 ways to write a number using math expressions')
            .addIntegerOption(o => o.setName('number').setDescription('The number to express').setRequired(true).setMinValue(1).setMaxValue(100000)),

        new SlashCommandBuilder().setName('invite').setDescription('Get a link to invite this bot to your server'),
        new SlashCommandBuilder().setName('help').setDescription('View all commands and features'),
    ].map(c => c.toJSON());

    await client.application.commands.set(commands);
    console.log('✅ Commands registered');

    try {
        await initDB();
        const res = await pool.query('SELECT guild_id, data FROM counting');
        for (const { guild_id, data } of res.rows) stateCache.set(guild_id, data);
        console.log(`✅ Loaded state for ${res.rows.length} guild(s)`);
    } catch (e) { console.error('❌ DB init failed:', e.message); }

    keepAlive();
});

// ── Message counting ──────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    const guildId = message.guild.id;
    const state = await getState(guildId).catch(() => null);
    if (!state?.channelId || message.channel.id !== state.channelId) return;

    const raw = message.content.trim();
    const hasConst = Object.keys(CONSTANTS).some(c => raw.toLowerCase().includes(c));
    const isExpression = (/[+\-*/^()]/.test(raw) && !/^\-?\d+$/.test(raw)) || hasConst;

    if (isExpression && !state.allowExpressions) {
        await message.react('❌').catch(() => {});
        const sent = await message.channel.send({
            embeds: [E('#ff4444', '❌ Expressions disabled')
                .setDescription(`Expressions like \`${raw}\` are not allowed here. Just type the plain number!`)]
        }).catch(() => null);
        if (sent) setTimeout(() => sent.delete().catch(() => {}), 5000);
        return;
    }

    const value = safeMath(raw);
    if (value === null) return;

    const expected = state.current + 1;

    // ── Wrong number ─────────────────────────────────────────────────────────
    if (value !== expected) {
        await message.react('❌').catch(() => {});
        const prev = state.current;
        state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
        saveState(guildId, state);
        updateUserStat(guildId, message.author.id, { ruined: 1 });
        await message.channel.send({
            embeds: [E('#ff4444', '💥 Count ruined!')
                .setDescription(`<@${message.author.id}> ruined the count at **${prev}**!\nThe next number was \`${expected}\`, but \`${value}\` was sent.`)
                .addFields({ name: '🔄 Reset to', value: '**1**', inline: true }, { name: '🏆 High Score', value: `**${state.highScore}**`, inline: true })
                .setFooter({ text: 'Start again from 1!' })]
        }).catch(() => {});
        return;
    }

    // ── Consecutive count violation ───────────────────────────────────────────
    if (state.maxStreak > 0 && message.author.id === state.lastUserId && state.consecutiveCount >= state.maxStreak) {
        await message.react('❌').catch(() => {});
        const prev = state.current;
        state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
        saveState(guildId, state);
        updateUserStat(guildId, message.author.id, { ruined: 1 });
        await message.channel.send({
            embeds: [E('#ff4444', '💥 Count ruined!')
                .setDescription(`<@${message.author.id}> counted too many times in a row (limit: **${state.maxStreak}**)!\nThe count was at **${prev}**.`)
                .addFields({ name: '🔄 Reset to', value: '**1**', inline: true }, { name: '🏆 High Score', value: `**${state.highScore}**`, inline: true })
                .setFooter({ text: 'Let someone else count too!' })]
        }).catch(() => {});
        return;
    }

    // ── Correct count ─────────────────────────────────────────────────────────
    const isSameUser = message.author.id === state.lastUserId;
    state.current = value;
    state.lastUserId = message.author.id;
    state.consecutiveCount = isSameUser ? state.consecutiveCount + 1 : 1;
    if (value > state.highScore) state.highScore = value;
    saveState(guildId, state);
    updateUserStat(guildId, message.author.id, { correct: 1 });

    const numberEmojis = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
    await message.react(value <= 9 ? numberEmojis[value] : '✅').catch(() => {});

    if (value % 100 === 0) {
        await message.channel.send({
            embeds: [E('#00cc88', `🎉 ${value} reached!`)
                .setDescription(`Amazing! The count hit **${value}** thanks to <@${message.author.id}>!`)
                .setFooter({ text: `Keep going! High score: ${state.highScore}` })]
        }).catch(() => {});
    }
});

// ── Interactions ──────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    const guildId = interaction.guild?.id;

    // ── Button: help page navigation ──
    if (interaction.isButton()) {
        if (!interaction.customId.startsWith('help_')) return;
        const page = parseInt(interaction.customId.split('_')[1]);
        if (isNaN(page) || page < 1 || page > 4) return;
        return interaction.update(buildHelpPage(page));
    }

    // ── Role select: config access ──
    if (interaction.isRoleSelectMenu()) {
        if (!interaction.customId.startsWith('access_role_')) return;
        const roleId = interaction.values[0];
        const state = await getState(guildId);
        state.accessRoleId = roleId;
        saveState(guildId, state);
        return interaction.update({
            embeds: [E('#5865F2', '✅ Access role updated').setDescription(`<@&${roleId}> can now use config commands.`)],
            components: []
        });
    }

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return interaction.reply({ content: '❌ This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });

    const { commandName, options } = interaction;

    try {

        // ── /help ─────────────────────────────────────────────────────────────
        if (commandName === 'help')
            return interaction.reply({ ...buildHelpPage(1), flags: [MessageFlags.Ephemeral] });

        // ── /invite ───────────────────────────────────────────────────────────
        if (commandName === 'invite') {
            const url = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=76864&scope=bot%20applications.commands`;
            return interaction.reply({
                embeds: [E('#5865F2', '📨 Invite Counting Bot')
                    .setDescription(`[**Click here to invite me to your server!**](${url})`)
                    .addFields({ name: '🔐 Permissions requested', value: '• View Channels\n• Send Messages\n• Add Reactions\n• Read Message History\n• Manage Messages' })
                    .setFooter({ text: 'After inviting, use /counting channel to set up!' })],
                flags: [MessageFlags.Ephemeral]
            });
        }

        // ── /calculate ────────────────────────────────────────────────────────
        if (commandName === 'calculate') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const n = options.getInteger('number');
            const exprs = generateExpressions(n);
            return interaction.editReply({
                embeds: [E('#5865F2', `🧮 Ways to write ${n}`)
                    .setDescription(`Here are 3 expressions you can use to count **${n}** in the counting channel:`)
                    .addFields(...exprs.map((expr, i) => ({
                        name: `${ ['1️⃣','2️⃣','3️⃣'][i] }  \`${expr}\``,
                        value: `= **${safeMath(expr) ?? n}**`,
                        inline: true,
                    })))
                    .setFooter({ text: 'Supports: + - * / ^ pi phi e tau sqrt2' })]
            });
        }

        // ── /stats ────────────────────────────────────────────────────────────
        if (commandName === 'stats') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const target = options.getUser('user') ?? interaction.user;
            const [stats, rank, state] = await Promise.all([
                getUserStats(guildId, target.id),
                getUserRank(guildId, target.id),
                getState(guildId),
            ]);
            const total = (stats.correct || 0) + (stats.ruined || 0);
            const accuracy = total > 0 ? Math.round((stats.correct / total) * 100) : 100;
            return interaction.editReply({
                embeds: [E('#5865F2', `📊 Stats — ${target.username}`)
                    .setThumbnail(target.displayAvatarURL())
                    .addFields(
                        { name: '✅ Correct counts',     value: `**${stats.correct ?? 0}**`,  inline: true },
                        { name: '💥 Times ruined',       value: `**${stats.ruined  ?? 0}**`,  inline: true },
                        { name: '🎯 Accuracy',           value: `**${accuracy}%**`,           inline: true },
                        { name: '🏅 Server rank',        value: `**#${rank}**`,               inline: true },
                        { name: '🔢 Current count',      value: `**${state.current}**`,       inline: true },
                        { name: '🏆 Server high score',  value: `**${state.highScore}**`,     inline: true },
                    )]
            });
        }

        // ── /leaderboard ──────────────────────────────────────────────────────
        if (commandName === 'leaderboard') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const sub = options.getSubcommand();
            const medals = ['🥇', '🥈', '🥉'];

            if (sub === 'server') {
                const rows = await getServerLeaderboard(guildId);
                if (!rows.length) return interaction.editReply({ content: '📊 No stats yet — start counting!' });
                const lines = rows.map((r, i) =>
                    `${medals[i] ?? `**${i+1}.**`} <@${r.user_id}> — **${r.data.correct ?? 0}** counts${r.data.ruined ? ` *(${r.data.ruined} ruined)*` : ''}`
                );
                return interaction.editReply({
                    embeds: [E('#5865F2', '🏆 Server Leaderboard')
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: `Top ${rows.length} counters in this server` })]
                });
            }

            if (sub === 'global') {
                const rows = await getGlobalLeaderboard();
                if (!rows.length) return interaction.editReply({ content: '📊 No global stats yet!' });
                const lines = rows.map((r, i) =>
                    `${medals[i] ?? `**${i+1}.**`} <@${r.user_id}> — **${parseInt(r.correct)}** counts across all servers`
                );
                return interaction.editReply({
                    embeds: [E('#5865F2', '🌍 Global Leaderboard')
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: `Top ${rows.length} counters globally` })]
                });
            }
        }

        // ── /config ───────────────────────────────────────────────────────────
        if (commandName === 'config') {
            const sub = options.getSubcommand();

            if (sub === 'access') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                    return interaction.reply({ content: '❌ Only server administrators can change the access role.', flags: [MessageFlags.Ephemeral] });
                const state = await getState(guildId);
                return interaction.reply({
                    embeds: [E('#5865F2', '🔒 Access Configuration')
                        .setDescription('Select which role can use `/config` commands.\n\n**Note:** Server administrators always have access regardless.')
                        .addFields({ name: 'Current access role', value: state.accessRoleId ? `<@&${state.accessRoleId}>` : 'None *(admins only)*' })],
                    components: [new ActionRowBuilder().addComponents(
                        new RoleSelectMenuBuilder()
                            .setCustomId(`access_role_${guildId}`)
                            .setPlaceholder('Select a role for config access')
                            .setMinValues(1).setMaxValues(1)
                    )],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            if (!await hasPermission(interaction, guildId))
                return interaction.reply({ content: '❌ You don\'t have permission to use config commands.', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const state = await getState(guildId);

            if (sub === 'maxstreak') {
                const amount = options.getInteger('amount');
                state.maxStreak = amount;
                saveState(guildId, state);
                return interaction.editReply({
                    embeds: [E('#5865F2', '✅ Max streak updated')
                        .setDescription(amount === 1
                            ? 'Users can no longer count twice in a row.'
                            : `Users can now count **${amount}** times in a row before someone else must count.`)]
                });
            }

            if (sub === 'expressions') {
                const enabled = options.getBoolean('enabled');
                state.allowExpressions = enabled;
                saveState(guildId, state);
                return interaction.editReply({
                    embeds: [E('#5865F2', `✅ Expressions ${enabled ? 'enabled' : 'disabled'}`)
                        .setDescription(enabled
                            ? 'Users can now count with expressions like `1+1`, `3*4`, `2^3`, etc.'
                            : 'Only plain numbers are now accepted in the counting channel.')]
                });
            }
        }

        // ── /counting ─────────────────────────────────────────────────────────
        if (commandName === 'counting') {
            const sub = options.getSubcommand();

            if (sub === 'status') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const state = await getState(guildId);
                return interaction.editReply({
                    embeds: [E('#5865F2', '📊 Counting Status').addFields(
                        { name: '📍 Channel',       value: state.channelId ? `<#${state.channelId}>` : 'Not set',            inline: true },
                        { name: '🔢 Current count', value: `**${state.current}**`,                                            inline: true },
                        { name: '🏆 High score',    value: `**${state.highScore}**`,                                          inline: true },
                        { name: '🔁 Max streak',    value: `**${state.maxStreak}** in a row`,                                 inline: true },
                        { name: '🧮 Expressions',   value: state.allowExpressions ? '✅ Allowed' : '❌ Disabled',             inline: true },
                        { name: '👤 Last counter',  value: state.lastUserId ? `<@${state.lastUserId}>` : 'Nobody yet',        inline: true },
                    )]
                });
            }

            if (!await hasPermission(interaction, guildId))
                return interaction.reply({ content: '❌ You don\'t have permission to use this command.', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const state = await getState(guildId);

            if (sub === 'channel') {
                const ch = options.getChannel('channel');
                if (!ch.isTextBased()) return interaction.editReply({ content: '❌ Please select a text channel.' });
                state.channelId = ch.id;
                saveState(guildId, state);
                return interaction.editReply({
                    embeds: [E('#5865F2', '✅ Counting channel set')
                        .setDescription(`The counting channel has been set to ${ch}.\nStart counting from **1**!`)]
                });
            }

            if (sub === 'reset') {
                const prev = state.current;
                state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
                saveState(guildId, state);
                if (state.channelId) {
                    const ch = interaction.guild.channels.cache.get(state.channelId);
                    if (ch) ch.send({
                        embeds: [E('#ff9900', '🔄 Count manually reset')
                            .setDescription(`An admin reset the count from **${prev}** back to 0.\nStart again from **1**!`)]
                    }).catch(() => {});
                }
                return interaction.editReply({ content: `✅ Count reset from **${prev}** to 0.` });
            }
        }

    } catch (error) {
        if (error?.code === 40060) return;
        console.error('❌ Interaction error:', error);
        try {
            const msg = { content: '❌ Something went wrong. Please try again.', flags: [MessageFlags.Ephemeral] };
            if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
            else if (!interaction.replied) await interaction.reply(msg).catch(() => {});
        } catch {}
    }
});

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e));
client.on('error', e => console.error('⚠️ Discord client error:', e));
client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const ok = req.url === '/' || req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(ok ? 'Counting bot is running!' : 'Not found');
}).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));
