const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits,
        EmbedBuilder, ActivityType, MessageFlags, ActionRowBuilder,
        ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType } = require('discord.js');
const { Pool } = require('pg');
require('dns').setDefaultResultOrder('ipv4first');
const http = require('http');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 8000, connectionTimeoutMillis: 5000, idleTimeoutMillis: 600000, max: 3 });
const stateCache = new Map();
const PS = 25, SLB_MAX = 100;

// ─── DB ───────────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS counting   (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS user_stats (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (guild_id, user_id));
        CREATE INDEX IF NOT EXISTS user_stats_user ON user_stats(user_id);
        CREATE TABLE IF NOT EXISTS dedup (message_id TEXT PRIMARY KEY, claimed_at TIMESTAMPTZ DEFAULT NOW());
    `);
    pool.query(`DELETE FROM dedup WHERE claimed_at < NOW() - INTERVAL '5 minutes'`).catch(() => {});
}

async function claimMessage(messageId) {
    try {
        const r = await pool.query('INSERT INTO dedup (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id', [messageId]);
        return r.rowCount > 0;
    } catch { return true; }
}

function defaultState() {
    return {
        channelId: null, current: 0, lastUserId: null, consecutiveCount: 0,
        maxStreak: 1, allowExpressions: true, highScore: 0, accessRoleId: null,
        countType: 'interactive', saves: 0, savesUsed: 0,
        // Countdown extras
        countdownCycles: 0, countdownStart: 100,
        // Random extras
        randomModifier: null, randomModifierLabel: null, randomModifierStep: null,
    };
}
async function getState(guildId) {
    if (stateCache.has(guildId)) return stateCache.get(guildId);
    const r = await pool.query('SELECT data FROM counting WHERE guild_id=$1', [guildId]);
    const d = r.rows[0]?.data ?? defaultState();
    if (!d.countType) d.countType = 'interactive';
    stateCache.set(guildId, d);
    return d;
}
function saveState(guildId, data) {
    stateCache.set(guildId, data);
    pool.query('INSERT INTO counting (guild_id,data) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET data=$2', [guildId, data]).catch(e => console.error('saveState:', e.message));
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function updateUserStat(guildId, userId, delta) {
    try {
        const r = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
        const cur = r.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
        for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + v;
        await pool.query('INSERT INTO user_stats (guild_id,user_id,data) VALUES ($1,$2,$3) ON CONFLICT (guild_id,user_id) DO UPDATE SET data=$3', [guildId, userId, cur]);
        return cur;
    } catch (e) { console.error('updateUserStat:', e.message); return null; }
}
async function getUserStats(gid, uid) {
    const r = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
    return r.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
}
async function getUserRank(gid, uid) {
    const r = await pool.query(`SELECT COUNT(*)+1 AS rank FROM user_stats WHERE guild_id=$1 AND COALESCE((data->>'correct')::int,0) > COALESCE((SELECT (data->>'correct')::int FROM user_stats WHERE guild_id=$1 AND user_id=$2),0)`, [gid, uid]);
    return parseInt(r.rows[0]?.rank ?? 1);
}
async function getServerStats(gid) {
    const r = await pool.query(`SELECT COUNT(*) AS tu, SUM(COALESCE((data->>'correct')::int,0)) AS tc, SUM(COALESCE((data->>'ruined')::int,0)) AS tr FROM user_stats WHERE guild_id=$1`, [gid]);
    return r.rows[0] ?? {};
}

// ─── Paginated queries ────────────────────────────────────────────────────────
async function getServerLbPage(gid, page) {
    const off = Math.min((page - 1) * PS, SLB_MAX - PS);
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id,data FROM user_stats WHERE guild_id=$1 ORDER BY COALESCE((data->>'correct')::int,0) DESC LIMIT $2 OFFSET $3`, [gid, PS, off]),
        pool.query(`SELECT LEAST(COUNT(*), $2) AS cnt FROM user_stats WHERE guild_id=$1`, [gid, SLB_MAX]),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getGlobalUsersPage(page) {
    const off = (page - 1) * PS;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id, SUM(COALESCE((data->>'correct')::int,0)) AS correct, SUM(COALESCE((data->>'ruined')::int,0)) AS ruined FROM user_stats GROUP BY user_id ORDER BY correct DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(DISTINCT user_id) AS cnt FROM user_stats`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getGlobalServersPage(page, filter) {
    // filter: 'interactive' | 'simple' | 'countdown' | 'random'
    const off = (page - 1) * PS;
    const where = filter ? `WHERE COALESCE(data->>'countType','interactive')='${filter}'` : '';
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, COALESCE((data->>'current')::int,0) AS cur, COALESCE((data->>'highScore')::int,0) AS hs, COALESCE(data->>'countType','interactive') AS mode FROM counting ${where} ORDER BY cur DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting ${where}`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getHighscoresPage(page, filter) {
    // filter: 'interactive' | 'simple' | 'countdown' | 'random' | undefined (all non-countdown)
    const off = (page - 1) * PS;
    // Countdown uses cycles; others use highScore
    let where = '';
    if (filter === 'countdown') {
        where = `WHERE COALESCE(data->>'countType','interactive')='countdown'`;
    } else if (filter) {
        where = `WHERE COALESCE(data->>'countType','interactive')='${filter}'`;
    } else {
        where = `WHERE COALESCE(data->>'countType','interactive') != 'countdown'`;
    }
    const scoreExpr = filter === 'countdown'
        ? `COALESCE((data->>'countdownCycles')::int,0)`
        : `COALESCE((data->>'highScore')::int,0)`;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, ${scoreExpr} AS score, COALESCE((data->>'current')::int,0) AS cur, COALESCE(data->>'countType','interactive') AS mode FROM counting ${where} ORDER BY score DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting ${where}`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const M = ['🥇', '🥈', '🥉'];
const E = (color, title) => new EmbedBuilder().setColor(color).setTitle(title);
const ep = () => ({ flags: [MessageFlags.Ephemeral] });

const MODE_EMOJI = { interactive: '🎮', simple: '🟢', countdown: '⏳', random: '🎲' };
const MODE_LABEL = { interactive: 'Interactive', simple: 'Simple', countdown: 'Countdown', random: 'Random' };

const guildNameCache = new Map();
async function guildName(id) {
    if (!client.guilds.cache.has(id)) { guildNameCache.delete(id); return null; }
    if (guildNameCache.has(id)) return guildNameCache.get(id);
    try {
        const g = client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null);
        const name = g ? g.name : null;
        if (name) { guildNameCache.set(id, name); return name; }
    } catch {}
    return null;
}
async function hasPerm(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const s = await getState(guildId);
    return s.accessRoleId ? interaction.member.roles.cache.has(s.accessRoleId) : false;
}

// ─── Random Modifier System ───────────────────────────────────────────────────
const RANDOM_MODIFIERS = [
    {
        id: 'every2',
        label: '⏩ Count every 2nd number',
        desc: 'Skip every other number! Only even numbers count.',
        check: (n) => n % 2 === 0,
        next: (current) => current + 2,
        hint: (current) => `Next: **${current + 2}**`,
    },
    {
        id: 'every3',
        label: '⏩ Count every 3rd number',
        desc: 'Only multiples of 3!',
        check: (n) => n % 3 === 0,
        next: (current) => current + 3,
        hint: (current) => `Next: **${current + 3}**`,
    },
    {
        id: 'primes',
        label: '🔢 Primes only',
        desc: 'Only prime numbers are valid!',
        check: (n) => isPrime(n),
        next: (current) => nextPrime(current),
        hint: (current) => `Next prime: **${nextPrime(current)}**`,
    },
    {
        id: 'fibonacci',
        label: '🌀 Fibonacci sequence',
        desc: 'Follow the Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13…',
        check: (n) => isFibonacci(n),
        next: (current) => nextFibonacci(current),
        hint: (current) => `Next Fibonacci: **${nextFibonacci(current)}**`,
    },
    {
        id: 'squares',
        label: '🟥 Perfect squares',
        desc: 'Only perfect squares! 1, 4, 9, 16, 25…',
        check: (n) => { const s = Math.round(Math.sqrt(n)); return s * s === n; },
        next: (current) => { const s = Math.round(Math.sqrt(current)); return (s + 1) * (s + 1); },
        hint: (current) => { const s = Math.round(Math.sqrt(current)); return `Next square: **${(s + 1) * (s + 1)}**`; },
    },
    {
        id: 'palindromes',
        label: '🔄 Palindrome numbers',
        desc: 'Only numbers that read the same forwards and backwards! 1, 2, …, 9, 11, 22, 33…',
        check: (n) => { const s = String(n); return s === s.split('').reverse().join(''); },
        next: (current) => { let n = current + 1; while (true) { const s = String(n); if (s === s.split('').reverse().join('')) return n; n++; } },
        hint: (current) => { let n = current + 1; while (true) { const s = String(n); if (s === s.split('').reverse().join('')) return `Next palindrome: **${n}**`; n++; } },
    },
    {
        id: 'lucky7',
        label: '🍀 Multiples of 7',
        desc: 'Lucky sevens! Only multiples of 7.',
        check: (n) => n % 7 === 0,
        next: (current) => current + 7,
        hint: (current) => `Next: **${current + 7}**`,
    },
    {
        id: 'triangular',
        label: '🔺 Triangular numbers',
        desc: 'Only triangular numbers! 1, 3, 6, 10, 15, 21…',
        check: (n) => isTriangular(n),
        next: (current) => nextTriangular(current),
        hint: (current) => `Next triangular: **${nextTriangular(current)}**`,
    },
];

function isPrime(n) {
    if (n < 2) return false;
    if (n === 2) return true;
    if (n % 2 === 0) return false;
    for (let i = 3; i <= Math.sqrt(n); i += 2) if (n % i === 0) return false;
    return true;
}
function nextPrime(n) {
    let m = n + 1;
    while (!isPrime(m)) m++;
    return m;
}
function isFibonacci(n) {
    const isPerfectSquare = x => { const s = Math.round(Math.sqrt(x)); return s * s === x; };
    return isPerfectSquare(5 * n * n + 4) || isPerfectSquare(5 * n * n - 4);
}
function nextFibonacci(current) {
    // find fib sequence up to and past current
    let a = 1, b = 1;
    while (b <= current) { const c = a + b; a = b; b = c; }
    return b;
}
function isTriangular(n) {
    const x = (Math.sqrt(8 * n + 1) - 1) / 2;
    return Math.abs(x - Math.round(x)) < 1e-9;
}
function nextTriangular(n) {
    let t = 1, k = 1;
    while (t <= n) { k++; t = k * (k + 1) / 2; }
    return t;
}

function pickRandomModifier() {
    return RANDOM_MODIFIERS[Math.floor(Math.random() * RANDOM_MODIFIERS.length)];
}
function getModifier(id) {
    return RANDOM_MODIFIERS.find(m => m.id === id) ?? RANDOM_MODIFIERS[0];
}

// For random mode: get the "first valid number" after a reset
function firstValidForModifier(modId) {
    const mod = getModifier(modId);
    let n = 1;
    while (!mod.check(n)) n++;
    return n;
}

// ─── Embed builders ───────────────────────────────────────────────────────────
async function buildUserStatsEmbed(gid, user) {
    const [st, rank, gs] = await Promise.all([getUserStats(gid, user.id), getUserRank(gid, user.id), getState(gid)]);
    const tot = (st.correct || 0) + (st.ruined || 0), acc = tot > 0 ? Math.round((st.correct / tot) * 100) : 100;
    const modeEmoji = MODE_EMOJI[gs.countType ?? 'interactive'];
    const extra = gs.countType === 'countdown'
        ? [{ name: '⏳ Countdown Cycles', value: `**${gs.countdownCycles ?? 0}**`, inline: true }]
        : [];
    return E('#5865F2', `📊 Stats — ${user.username}`).setThumbnail(user.displayAvatarURL()).addFields(
        { name: '✅ Correct',      value: `**${st.correct ?? 0}**`,  inline: true },
        { name: '💥 Ruined',       value: `**${st.ruined ?? 0}**`,   inline: true },
        { name: '🎯 Accuracy',     value: `**${acc}%**`,             inline: true },
        { name: '🏅 Rank',         value: `**#${rank}**`,            inline: true },
        { name: '🔢 Current',      value: `**${gs.current}**`,       inline: true },
        { name: '🏆 High score',   value: `**${gs.highScore}**`,     inline: true },
        { name: '🛡️ Server saves', value: `**${gs.saves ?? 0}**`,   inline: true },
        { name: '🔖 Saves used',   value: `**${gs.savesUsed ?? 0}**`, inline: true },
        { name: `${modeEmoji} Mode`, value: `**${MODE_LABEL[gs.countType ?? 'interactive']}**`, inline: true },
        ...extra,
    );
}
async function buildServerStatsEmbed(guild) {
    const [ss, gs] = await Promise.all([getServerStats(guild.id), getState(guild.id)]);
    const tc = parseInt(ss.tc) || 0, tr = parseInt(ss.tr) || 0, tu = parseInt(ss.tu) || 0, gt = tc + tr, ac = gt > 0 ? Math.round((tc / gt) * 100) : 100;
    const modeEmoji = MODE_EMOJI[gs.countType ?? 'interactive'];
    const extraFields = [];
    if (gs.countType === 'countdown') {
        extraFields.push({ name: '⏳ Cycles completed', value: `**${gs.countdownCycles ?? 0}**`, inline: true });
    }
    if (gs.countType === 'random' && gs.randomModifierLabel) {
        extraFields.push({ name: '🎲 Current modifier', value: gs.randomModifierLabel, inline: true });
    }
    return E('#5865F2', `📊 Server Stats — ${guild.name}`).setThumbnail(guild.iconURL()).addFields(
        { name: '👥 Counters',   value: `**${tu}**`,           inline: true },
        { name: '✅ Correct',    value: `**${tc}**`,           inline: true },
        { name: '💥 Ruined',     value: `**${tr}**`,           inline: true },
        { name: '🎯 Accuracy',   value: `**${ac}%**`,          inline: true },
        { name: '🔢 Current',    value: `**${gs.current}**`,   inline: true },
        { name: '🏆 High score', value: `**${gs.highScore}**`, inline: true },
        { name: `${modeEmoji} Mode`, value: `**${MODE_LABEL[gs.countType ?? 'interactive']}**`, inline: true },
        ...extraFields,
    );
}
async function buildServerLbEmbed(gid, page) {
    const { rows, total } = await getServerLbPage(gid, page);
    const tp = Math.max(1, Math.ceil(total / PS)), off = (page - 1) * PS;
    if (!rows.length) return { embed: E('#5865F2', '🏆 Server Leaderboard').setDescription('No stats yet!'), totalPages: 1 };
    return { totalPages: tp, embed: E('#5865F2', '🏆 Server Leaderboard')
        .setDescription(rows.map((r, i) => `${M[off + i] ?? `**${off + i + 1}.**`} <@${r.user_id}> — **${r.data.correct ?? 0}** counts${r.data.ruined ? ` *(${r.data.ruined} ruined)*` : ''}`).join('\n'))
        .setFooter({ text: `Page ${page}/${tp} · ${off + 1}–${off + rows.length} of ${total}` }) };
}
async function buildGlobalUsersEmbed(page) {
    const { rows, total } = await getGlobalUsersPage(page);
    const tp = Math.max(1, Math.ceil(total / PS)), off = (page - 1) * PS;
    if (!rows.length) return { embed: E('#5865F2', '🌍 Global — Users').setDescription('No stats yet!'), totalPages: 1 };
    const userLines = await Promise.all(rows.map(async (r, i) => {
        let display;
        try { const u = await client.users.fetch(r.user_id); display = `<@${u.id}> (@${u.username})`; }
        catch { display = `<@${r.user_id}>`; }
        return `${M[off + i] ?? `**${off + i + 1}.**`} ${display} — **${parseInt(r.correct)}** counts`;
    }));
    return { totalPages: tp, embed: E('#5865F2', '🌍 Global Leaderboard — Users')
        .setDescription(userLines.join('\n'))
        .setFooter({ text: `Page ${page}/${tp} · ${off + 1}–${off + rows.length} of ${total} users` }) };
}

