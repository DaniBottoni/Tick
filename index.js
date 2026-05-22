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
const CONSTANTS = {
    phi:   (1 + Math.sqrt(5)) / 2,  // golden ratio ≈ 1.618
    pi:    Math.PI,                  // ≈ 3.14159
    e:     Math.E,                   // ≈ 2.71828
    tau:   Math.PI * 2,              // ≈ 6.28318
    sqrt2: Math.SQRT2,               // ≈ 1.41421
};

function safeMath(expr) {
    let cleaned = expr.trim().toLowerCase().replace(/\s+/g, '');
    if (!cleaned) return null;

    for (const [name, val] of Object.entries(CONSTANTS)) {
        cleaned = cleaned.replaceAll(name, `(${val})`);
    }

    if (!/^[\d.+\-*/^()]+$/.test(cleaned)) return null;

    const safe = cleaned.replace(/\^/g, '**');
    if (/\*\*\s*\d{4,}/.test(safe)) return null;

    try {
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + safe + ')')();
        if (typeof result !== 'number' || !isFinite(result) || isNaN(result)) return null;
        return Math.round(result);
    } catch {
        return null;
    }
}

// ── Expression generator ─────────────────────────────────────────────────────
function generateExpressions(n) {
    const candidates = [];
    const phi = (1 + Math.sqrt(5)) / 2;
    const pi  = Math.PI;
    const e   = Math.E;
    const sqrt2 = Math.SQRT2;
    const tau = Math.PI * 2;

    // Integer base^exp = n  (e.g. 8 = 2^3)
    for (let base = 2; base <= 50; base++) {
        for (let exp = 2; exp <= 8; exp++) {
            if (Math.pow(base, exp) === n) candidates.push(`${base}^${exp}`);
        }
    }

    // Constant powers: round(const^exp) = n  (e.g. phi^10 = 11)
    const consts = [['phi', phi], ['pi', pi], ['e', e], ['sqrt2', sqrt2], ['tau', tau]];
    for (const [name, val] of consts) {
        for (let exp = 1; exp <= 20; exp++) {
            if (Math.round(Math.pow(val, exp)) === n) {
                candidates.push(`${name}^${exp}`);
                break;
            }
        }
    }

    // Constant combos: round(a^b + c) = n
    for (const [name, val] of consts) {
        for (let exp = 1; exp <= 10; exp++) {
            const base = Math.round(Math.pow(val, exp));
            const diff = n - base;
            if (diff !== 0 && Math.abs(diff) <= 20) {
                const sign = diff > 0 ? `+${diff}` : `${diff}`;
                candidates.push(`${name}^${exp}${sign}`);
            }
        }
    }

    // Multiplication: a*b = n with non-trivial factors
    if (n > 4) {
        for (let a = 2; a <= Math.sqrt(n); a++) {
            if (n % a === 0) {
                candidates.push(`${a}*${n / a}`);
                break;
            }
        }
    }

    // Multi-factor: a*b*c
    if (n > 8) {
        outer: for (let a = 2; a <= Math.cbrt(n); a++) {
            if (n % a === 0) {
                const rest = n / a;
                for (let b = a; b <= Math.sqrt(rest); b++) {
                    if (rest % b === 0) {
                        candidates.push(`${a}*${b}*${rest / b}`);
                        break outer;
                    }
                }
            }
        }
    }

    // Addition: meaningful split (not 50/50)
    if (n > 2) {
        const a = Math.max(1, Math.floor(n * 0.35));
        candidates.push(`${a}+${n - a}`);
    }

    // Subtraction: (n+k)-k with interesting k
    if (n >= 1) {
        const k = Math.round(n * 0.6) + 1;
        candidates.push(`${n + k}-${k}`);
    }

    // Division: (n*a)/a
    if (n >= 1) {
        const a = n <= 10 ? 2 : 3;
        candidates.push(`${n * a}/${a}`);
    }

    // Mixed: a*b+c or a*b-c
    if (n > 5) {
        for (let a = 2; a <= 10; a++) {
            const base = Math.floor(n / a) * a;
            const diff = n - base;
            if (base > 0 && diff > 0 && diff < a) {
                candidates.push(`${a}*${Math.floor(n / a)}+${diff}`);
                break;
            }
        }
    }

    // Dedupe and pick 3 most interesting (prefer shorter / constant-based)
    const seen = new Set();
    const result = [];
    // Prioritise: constant-based first, then power, then others
    const sorted = candidates.sort((a, b) => {
        const aHasConst = /[a-z]/.test(a);
        const bHasConst = /[a-z]/.test(b);
        if (aHasConst && !bHasConst) return -1;
        if (!aHasConst && bHasConst) return 1;
        return a.length - b.length;
    });

    for (const c of sorted) {
        if (!seen.has(c) && result.length < 3) {
            seen.add(c);
            result.push(c);
        }
    }

    // Fallbacks
    if (result.length < 3) result.push(`${n - 1}+1`);
    if (result.length < 3) result.push(`${n * 2}/2`);
    if (result.length < 3) result.push(`${n + 3}-3`);

    return result.slice(0, 3);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function hasAdminPermission(interaction) {
    return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
}

function E(color, title) {
    return new EmbedBuilder().setColor(color).setTitle(title);
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

        new SlashCommandBuilder()
            .setName('calculate')
            .setDescription('Get 3 ways to write a number using math expressions')
            .addIntegerOption(o => o.setName('number').setDescription('The number to express').setRequired(true).setMinValue(1).setMaxValue(100000)),

        new SlashCommandBuilder()
            .setName('invite')
            .setDescription('Get a link to invite this bot to your server'),

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
        if (state.consecutiveCount >= state.maxStreak) {
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

    const numberEmojis = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
    if (value <= 9) {
        await message.react(numberEmojis[value]).catch(() => {});
    } else {
        await message.react('✅').catch(() => {});
    }

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

        // ── /invite ──────────────────────────────────────────────────────────
        if (commandName === 'invite') {
            // Permissions: View Channel, Send Messages, Add Reactions, Read Message History, Manage Messages
            const perms = 76864n;
            const url = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${perms}&scope=bot%20applications.commands`;
            return interaction.reply({
                embeds: [E('#5865F2', '📨 Invite Counting Bot')
                    .setDescription(`[**Click here to invite me to your server!**](${url})`)
                    .addFields({
                        name: '🔐 Permissions requested',
                        value: '• View Channels\n• Send Messages\n• Add Reactions\n• Read Message History\n• Manage Messages'
                    })
                    .setFooter({ text: 'After inviting, use /counting channel to set up!' })
                ],
                flags: [MessageFlags.Ephemeral]
            });
        }

        // ── /calculate ───────────────────────────────────────────────────────
        if (commandName === 'calculate') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const n = options.getInteger('number');
            const exprs = generateExpressions(n);

            const fields = exprs.map((expr, i) => {
                const verified = safeMath(expr);
                const label = ['1️⃣', '2️⃣', '3️⃣'][i];
                return {
                    name: `${label}  \`${expr}\``,
                    value: `= **${verified ?? n}**`,
                    inline: true,
                };
            });

            return interaction.editReply({
                embeds: [E('#5865F2', `🧮 Ways to write ${n}`)
                    .setDescription(`Here are 3 expressions you can use to count **${n}** in the counting channel:`)
                    .addFields(...fields)
                    .setFooter({ text: 'Supports: + - * / ^ pi phi e tau sqrt2' })
                ]
            });
        }

        // ── /counting ────────────────────────────────────────────────────────
        if (commandName === 'counting') {
            if (!hasAdminPermission(interaction)) {
                return interaction.reply({ content: '❌ You need Administrator permission to configure the counting game.', flags: [MessageFlags.Ephemeral] });
            }

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const sub = options.getSubcommand();
            const state = await getState(guildId);

            if (sub === 'channel') {
                const ch = options.getChannel('channel');
                if (!ch.isTextBased()) return interaction.editReply({ content: '❌ Please select a text channel.' });
                state.channelId = ch.id;
                saveState(guildId, state);
                return interaction.editReply({
                    embeds: [E('#5865F2', '✅ Counting channel set')
                        .setDescription(`The counting channel has been set to ${ch}.\nStart counting from **1**!`)
                    ]
                });
            }

            if (sub === 'maxstreak') {
                const amount = options.getInteger('amount');
                state.maxStreak = amount;
                saveState(guildId, state);
                return interaction.editReply({
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
                return interaction.editReply({
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
                return interaction.editReply({
                    embeds: [E('#5865F2', '📊 Counting Status')
                        .addFields(
                            { name: '📍 Channel',       value: ch,                                               inline: true },
                            { name: '🔢 Current count', value: `**${state.current}**`,                          inline: true },
                            { name: '🏆 High score',    value: `**${state.highScore}**`,                        inline: true },
                            { name: '🔁 Max streak',    value: `**${state.maxStreak}** in a row`,               inline: true },
                            { name: '🧮 Expressions',   value: state.allowExpressions ? '✅ Allowed' : '❌ Disabled', inline: true },
                            { name: '👤 Last counter',  value: state.lastUserId ? `<@${state.lastUserId}>` : 'Nobody yet', inline: true },
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

                if (state.channelId) {
                    const ch = interaction.guild.channels.cache.get(state.channelId);
                    if (ch) ch.send({
                        embeds: [E('#ff9900', '🔄 Count manually reset')
                            .setDescription(`An admin reset the count from **${prev}** back to 0.\nStart again from **1**!`)
                        ]
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
