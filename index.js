const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits,
        EmbedBuilder, ActivityType, MessageFlags } = require('discord.js');
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

// ── DB ──────────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS counting (
            guild_id TEXT PRIMARY KEY,
            data JSONB NOT NULL DEFAULT '{}'
        );
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
    };
}

// ── Safe math evaluator ─────────────────────────────────────────────────────
// Only allows digits, basic operators, parens, dots — no identifiers/strings
function safeMath(expr) {
    const cleaned = expr.trim().replace(/\s+/g, '');
    if (!cleaned) return null;
    // Whitelist: digits, . + - * / ^ ( )
    if (!/^[\d.+\-*/^()]+$/.test(cleaned)) return null;
    // Replace ^ with ** for JS exponentiation
    const safe = cleaned.replace(/\^/g, '**');
    // Guard against things like 2**1000 (huge numbers)
    if (/\*\*\s*\d{3,}/.test(safe)) return null;
    try {
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + safe + ')')();
        if (typeof result !== 'number' || !isFinite(result) || isNaN(result)) return null;
        return Math.round(result);
    } catch {
        return null;
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function hasAdminPermission(interaction) {
    return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
}

function E(color, title) {
    return new EmbedBuilder().setColor(color).setTitle(title);
}

async function reply(interaction, content) {
    const opts = typeof content === 'string' ? { content, flags: [MessageFlags.Ephemeral] } : { ...content, flags: [MessageFlags.Ephemeral] };
    if (interaction.deferred) return interaction.editReply(opts);
    return interaction.reply(opts);
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
    client.user.setPresence({
        activities: [{ name: 'Counting things', type: ActivityType.Watching }],
        status: 'online',
    });

    const commands = [
        new SlashCommandBuilder()
            .setName('counting')
            .setDescription('Configure or view the counting game')
            .addSubcommand(s => s
                .setName('channel')
                .setDescription('Set the counting channel')
                .addChannelOption(o => o.setName('channel').setDescription('The channel to use for counting').setRequired(true))
            )
            .addSubcommand(s => s
                .setName('maxstreak')
                .setDescription('How many counts one person can do in a row (default: 1)')
                .addIntegerOption(o => o.setName('amount').setDescription('Max consecutive counts per user (1–20)').setRequired(true).setMinValue(1).setMaxValue(20))
            )
            .addSubcommand(s => s
                .setName('expressions')
                .setDescription('Allow or disallow math expressions like 1+1')
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable expressions').setRequired(true))
            )
            .addSubcommand(s => s
                .setName('status')
                .setDescription('View the current count and settings')
            )
            .addSubcommand(s => s
                .setName('reset')
                .setDescription('Manually reset the count to 0 (admin only)')
            ),
    ].map(c => c.toJSON());

    await client.application.commands.set(commands);
    console.log('✅ Commands registered');

    try {
        await initDB();
        const res = await pool.query('SELECT guild_id, data FROM counting');
        for (const { guild_id, data } of res.rows) stateCache.set(guild_id, data);
        console.log(`✅ Loaded state for ${res.rows.length} guild(s)`);
    } catch (e) {
        console.error('❌ DB init failed:', e.message);
    }

    keepAlive();
});

// ── Message counting ─────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const state = await getState(guildId).catch(() => null);
    if (!state?.channelId || message.channel.id !== state.channelId) return;

    const raw = message.content.trim();

    // Determine if it's an expression or plain number
    const isExpression = /[+\-*/^()]/.test(raw) && !/^\-?\d+$/.test(raw);
    if (isExpression && !state.allowExpressions) {
        await message.react('❌').catch(() => {});
        const sent = await message.channel.send({
            embeds: [E('#ff4444', '❌ Expressions disabled')
                .setDescription(`Expressions like \`${raw}\` are not allowed here. Just type the plain number!`)
            ]
        }).catch(() => null);
        if (sent) setTimeout(() => sent.delete().catch(() => {}), 5000);
        return;
    }

    const value = safeMath(raw);
    if (value === null) return; // Not a number at all — ignore silently

    const expected = state.current + 1;

    // ── Wrong number ────────────────────────────────────────────────────────
    if (value !== expected) {
        await message.react('❌').catch(() => {});
        const prev = state.current;
        state.current = 0;
        state.lastUserId = null;
        state.consecutiveCount = 0;
        saveState(guildId, state);

        await message.channel.send({
            embeds: [E('#ff4444', '💥 Count ruined!')
                .setDescription(`<@${message.author.id}> ruined the count at **${prev}**!\nThe next number was \`${expected}\`, but \`${value}\` was sent.`)
                .addFields(
                    { name: '🔄 Reset to', value: '**1**', inline: true },
                    { name: '🏆 High Score', value: `**${state.highScore}**`, inline: true }
                )
                .setFooter({ text: 'Start again from 1!' })
            ]
        }).catch(() => {});
        return;
    }

    // ── Consecutive count violation ─────────────────────────────────────────
    if (state.maxStreak > 0 && message.author.id === state.lastUserId) {
        const streak = state.consecutiveCount;
        if (streak >= state.maxStreak) {
            await message.react('❌').catch(() => {});
            const prev = state.current;
            state.current = 0;
            state.lastUserId = null;
            state.consecutiveCount = 0;
            saveState(guildId, state);

            await message.channel.send({
                embeds: [E('#ff4444', '💥 Count ruined!')
                    .setDescription(`<@${message.author.id}> counted too many times in a row (limit: **${state.maxStreak}**)!\nThe count was at **${prev}**.`)
                    .addFields(
                        { name: '🔄 Reset to', value: '**1**', inline: true },
                        { name: '🏆 High Score', value: `**${state.highScore}**`, inline: true }
                    )
                    .setFooter({ text: 'Let someone else count too!' })
                ]
            }).catch(() => {});
            return;
        }
    }

    // ── Correct count ───────────────────────────────────────────────────────
    const isSameUser = message.author.id === state.lastUserId;
    state.current = value;
    state.lastUserId = message.author.id;
    state.consecutiveCount = isSameUser ? state.consecutiveCount + 1 : 1;
    if (value > state.highScore) state.highScore = value;
    saveState(guildId, state);

    // React with the number if small enough, otherwise ✅
    const numberEmojis = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
    if (value <= 9) {
        await message.react(numberEmojis[value]).catch(() => {});
    } else {
        await message.react('✅').catch(() => {});
    }

    // Milestone announcements
    if (value % 100 === 0) {
        await message.channel.send({
            embeds: [E('#00cc88', `🎉 ${value} reached!`)
                .setDescription(`Amazing! The count hit **${value}** thanks to <@${message.author.id}>!`)
                .setFooter({ text: `Keep going! High score: ${state.highScore}` })
            ]
        }).catch(() => {});
    }
});