// filter: 'interactive' | 'simple' | 'countdown' | 'random'
async function buildGlobalServersEmbed(page, filter) {
    const { rows, total } = await getGlobalServersPage(page, filter);
    const tp = Math.max(1, Math.ceil(total / PS)), off = (page - 1) * PS;
    const titles = {
        interactive: '🎮 Global — Interactive Servers',
        simple:      '🟢 Global — Simple Servers',
        countdown:   '⏳ Global — Countdown Servers',
        random:      '🎲 Global — Random Servers',
    };
    if (!rows.length) return { embed: E('#5865F2', titles[filter] ?? '🌍 Global — Servers').setDescription('No servers found!'), totalPages: 1, filter };
    const resolved = (await Promise.all(rows.map(async r => {
        const name = await guildName(r.guild_id);
        if (!name) return null;
        return { name, emoji: MODE_EMOJI[r.mode] ?? '🎮', cur: r.cur };
    }))).filter(Boolean).map((r, i) => `${M[off + i] ?? `**${off + i + 1}.**`} **${r.name}** ${r.emoji} — 🔢 **${r.cur}**`);
    if (!resolved.length) return { embed: E('#5865F2', titles[filter]).setDescription('No active servers found!'), totalPages: 1, filter };
    return { totalPages: tp, filter, embed: E('#5865F2', titles[filter]).setDescription(resolved.join('\n')).setFooter({ text: `Page ${page}/${tp}` }) };
}

// Highscores: filter = 'interactive'|'simple'|'random'|'countdown'
async function buildHighscoresEmbed(page, filter = 'interactive') {
    const { rows, total } = await getHighscoresPage(page, filter);
    const tp = Math.max(1, Math.ceil(total / PS)), off = (page - 1) * PS;
    const titles = {
        interactive: '🏅 High Scores — Interactive',
        simple:      '🏅 High Scores — Simple',
        random:      '🏅 High Scores — Random',
        countdown:   '🏅 High Scores — Countdown Cycles',
    };
    const scoreLabel = filter === 'countdown' ? 'cycles' : 'high score';
    if (!rows.length) return { embed: E('#5865F2', titles[filter]).setDescription('No data yet!'), totalPages: 1 };
    const hsResolved = (await Promise.all(rows.map(async r => {
        const name = await guildName(r.guild_id);
        if (!name) return null;
        return { name, score: r.score };
    }))).filter(Boolean).map((r, i) => {
        const emoji = filter === 'countdown' ? '🔄' : '🏆';
        return `${M[off + i] ?? `**${off + i + 1}.**`} **${r.name}** — ${emoji} **${r.score}** ${scoreLabel}`;
    });
    if (!hsResolved.length) return { embed: E('#5865F2', titles[filter]).setDescription('No active servers found!'), totalPages: 1 };
    return { totalPages: tp, embed: E('#5865F2', titles[filter]).setDescription(hsResolved.join('\n')).setFooter({ text: `Page ${page}/${tp}` }) };
}