// ── Slash commands ────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return interaction.reply({ content: '❌ This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });

    const guildId = interaction.guild.id;
    const { commandName, options } = interaction;

    try {
        if (commandName === 'counting') {
            if (!hasAdminPermission(interaction)) {
                return reply(interaction, '❌ You need Administrator permission to configure the counting game.');
            }

            const sub = options.getSubcommand();
            const state = await getState(guildId);

            if (sub === 'channel') {
                const ch = options.getChannel('channel');
                if (!ch.isTextBased()) return reply(interaction, '❌ Please select a text channel.');
                state.channelId = ch.id;
                saveState(guildId, state);
                return reply(interaction, {
                    embeds: [E('#5865F2', '✅ Counting channel set')
                        .setDescription(`The counting channel has been set to ${ch}.\nStart counting from **1**!`)
                    ]
                });
            }

            if (sub === 'maxstreak') {
                const amount = options.getInteger('amount');
                state.maxStreak = amount;
                saveState(guildId, state);
                return reply(interaction, {
                    embeds: [E('#5865F2', '✅ Max streak updated')
                        .setDescription(amount === 1
                            ? 'Users can no longer count twice in a row.'
                            : `Users can now count **${amount}** times in a row before someone else must count.`
                        )
                    ]
                });
            }

            if (sub === 'expressions') {
                const enabled = options.getBoolean('enabled');
                state.allowExpressions = enabled;
                saveState(guildId, state);
                return reply(interaction, {
                    embeds: [E('#5865F2', `✅ Expressions ${enabled ? 'enabled' : 'disabled'}`)
                        .setDescription(enabled
                            ? 'Users can now count with expressions like `1+1`, `3*4`, `2^3`, etc.'
                            : 'Only plain numbers are now accepted in the counting channel.'
                        )
                    ]
                });
            }

            if (sub === 'status') {
                const ch = state.channelId ? `<#${state.channelId}>` : 'Not set';
                return reply(interaction, {
                    embeds: [E('#5865F2', '📊 Counting Status')
                        .addFields(
                            { name: '📍 Channel', value: ch, inline: true },
                            { name: '🔢 Current count', value: `**${state.current}**`, inline: true },
                            { name: '🏆 High score', value: `**${state.highScore}**`, inline: true },
                            { name: '🔁 Max streak', value: `**${state.maxStreak}** in a row`, inline: true },
                            { name: '🧮 Expressions', value: state.allowExpressions ? '✅ Allowed' : '❌ Disabled', inline: true },
                            { name: '👤 Last counter', value: state.lastUserId ? `<@${state.lastUserId}>` : 'Nobody yet', inline: true },
                        )
                    ]
                });
            }

            if (sub === 'reset') {
                const prev = state.current;
                state.current = 0;
                state.lastUserId = null;
                state.consecutiveCount = 0;
                saveState(guildId, state);

                // Announce in the counting channel too if it's set
                if (state.channelId) {
                    const ch = interaction.guild.channels.cache.get(state.channelId);
                    if (ch) ch.send({
                        embeds: [E('#ff9900', '🔄 Count manually reset')
                            .setDescription(`An admin reset the count from **${prev}** back to 0.\nStart again from **1**!`)
                        ]
                    }).catch(() => {});
                }

                return reply(interaction, `✅ Count reset from **${prev}** to 0.`);
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