// ─── Setup embed ──────────────────────────────────────────────────────────────
function buildSetupEmbed(state) {
    const ct = state.countType ?? 'interactive';
    const modeDisplay = { interactive: '🎮 Interactive', simple: '🟢 Simple', countdown: '⏳ Countdown', random: '🎲 Random' }[ct] ?? '🎮 Interactive';
    const extraField = ct === 'countdown'
        ? [{ name: '⏳ Countdown Cycles', value: `**${state.countdownCycles ?? 0}**`, inline: true }]
        : ct === 'random' && state.randomModifierLabel
        ? [{ name: '🎲 Current Modifier', value: state.randomModifierLabel, inline: true }]
        : [];
    return {
        embeds: [E('#5865F2', '⚙️ Counting Bot — Setup')
            .setDescription('Use the buttons below to configure the bot. All settings are saved instantly.')
            .addFields(
                { name: '📍 Counting Channel', value: state.channelId ? `<#${state.channelId}>` : 'Not set',             inline: true },
                { name: '🎮 Count Type',        value: modeDisplay,                                                       inline: true },
                { name: '🔁 Max Streak',        value: `**${state.maxStreak}** in a row`,                                 inline: true },
                { name: '🧮 Expressions',       value: state.allowExpressions ? 'Allowed' : 'Disabled',                  inline: true },
                { name: '🔒 Access Role',       value: state.accessRoleId ? `<@&${state.accessRoleId}>` : 'Admins only', inline: true },
                { name: '🛡️ Server Saves',     value: `**${state.saves ?? 0}**`,                                         inline: true },
                { name: '🔢 Current Count',     value: `**${state.current}**`,                                            inline: true },
                ...extraField,
            )
        ],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_setchannel').setLabel('Set Channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('setup_counttype').setLabel('Change Mode').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_expressions').setLabel(state.allowExpressions ? 'Disable Expressions' : 'Enable Expressions').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_access').setLabel('Set Access Role').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_reset').setLabel('Reset Count').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('setup_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
            ),
        ],
    };
}

// ─── Component rows ───────────────────────────────────────────────────────────
const B = (id, label, active) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary);
function statsRow(uid, gid, active) {
    return new ActionRowBuilder().addComponents(B(`stats_user_${uid}_${gid}`, 'User Stats', active === 'user'), B(`stats_server_${uid}_${gid}`, 'Server Stats', active === 'server'));
}
function paginationRow(type, ctx, page, tp) {
    const base = ctx ? `lb_${type}_${ctx}` : `lb_${type}`;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${base}_p${page - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
        new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${tp}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`${base}_p${page + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= tp),
        new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('↺').setStyle(ButtonStyle.Secondary),
    );
}
// Global leaderboard tabs (users + all 4 server modes)
function globalTabRow(active) {
    return new ActionRowBuilder().addComponents(
        B('lbt_gu',          '👥 Users',         active === 'gu'),
        B('lbt_gs_interactive', '🎮 Interactive', active === 'gs_interactive'),
        B('lbt_gs_simple',      '🟢 Simple',      active === 'gs_simple'),
        B('lbt_gs_countdown',   '⏳ Countdown',   active === 'gs_countdown'),
        B('lbt_gs_random',      '🎲 Random',      active === 'gs_random'),
    );
}
// Highscore tabs — separate tabs per mode (no "All")
function highscoreTabRow(active) {
    return new ActionRowBuilder().addComponents(
        B('hst_interactive', '🎮 Interactive', active === 'interactive'),
        B('hst_simple',      '🟢 Simple',      active === 'simple'),
        B('hst_random',      '🎲 Random',      active === 'random'),
        B('hst_countdown',   '⏳ Countdown',   active === 'countdown'),
    );
}
function countTypeRow(current) {
    return new ActionRowBuilder().addComponents(
        B('ct_interactive', '🎮 Interactive', current === 'interactive'),
        B('ct_simple',      '🟢 Simple',      current === 'simple'),
        B('ct_countdown',   '⏳ Countdown',   current === 'countdown'),
        B('ct_random',      '🎲 Random',      current === 'random'),
    );
}

// ─── Math (complex number evaluator) ─────────────────────────────────────────
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };

class C {
    constructor(r = 0, i = 0) { this.r = r; this.i = i; }
    static of(x) { return x instanceof C ? x : new C(+x, 0); }
    add(b) { b = C.of(b); return new C(this.r + b.r, this.i + b.i); }
    sub(b) { b = C.of(b); return new C(this.r - b.r, this.i - b.i); }
    mul(b) { b = C.of(b); return new C(this.r * b.r - this.i * b.i, this.r * b.i + this.i * b.r); }
    div(b) { b = C.of(b); const d = b.r * b.r + b.i * b.i; if (!d) return new C(NaN, NaN); return new C((this.r * b.r + this.i * b.i) / d, (this.i * b.r - this.r * b.i) / d); }
    pow(b) { b = C.of(b); if (this.r === 0 && this.i === 0) return (b.r === 0 && b.i === 0) ? new C(1) : new C(0); return this.ln().mul(b).exp(); }
    ln() { return new C(Math.log(Math.hypot(this.r, this.i)), Math.atan2(this.i, this.r)); }
    exp() { const e = Math.exp(this.r); return new C(e * Math.cos(this.i), e * Math.sin(this.i)); }
    neg() { return new C(-this.r, -this.i); }
    sqrt() { const m = Math.hypot(this.r, this.i) ** 0.5, a = Math.atan2(this.i, this.r) / 2; return new C(m * Math.cos(a), m * Math.sin(a)); }
    cbrt() { const m = Math.hypot(this.r, this.i) ** (1 / 3), a = Math.atan2(this.i, this.r) / 3; return new C(m * Math.cos(a), m * Math.sin(a)); }
    nthRoot(n) { const m = Math.hypot(this.r, this.i) ** (1 / n), a = Math.atan2(this.i, this.r) / n; return new C(m * Math.cos(a), m * Math.sin(a)); }
    isReal(tol = 1e-6) { return Math.abs(this.i) <= tol; }
}

const CCONSTS = {
    pi: new C(Math.PI), e: new C(Math.E), phi: new C((1 + Math.sqrt(5)) / 2),
    tau: new C(Math.PI * 2), sqrt2: new C(Math.SQRT2), i: new C(0, 1),
};
function lambertW(x) {
    if (x < -1/Math.E) return NaN;
    let w = x < 1 ? x : Math.log(x);
    for (let i = 0; i < 100; i++) {
        const ew = Math.exp(w), wew = w * ew, f = wew - x, df = ew * (w + 1);
        const dw = f / (df - (w + 2) * f / (2 * (w + 1)));
        w -= dw; if (Math.abs(dw) < 1e-12) break;
    }
    return w;
}
const CFUNCS_REAL = {
    floor: v => new C(Math.floor(v.r)),
    ceil:  v => new C(Math.ceil(v.r)),
    round: v => new C(Math.round(v.r)),
    abs:   v => new C(Math.hypot(v.r, v.i)),
    ln:    v => new C(Math.log(v.r)),
    log:   v => new C(Math.log10(v.r)),
    log2:  v => new C(Math.log2(v.r)),
    log10: v => new C(Math.log10(v.r)),
    exp:   v => new C(Math.exp(v.r)),
    sin:   v => new C(Math.sin(v.r)),
    cos:   v => new C(Math.cos(v.r)),
    tan:   v => new C(Math.tan(v.r)),
    asin:  v => new C(Math.asin(v.r)),
    acos:  v => new C(Math.acos(v.r)),
    atan:  v => new C(Math.atan(v.r)),
    sinh:  v => new C(Math.sinh(v.r)),
    cosh:  v => new C(Math.cosh(v.r)),
    tanh:  v => new C(Math.tanh(v.r)),
    lambertw: v => new C(lambertW(v.r)),
    lw: v => new C(lambertW(v.r)),
    w:  v => new C(lambertW(v.r)),
};
const CONSTS = { phi: (1 + Math.sqrt(5)) / 2, pi: Math.PI, e: Math.E, tau: Math.PI * 2, sqrt2: Math.SQRT2 };

function safeMath(expr) {
    let s = expr.trim(), norm = '';
    for (let k = 0; k < s.length; k++) {
        if (SUP[s[k]] !== undefined) {
            let sup = ''; while (k < s.length && SUP[s[k]] !== undefined) sup += SUP[s[k++]]; norm += '^' + sup; k--;
        } else norm += s[k];
    }
    s = norm.replace(/[×·•]/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '').toLowerCase();
    s = s.replace(/(?<=[\d)])x(?=[\d(])/g, '*');
    s = s.replace(/\*\*/g, '^');
    s = s.replace(/(\d+)√/g, (_, n) => `nrt${n}(`);
    s = s.replace(/∜/g, 'nrt4(').replace(/∛/g, 'cbrt(').replace(/√/g, 'sqrt(');

    let tokens = [], k = 0;
    while (k < s.length) {
        if (/\d/.test(s[k]) || s[k] === '.') {
            let n = ''; while (k < s.length && (/\d/.test(s[k]) || s[k] === '.')) n += s[k++];
            tokens.push({ t: 'n', v: parseFloat(n) });
        } else if (/[a-z]/.test(s[k])) {
            let id = ''; while (k < s.length && /[a-z0-9]/.test(s[k])) id += s[k++];
            tokens.push({ t: 'id', v: id });
        } else if ('+-*/^(),'.includes(s[k])) {
            tokens.push({ t: 'op', v: s[k++] });
        } else k++;
    }

    const FUNCS = new Set(['sqrt','cbrt','floor','ceil','round','abs','ln','log','log2','log10','exp','sin','cos','tan','asin','acos','atan','sinh','cosh','tanh','lambertw','lw','w']);
    const isFunc = v => FUNCS.has(v) || /^nrt\d+$/.test(v);
    const out = [];
    for (let j = 0; j < tokens.length; j++) {
        out.push(tokens[j]);
        const cur = tokens[j], nxt = tokens[j + 1];
        if (!nxt) continue;
        const leftOk  = cur.t === 'n' || (cur.t === 'id' && !isFunc(cur.v)) || (cur.t === 'op' && cur.v === ')');
        const rightOk = nxt.t === 'n' || nxt.t === 'id' || (nxt.t === 'op' && nxt.v === '(');
        const isFCall = nxt.t === 'op' && nxt.v === '(' && cur.t === 'id' && isFunc(cur.v);
        if (leftOk && rightOk && !isFCall) out.push({ t: 'op', v: '*' });
    }
    tokens = out;

    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];
    function parseExpr() {
        let l = parseTerm();
        while (peek() && (peek().v === '+' || peek().v === '-')) { const op = consume().v; const r = parseTerm(); l = op === '+' ? l.add(r) : l.sub(r); }
        return l;
    }
    function parseTerm() {
        let l = parsePow();
        while (peek() && (peek().v === '*' || peek().v === '/')) { const op = consume().v; const r = parsePow(); l = op === '*' ? l.mul(r) : l.div(r); }
        return l;
    }
    function parsePow() {
        const base = parseUnary();
        if (peek() && peek().v === '^') { consume(); return base.pow(parsePow()); }
        return base;
    }
    function parseUnary() {
        if (peek() && peek().v === '-') { consume(); return parseUnary().neg(); }
        if (peek() && peek().v === '+') { consume(); return parseUnary(); }
        return parseAtom();
    }
    function parseAtom() {
        const tok = peek();
        if (!tok) throw new Error('unexpected end');
        if (tok.t === 'n') { consume(); return new C(tok.v, 0); }
        if (tok.t === 'id') {
            consume();
            if (peek() && peek().v === '(') {
                consume();
                const arg = parseExpr();
                if (peek() && peek().v === ')') consume();
                if (tok.v === 'sqrt') return arg.sqrt();
                if (tok.v === 'cbrt') return arg.cbrt();
                if (CFUNCS_REAL[tok.v]) return CFUNCS_REAL[tok.v](arg);
                if (/^nrt(\d+)$/.test(tok.v)) return arg.nthRoot(parseInt(tok.v.slice(3)));
                throw new Error(`unknown fn: ${tok.v}`);
            }
            if (CCONSTS[tok.v]) return CCONSTS[tok.v];
            throw new Error(`unknown id: ${tok.v}`);
        }
        if (tok.t === 'op' && tok.v === '(') {
            consume(); const val = parseExpr();
            if (peek() && peek().v === ')') consume();
            return val;
        }
        throw new Error(`unexpected: ${JSON.stringify(tok)}`);
    }

    try {
        const result = parseExpr();
        if (!result.isReal()) return null;
        if (!isFinite(result.r) || isNaN(result.r)) return null;
        const rounded = Math.round(result.r);
        if (Math.abs(rounded) > 10_000_000) return null;
        return rounded;
    } catch { return null; }
}

function generateExpressions(n) {
    const cands = [], phi = (1 + Math.sqrt(5)) / 2;
    // ... rest of implementation (truncated in original upload)
    return cands.slice(0, 3);
}

// ─── Trigger Ruin ─────────────────────────────────────────────────────────────
async function triggerRuin(channel, gid, state, userId, reason) {
    const prev = state.current;
    state.current = state.countType === 'countdown' ? (state.countdownStart ?? 100) : 1;
    state.lastUserId = null;
    state.consecutiveCount = 0;
    updateUserStat(gid, userId, { ruined: 1 });

    if (state.saves > 0) {
        state.savesUsed = (state.savesUsed ?? 0) + 1;
        state.saves--;
        const expiresAt = Date.now() + 60000;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`save_use_${expiresAt}`).setLabel('Use Save').setStyle(ButtonStyle.Danger));
        const prompt = await channel.send({
            embeds: [E('#ff4444', '💥 Count ruined!').setDescription(`<@${userId}> ruined the count! (${reason})\nCount was at **${prev}**!`)
                .addFields({ name: 'Server saves', value: `**${state.saves + 1}**`, inline: true }, { name: 'At risk', value: `**${prev}**`, inline: true })],
            components: [row],
        }).catch(e => { console.error('triggerRuin save prompt failed:', e.message); return null; });
        if (!prompt) { saveState(gid, state); return; }
        state.pendingSave = { msgId: prompt.id, userId, prevCount: prev, expiresAt };
        saveState(gid, state);
        setTimeout(async () => {
            const fresh = await getState(gid);
            if (!fresh.pendingSave || fresh.pendingSave.expiresAt !== expiresAt) return;
            delete fresh.pendingSave;
            saveState(gid, fresh);
            const resetTo = fresh.countType === 'countdown' ? (fresh.countdownStart ?? 100) : 1;
            const expiredModNote = fresh.countType === 'random' ? `\nNew modifier: **${fresh.randomModifierLabel}**` : '';
            await prompt.edit({ embeds: [E('#ff4444', '💥 Save expired!').setDescription(`<@${userId}> didn't use their save in time. Count resets from **${prev}** to **${resetTo}**!${expiredModNote}`)], components: [] }).catch(() => {});
        }, 60_000);
    } else {
        saveState(gid, state);
        const resetTo = state.countType === 'countdown' ? (state.countdownStart ?? 100) : 1;
        const ruinModNote = state.countType === 'random' ? `\nNew modifier: **${state.randomModifierLabel}**` : '';
        await channel.send({ embeds: [E('#ff4444', '💥 Count ruined!').setDescription(`<@${userId}> ruined the count! (${reason})\nCount was at **${prev}**.${ruinModNote}`).addFields({ name: 'Reset to', value: `**${resetTo}**`, inline: true }, { name: 'High Score', value: `**${state.highScore}**`, inline: true }).setFooter({ text: `Start again from ${resetTo}!` })] }).catch(e => console.error('ruin msg failed:', e.message));
    }
}

// ─── Keep-alive ───────────────────────────────────────────────────────────────
function keepAlive() {
    const ping = () => {
        const u = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        (u.startsWith('https') ? require('https') : http).get(u, () => {}).on('error', () => {});
    };
    setTimeout(ping, 5000);
    setInterval(ping, 14 * 60 * 1000);
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    const cmds = [
        new SlashCommandBuilder().setName('count').setDescription('Get the current count or get 3 expressions for a number')
            .addStringOption(o => o.setName('input').setDescription('A number (e.g. 42) or expression (e.g. pi^2+1)').setRequired(true)),
        new SlashCommandBuilder().setName('setup').setDescription('Open the bot setup panel (admin only)'),
        new SlashCommandBuilder().setName('invite').setDescription('Invite this bot'),
        new SlashCommandBuilder().setName('help').setDescription('View all commands'),
    ].map(c => c.toJSON());
    await client.application.commands.set(cmds);
    console.log('Commands registered');
    try {
        await initDB();
        const r = await pool.query('SELECT guild_id,data FROM counting');
        for (const { guild_id, data } of r.rows) stateCache.set(guild_id, data);
        console.log(`Loaded ${r.rows.length} guild(s)`);
    } catch (e) { console.error('DB init failed:', e.message); }
    keepAlive();
});

// ─── Message counting ─────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    const gid = message.guild.id;
    const state = await getState(gid).catch(() => null);
    if (!state?.channelId || message.channel.id !== state.channelId) return;

    // Save pending check
    if (state.pendingSave) {
        if (Date.now() < state.pendingSave.expiresAt) return;
        delete state.pendingSave;
        saveState(gid, state);
    }

    const raw = message.content.trim();
    const hasConst = Object.keys(CONSTS).some(c => new RegExp(`(?<![a-z])${c}(?![a-z])`, 'i').test(raw));
    const isExpr = (/[+\-*/^()]/.test(raw) && !/^\-?\d+$/.test(raw)) || hasConst;
    if (!state.allowExpressions && isExpr) return;
    const value = safeMath(raw);
    if (value === null) return;

    // ── SIMPLE MODE ──
    if (state.countType === 'simple') {
        const expected = state.current + 1;
        if (value !== expected) return;
        const same = message.author.id === state.lastUserId;
        state.current = value;
        state.lastUserId = message.author.id;
        state.consecutiveCount = same ? state.consecutiveCount + 1 : 1;
        saveState(gid, state);
        updateUserStat(gid, message.author.id, { correct: 1 });
        await message.react('✅').catch(() => {});
        if (value % 100 === 0) await message.channel.send(`🎉 **${value}** reached!`);
        return;
    }

    // ── COUNTDOWN MODE ──
    if (state.countType === 'countdown') {
        const start = state.countdownStart ?? 100;
        if (state.current === 0 || state.current > start) state.current = start;
        const expected = state.current - 1;
        if (value !== expected) {
            if (!await claimMessage(message.id)) return;
            message.react('❌').catch(() => {});
            await triggerRuin(message.channel, gid, state, message.author.id, `sent \`${value}\` but expected \`${expected}\``);
            return;
        }
        const same = message.author.id === state.lastUserId;
        state.current = value;
        state.lastUserId = message.author.id;
        state.consecutiveCount = same ? state.consecutiveCount + 1 : 1;
        saveState(gid, state);
        updateUserStat(gid, message.author.id, { correct: 1 });
        await message.react(value <= 9 && value >= 0 ? ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'][value] : '✅').catch(() => {});
        if (value === 1) {
            state.countdownCycles = (state.countdownCycles ?? 0) + 1;
            state.current = start;
            state.lastUserId = null;
            state.consecutiveCount = 0;
            saveState(gid, state);
            await message.channel.send(`🎉 Cycle complete! Count reset to ${start}.`);
        }
        return;
    }

    // ── RANDOM MODE ──
    if (state.countType === 'random') {
        const mod = getModifier(state.randomModifier);
        const expected = mod.next(state.current);
        if (value !== expected) {
            if (!await claimMessage(message.id)) return;
            message.react('❌').catch(() => {});
            await triggerRuin(message.channel, gid, state, message.author.id, `sent \`${value}\` but expected \`${expected}\` (modifier: ${mod.label})`);
            return;
        }
        const same = message.author.id === state.lastUserId;
        state.current = value;
        state.lastUserId = message.author.id;
        state.consecutiveCount = same ? state.consecutiveCount + 1 : 1;
        if (value > state.highScore) state.highScore = value;
        saveState(gid, state);
        updateUserStat(gid, message.author.id, { correct: 1 });
        if (value % 50 === 0) { state.saves = (state.saves ?? 0) + 1; saveState(gid, state); }
        await message.react('✅').catch(() => {});
        return;
    }

    // ── INTERACTIVE MODE ──
    const expected = state.current + 1;
    if (value !== expected) {
        if (!await claimMessage(message.id)) return;
        message.react('❌').catch(() => {});
        await triggerRuin(message.channel, gid, state, message.author.id, `sent \`${value}\` but expected \`${expected}\``);
        return;
    }
    const same = message.author.id === state.lastUserId;
    state.current = value;
    state.lastUserId = message.author.id;
    state.consecutiveCount = same ? state.consecutiveCount + 1 : 1;
    if (value > state.highScore) state.highScore = value;
    saveState(gid, state);
    updateUserStat(gid, message.author.id, { correct: 1 });
    if (value % 50 === 0) { state.saves = (state.saves ?? 0) + 1; saveState(gid, state); }
    await message.react('✅').catch(() => {});
});

client.on('interactionCreate', async interaction => {
    const gid = interaction.guild?.id;
    if (interaction.isButton()) {
        const id = interaction.customId;
        // Logic for handling buttons (setup, pagination, stats, etc.)
        if (id === 'setup_refresh') {
            await interaction.deferUpdate();
            const state = await getState(gid);
            return interaction.editReply(buildSetupEmbed(state));
        }
        // ... (remaining handlers for setup, stats, leaderboard, etc.)
    }
});

process.on('unhandledRejection', e => console.error(e));
client.on('error', e => console.error('Discord error:', e));
client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { const ok = req.url === '/' || req.url === '/health'; res.writeHead(ok ? 200 : 404); res.end(); }).listen(PORT);
