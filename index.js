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
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 8000,       // kill queries that hang over 8s
    connectionTimeoutMillis: 5000, // fail fast if no connection available
});

// Pending saves: keyed by prompt message ID
const pendingSaves = new Map();

const PAGE_SIZE    = 25;
const SERVER_LB_MAX = 100; // max 4 pages for server leaderboard

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
    return { channelId: null, current: 0, lastUserId: null, consecutiveCount: 0,
             maxStreak: 1, allowExpressions: true, highScore: 0, accessRoleId: null };
}

// ── Stats DB ─────────────────────────────────────────────────────────────────
async function updateUserStat(guildId, userId, delta) {
    try {
        const res = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
        const cur = res.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
        for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + v;
        await pool.query(
            'INSERT INTO user_stats (guild_id,user_id,data) VALUES ($1,$2,$3) ON CONFLICT (guild_id,user_id) DO UPDATE SET data=$3',
            [guildId, userId, cur]
        );
        return cur;
    } catch (e) { console.error('updateUserStat:', e.message); return null; }
}

async function getUserStats(guildId, userId) {
    const res = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
    return res.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
}

async function getUserRank(guildId, userId) {
    const res = await pool.query(`
        SELECT COUNT(*)+1 AS rank FROM user_stats
        WHERE guild_id=$1
          AND COALESCE((data->>'correct')::int,0) > COALESCE(
              (SELECT (data->>'correct')::int FROM user_stats WHERE guild_id=$1 AND user_id=$2),0)
    `, [guildId, userId]);
    return parseInt(res.rows[0]?.rank ?? 1);
}

async function getServerStats(guildId) {
    const res = await pool.query(`
        SELECT COUNT(*) AS total_users,
               SUM(COALESCE((data->>'correct')::int,0)) AS total_correct,
               SUM(COALESCE((data->>'ruined')::int,0))  AS total_ruined
        FROM user_stats WHERE guild_id=$1
    `, [guildId]);
    return res.rows[0] ?? {};
}

// ── Paginated leaderboard queries ─────────────────────────────────────────────
async function getServerLbPage(guildId, page) {
    const cap    = SERVER_LB_MAX;
    const offset = Math.min((page - 1) * PAGE_SIZE, cap - PAGE_SIZE);
    const [rows, total] = await Promise.all([
        pool.query(`
            SELECT user_id, data FROM user_stats WHERE guild_id=$1
            ORDER BY COALESCE((data->>'correct')::int,0) DESC
            LIMIT $2 OFFSET $3
        `, [guildId, PAGE_SIZE, offset]),
        pool.query(`SELECT LEAST(COUNT(*), $2) AS cnt FROM user_stats WHERE guild_id=$1`, [guildId, cap]),
    ]);
    return { rows: rows.rows, total: parseInt(total.rows[0].cnt) };
}

async function getGlobalUsersPage(page) {
    const offset = (page - 1) * PAGE_SIZE;
    const [rows, total] = await Promise.all([
        pool.query(`
            SELECT user_id,
                   SUM(COALESCE((data->>'correct')::int,0)) AS correct,
                   SUM(COALESCE((data->>'ruined')::int,0))  AS ruined
            FROM user_stats GROUP BY user_id
            ORDER BY correct DESC
            LIMIT $1 OFFSET $2
        `, [PAGE_SIZE, offset]),
        pool.query(`SELECT COUNT(DISTINCT user_id) AS cnt FROM user_stats`),
    ]);
    return { rows: rows.rows, total: parseInt(total.rows[0].cnt) };
}

async function getGlobalServersCurrentPage(page) {
    // ranks by current score
    const offset = (page - 1) * PAGE_SIZE;
    const [rows, total] = await Promise.all([
        pool.query(`
            SELECT guild_id,
                   COALESCE((data->>'current')::int,0)   AS current_count,
                   COALESCE((data->>'highScore')::int,0)  AS high_score
            FROM counting
            ORDER BY current_count DESC
            LIMIT $1 OFFSET $2
        `, [PAGE_SIZE, offset]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting`),
    ]);
    return { rows: rows.rows, total: parseInt(total.rows[0].cnt) };
}

async function getHighscoresPage(page) {
    // ranks by all-time high score
    const offset = (page - 1) * PAGE_SIZE;
    const [rows, total] = await Promise.all([
        pool.query(`
            SELECT guild_id,
                   COALESCE((data->>'highScore')::int,0)  AS high_score,
                   COALESCE((data->>'current')::int,0)    AS current_count
            FROM counting
            ORDER BY high_score DESC
            LIMIT $1 OFFSET $2
        `, [PAGE_SIZE, offset]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting`),
    ]);
    return { rows: rows.rows, total: parseInt(total.rows[0].cnt) };
}

// ── Guild name helper ────────────────────────────────────────────────────────
async function guildName(id) {
    try {
        const g = client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null);
        return g ? g.name : `Server ${id}`;
    } catch { return `Server ${id}`; }
}

// ── Embed builders ────────────────────────────────────────────────────────────
async function buildUserStatsEmbed(guildId, targetUser) {
    const [stats, rank, state] = await Promise.all([
        getUserStats(guildId, targetUser.id),
        getUserRank(guildId, targetUser.id),
        getState(guildId),
    ]);
    const total    = (stats.correct || 0) + (stats.ruined || 0);
    const accuracy = total > 0 ? Math.round((stats.correct / total) * 100) : 100;
    const saves    = stats.saves ?? 0;
    const nextSave = 50 - ((stats.correct ?? 0) % 50);
    return new EmbedBuilder().setColor('#5865F2')
        .setTitle(`📊 Stats — ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: '✅ Correct counts',    value: `**${stats.correct ?? 0}**`, inline: true },
            { name: '💥 Times ruined',      value: `**${stats.ruined  ?? 0}**`, inline: true },
            { name: '🎯 Accuracy',          value: `**${accuracy}%**`,          inline: true },
            { name: '🏅 Server rank',       value: `**#${rank}**`,              inline: true },
            { name: '🔢 Current count',     value: `**${state.current}**`,      inline: true },
            { name: '🏆 Server high score', value: `**${state.highScore}**`,    inline: true },
            { name: '🛡️ Saves available',  value: `**${saves}**`,              inline: true },
            { name: '⏳ Next save in',      value: `**${nextSave}** counts`,    inline: true },
            { name: '🔖 Saves used',        value: `**${stats.savesUsed ?? 0}**`, inline: true },
        );
}

async function buildServerStatsEmbed(guild) {
    const [ss, state] = await Promise.all([getServerStats(guild.id), getState(guild.id)]);
    const tc = parseInt(ss.total_correct) || 0;
    const tr = parseInt(ss.total_ruined)  || 0;
    const tu = parseInt(ss.total_users)   || 0;
    const gt = tc + tr;
    const ac = gt > 0 ? Math.round((tc / gt) * 100) : 100;
    return new EmbedBuilder().setColor('#5865F2')
        .setTitle(`📊 Server Stats — ${guild.name}`)
        .setThumbnail(guild.iconURL())
        .addFields(
            { name: '👥 Active counters', value: `**${tu}**`,           inline: true },
            { name: '✅ Total correct',   value: `**${tc}**`,           inline: true },
            { name: '💥 Total ruined',    value: `**${tr}**`,           inline: true },
            { name: '🎯 Server accuracy', value: `**${ac}%**`,          inline: true },
            { name: '🔢 Current count',   value: `**${state.current}**`, inline: true },
            { name: '🏆 All-time high',   value: `**${state.highScore}**`, inline: true },
        );
}

async function buildServerLbEmbed(guildId, page) {
    const { rows, total } = await getServerLbPage(guildId, page);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const medals     = ['🥇', '🥈', '🥉'];
    const offset     = (page - 1) * PAGE_SIZE;
    if (!rows.length) return { embed: new EmbedBuilder().setColor('#5865F2').setTitle('🏆 Server Leaderboard').setDescription('No stats yet!'), totalPages: 1 };
    const lines = rows.map((r, i) => {
        const pos = offset + i + 1;
        return `${medals[i + offset] ?? `**${pos}.**`} <@${r.user_id}> — **${r.data.correct ?? 0}** counts${r.data.ruined ? ` *(${r.data.ruined} ruined)*` : ''}`;
    });
    return {
        embed: new EmbedBuilder().setColor('#5865F2').setTitle('🏆 Server Leaderboard')
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Page ${page}/${totalPages} · Showing ${offset+1}–${offset+rows.length} of ${total} counters` }),
        totalPages,
    };
}

async function buildGlobalUsersEmbed(page) {
    const { rows, total } = await getGlobalUsersPage(page);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const medals     = ['🥇', '🥈', '🥉'];
    const offset     = (page - 1) * PAGE_SIZE;
    if (!rows.length) return { embed: new EmbedBuilder().setColor('#5865F2').setTitle('🌍 Global — Users').setDescription('No stats yet!'), totalPages: 1 };
    const lines = rows.map((r, i) => {
        const pos = offset + i + 1;
        return `${medals[i + offset] ?? `**${pos}.**`} <@${r.user_id}> — **${parseInt(r.correct)}** counts total`;
    });
    return {
        embed: new EmbedBuilder().setColor('#5865F2').setTitle('🌍 Global Leaderboard — Users')
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Page ${page}/${totalPages} · Showing ${offset+1}–${offset+rows.length} of ${total} users` }),
        totalPages,
    };
}

async function buildGlobalServersEmbed(page) {
    const { rows, total } = await getGlobalServersCurrentPage(page);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const medals     = ['🥇', '🥈', '🥉'];
    const offset     = (page - 1) * PAGE_SIZE;
    if (!rows.length) return { embed: new EmbedBuilder().setColor('#5865F2').setTitle('🌍 Global — Servers').setDescription('No stats yet!'), totalPages: 1 };
    const lines = await Promise.all(rows.map(async (r, i) => {
        const pos  = offset + i + 1;
        const name = await guildName(r.guild_id);
        return `${medals[i + offset] ?? `**${pos}.**`} **${name}** — 🔢 Current **${r.current_count}**`;
    }));
    return {
        embed: new EmbedBuilder().setColor('#5865F2').setTitle('🌍 Global Leaderboard — Servers (Current Score)')
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Page ${page}/${totalPages} · Ranked by current count` }),
        totalPages,
    };
}

async function buildHighscoresEmbed(page) {
    const { rows, total } = await getHighscoresPage(page);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const medals     = ['🥇', '🥈', '🥉'];
    const offset     = (page - 1) * PAGE_SIZE;
    if (!rows.length) return { embed: new EmbedBuilder().setColor('#5865F2').setTitle('🏅 High Score Leaderboard').setDescription('No data yet!'), totalPages: 1 };
    const lines = await Promise.all(rows.map(async (r, i) => {
        const pos  = offset + i + 1;
        const name = await guildName(r.guild_id);
        return `${medals[i + offset] ?? `**${pos}.**`} **${name}** — 🏆 Best **${r.high_score}** · Current **${r.current_count}**`;
    }));
    return {
        embed: new EmbedBuilder().setColor('#5865F2').setTitle('🏅 All-Time High Score Leaderboard')
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Page ${page}/${totalPages} · Ranked by all-time high score` }),
        totalPages,
    };
}

// ── Component row builders ────────────────────────────────────────────────────
function statsRow(targetUserId, guildId, activePage) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stats_user_${targetUserId}_${guildId}`).setLabel('👤 User Stats')
            .setStyle(activePage === 'user' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`stats_server_${targetUserId}_${guildId}`).setLabel('🏠 Server Stats')
            .setStyle(activePage === 'server' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
}

// type: 'gu'=global users, 'gs'=global servers, 'hs'=highscores, 'sv'=server
// ctx: guildId for 'sv', empty for others
function paginationRow(type, ctx, page, totalPages) {
    const base = ctx ? `lb_${type}_${ctx}` : `lb_${type}`;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${base}_p${page - 1}`).setLabel('◀ Prev')
            .setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
        new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`Page ${page} / ${totalPages}`)
            .setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`${base}_p${page + 1}`).setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
        new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('🔄')
            .setStyle(ButtonStyle.Secondary),
    );
}

function globalTabRow(activeTab) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lbt_gu').setLabel('👤 Users')
            .setStyle(activeTab === 'gu' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lbt_gs').setLabel('🏠 Servers')
            .setStyle(activeTab === 'gs' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
}

// ── Safe math evaluator ──────────────────────────────────────────────────────
const CONSTANTS = { phi: (1+Math.sqrt(5))/2, pi: Math.PI, e: Math.E, tau: Math.PI*2, sqrt2: Math.SQRT2 };

function safeMath(expr) {
    let cleaned = expr.trim().toLowerCase().replace(/\s+/g, '');
    if (!cleaned) return null;
    for (const [name, val] of Object.entries(CONSTANTS)) cleaned = cleaned.replaceAll(name, `(${val})`);
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
            const base = Math.round(Math.pow(val, exp)), diff = n - base;
            if (diff !== 0 && Math.abs(diff) <= 20) candidates.push(`${name}^${exp}${diff > 0 ? '+'+diff : diff}`);
        }
    }
    if (n > 4) for (let a = 2; a <= Math.sqrt(n); a++) if (n % a === 0) { candidates.push(`${a}*${n/a}`); break; }
    if (n > 8) { outer: for (let a = 2; a <= Math.cbrt(n); a++) if (n % a === 0) { const rest=n/a; for (let b=a;b<=Math.sqrt(rest);b++) if (rest%b===0){candidates.push(`${a}*${b}*${rest/b}`);break outer;} } }
    if (n > 2) { const a = Math.max(1, Math.floor(n*0.35)); candidates.push(`${a}+${n-a}`); }
    candidates.push(`${n+Math.round(n*0.6)+1}-${Math.round(n*0.6)+1}`);
    candidates.push(`${n*(n<=10?2:3)}/${n<=10?2:3}`);
    if (n > 5) for (let a=2;a<=10;a++){const base=Math.floor(n/a)*a,diff=n-base;if(base>0&&diff>0&&diff<a){candidates.push(`${a}*${Math.floor(n/a)}+${diff}`);break;}}
    const seen=new Set(),result=[];
    for (const c of candidates.sort((a,b)=>(/[a-z]/.test(b)?1:0)-(/[a-z]/.test(a)?1:0)||a.length-b.length))
        if(!seen.has(c)&&result.length<3){seen.add(c);result.push(c);}
    if(result.length<3)result.push(`${n-1}+1`);
    if(result.length<3)result.push(`${n*2}/2`);
    if(result.length<3)result.push(`${n+3}-3`);
    return result.slice(0,3);
}

// ── Help pages ───────────────────────────────────────────────────────────────
function buildHelpPage(page) {
    const embeds = [
        new EmbedBuilder().setColor('#5865F2').setTitle('🎮 How to Play')
            .setDescription('Count up together in the counting channel! One number at a time — anyone who breaks the chain resets it back to 1.')
            .addFields(
                { name: '📌 Rules', value: '• Type the next number in the sequence\n• You can\'t count twice in a row (by default)\n• Wrong number? The count resets to 1!\n• Math expressions like `2+2`, `pi^2` are supported' },
                { name: '✅ Correct count', value: 'React gets added, count goes up' },
                { name: '❌ Wrong / too fast', value: 'Count resets — everyone starts over!' },
                { name: '🏆 Milestones', value: 'The bot celebrates every 100 counts' },
                { name: '🛡️ Saves', value: 'Earn 1 save every 50 correct counts. If you ruin the count, a save lets you undo it within 15 seconds!' },
            ).setFooter({ text: 'Page 1/4 • Counting Bot' }),
        new EmbedBuilder().setColor('#5865F2').setTitle('📋 Commands')
            .setDescription('All available commands:')
            .addFields(
                { name: '🔢 Counting', value: '`/counting channel` — set the counting channel\n`/counting status` — view current count & settings\n`/counting reset` — reset the count *(requires permission)*' },
                { name: '📊 Stats & Leaderboards', value: '`/stats [user]` — view stats with user/server tabs\n`/leaderboard server` — paginated server leaderboard (100 users)\n`/leaderboard global` — global users & servers, 25/page\n`/leaderboard highscores` — servers ranked by all-time high score' },
                { name: '🛠️ Utilities', value: '`/calculate <number>` — get 3 expressions for any number\n`/invite` — get the bot invite link\n`/help` — this menu' },
            ).setFooter({ text: 'Page 2/4 • Counting Bot' }),
        new EmbedBuilder().setColor('#5865F2').setTitle('⚙️ Config & Admin')
            .setDescription('Admin & configuration commands. Requires **Administrator** or the configured access role.')
            .addFields(
                { name: '⚙️ /config maxstreak <n>', value: 'How many times one person can count in a row (1–20). Default: **1**' },
                { name: '⚙️ /config expressions <bool>', value: 'Allow or block math expressions. Default: **enabled**' },
                { name: '🔒 /config access', value: 'Pick a role that can use config commands. Admins always have access.' },
                { name: '📍 /counting channel', value: 'Set or change the counting channel.' },
                { name: '🔄 /counting reset', value: 'Manually reset the count back to 0.' },
            ).setFooter({ text: 'Page 3/4 • Counting Bot' }),
        new EmbedBuilder().setColor('#5865F2').setTitle('🧮 Expressions')
            .setDescription('When expressions are enabled, you can type math instead of plain numbers. The result is **rounded** to the nearest whole number.')
            .addFields(
                { name: '➕ Operators', value: '`+` add  •  `-` subtract  •  `*` multiply  •  `/` divide  •  `^` power' },
                { name: '📐 Constants', value: '`pi` ≈ 3.14159\n`phi` ≈ 1.61803 *(golden ratio)*\n`e` ≈ 2.71828\n`tau` ≈ 6.28318\n`sqrt2` ≈ 1.41421' },
                { name: '💡 Examples', value: '`2+2` → **4**\n`pi^2` → **10**\n`phi^10` → **11**\n`phi+phi^pi+pi` → **9**\n`2^8` → **256**' },
                { name: '🧮 /calculate', value: 'Use `/calculate <number>` to get 3 ready-made expressions for any number!' },
            ).setFooter({ text: 'Page 4/4 • Counting Bot' }),
    ];
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_1').setLabel('How to Play').setStyle(page===1?ButtonStyle.Primary:ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_2').setLabel('Commands').setStyle(page===2?ButtonStyle.Primary:ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_3').setLabel('Config').setStyle(page===3?ButtonStyle.Primary:ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_4').setLabel('Expressions').setStyle(page===4?ButtonStyle.Primary:ButtonStyle.Secondary),
    );
    return { embeds: [embeds[page-1]], components: [row] };
}

// ── Misc helpers ──────────────────────────────────────────────────────────────
function E(color, title) { return new EmbedBuilder().setColor(color).setTitle(title); }

async function hasPermission(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const state = await getState(guildId);
    return state.accessRoleId ? interaction.member.roles.cache.has(state.accessRoleId) : false;
}

// ── Save helpers ─────────────────────────────────────────────────────────────
async function triggerRuin(channel, guildId, state, userId, reason) {
    const prev  = state.current;
    const stats = await getUserStats(guildId, userId);
    const hasSave = (stats.saves ?? 0) > 0;

    if (hasSave) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`saveuse_${userId}`).setLabel(`🛡️ Use Save (${stats.saves} left)`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`savedecline_${userId}`).setLabel('❌ Let it reset').setStyle(ButtonStyle.Danger),
        );
        const prompt = await channel.send({
            embeds: [E('#ff9900', '⚠️ Count almost ruined!')
                .setDescription(`<@${userId}> made a mistake! (${reason})\n\n<@${userId}>, you have a **🛡️ Save** — use it within **15 seconds** to keep the count at **${prev}**!`)
                .addFields(
                    { name: '🛡️ Saves available', value: `**${stats.saves}**`, inline: true },
                    { name: '🔢 Count at risk',    value: `**${prev}**`,        inline: true },
                )],
            components: [row],
        }).catch(() => null);

        if (!prompt) { doReset(channel, guildId, state, userId); return; }

        const timeoutId = setTimeout(async () => {
            if (!pendingSaves.has(prompt.id)) return;
            pendingSaves.delete(prompt.id);
            doReset(channel, guildId, state, userId);
            await prompt.edit({
                embeds: [E('#ff4444', '💥 Save expired — count ruined!')
                    .setDescription(`<@${userId}> didn't use their save in time! The count resets from **${prev}** back to **1**.`)
                    .addFields({ name: '🏆 High Score', value: `**${state.highScore}**`, inline: true })],
                components: [],
            }).catch(() => {});
        }, 15_000);

        pendingSaves.set(prompt.id, { guildId, userId, prevCount: prev, timeoutId, state: { ...state } });
    } else {
        doReset(channel, guildId, state, userId);
        await channel.send({
            embeds: [E('#ff4444', '💥 Count ruined!')
                .setDescription(`<@${userId}> ruined the count! (${reason})\nThe count was at **${prev}**.`)
                .addFields({ name: '🔄 Reset to', value: '**1**', inline: true }, { name: '🏆 High Score', value: `**${state.highScore}**`, inline: true })
                .setFooter({ text: 'Start again from 1!' })],
        }).catch(() => {});
    }
}

function doReset(channel, guildId, state, userId) {
    state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
    saveState(guildId, state);
    updateUserStat(guildId, userId, { ruined: 1 });
}

// ── Keep-alive ───────────────────────────────────────────────────────────────
function keepAlive() {
    const ping = () => {
        const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT||3000}`;
        const mod = url.startsWith('https') ? require('https') : http;
        mod.get(url, () => {}).on('error', () => {});
    };
    setTimeout(ping, 5000);
    setInterval(ping, 14*60*1000);
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
                .addIntegerOption(o => o.setName('amount').setDescription('Max consecutive counts (1–20)').setRequired(true).setMinValue(1).setMaxValue(20)))
            .addSubcommand(s => s.setName('expressions').setDescription('Allow or disallow math expressions like 1+1')
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable expressions').setRequired(true)))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can use config commands')),

        new SlashCommandBuilder().setName('leaderboard').setDescription('View counting leaderboards')
            .addSubcommand(s => s.setName('server').setDescription('Top counters in this server (up to 100, paginated)'))
            .addSubcommand(s => s.setName('global').setDescription('Global leaderboard — users & servers, 25 per page'))
            .addSubcommand(s => s.setName('highscores').setDescription('Servers ranked by all-time high score, 25 per page')),

        new SlashCommandBuilder().setName('stats').setDescription('View counting stats')
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
    const state   = await getState(guildId).catch(() => null);
    if (!state?.channelId || message.channel.id !== state.channelId) return;

    // Block new counts while a save prompt is pending for this guild
    if ([...pendingSaves.values()].some(p => p.guildId === guildId)) return;

    const raw      = message.content.trim();
    const hasConst = Object.keys(CONSTANTS).some(c => raw.toLowerCase().includes(c));
    const isExpr   = (/[+\-*/^()]/.test(raw) && !/^\-?\d+$/.test(raw)) || hasConst;

    if (isExpr && !state.allowExpressions) {
        await message.react('❌').catch(() => {});
        const sent = await message.channel.send({
            embeds: [E('#ff4444', '❌ Expressions disabled').setDescription(`Expressions like \`${raw}\` are not allowed here. Just type the plain number!`)]
        }).catch(() => null);
        if (sent) setTimeout(() => sent.delete().catch(() => {}), 5000);
        return;
    }

    const value = safeMath(raw);
    if (value === null) return;

    const expected = state.current + 1;

    if (value !== expected) {
        await message.react('❌').catch(() => {});
        await triggerRuin(message.channel, guildId, state, message.author.id, `sent \`${value}\` but expected \`${expected}\``);
        return;
    }

    if (state.maxStreak > 0 && message.author.id === state.lastUserId && state.consecutiveCount >= state.maxStreak) {
        await message.react('❌').catch(() => {});
        await triggerRuin(message.channel, guildId, state, message.author.id, `counted more than **${state.maxStreak}** time(s) in a row`);
        return;
    }

    const isSameUser = message.author.id === state.lastUserId;
    state.current = value;
    state.lastUserId = message.author.id;
    state.consecutiveCount = isSameUser ? state.consecutiveCount + 1 : 1;
    if (value > state.highScore) state.highScore = value;
    saveState(guildId, state);

    const newStats = await updateUserStat(guildId, message.author.id, { correct: 1 });
    if (newStats && newStats.correct > 0 && newStats.correct % 50 === 0) {
        await updateUserStat(guildId, message.author.id, { saves: 1 });
        await message.channel.send({
            embeds: [E('#ffd700', '🛡️ Save earned!')
                .setDescription(`<@${message.author.id}> earned a **Save** for reaching **${newStats.correct}** correct counts!\nYou now have **${(newStats.saves ?? 0) + 1}** save(s). Use it if you ever ruin the count!`)]
        }).catch(() => {});
    }

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

    // ── Buttons ───────────────────────────────────────────────────────────────
    if (interaction.isButton()) {

        // Help navigation
        if (interaction.customId.startsWith('help_')) {
            const page = parseInt(interaction.customId.split('_')[1]);
            if (!isNaN(page) && page >= 1 && page <= 4) return interaction.update(buildHelpPage(page));
        }

        // Save: use
        if (interaction.customId.startsWith('saveuse_')) {
            const ownerId = interaction.customId.split('_')[1];
            if (interaction.user.id !== ownerId)
                return interaction.reply({ content: '❌ Only the person who ruined the count can use their save!', flags: [MessageFlags.Ephemeral] });
            const pending = pendingSaves.get(interaction.message.id);
            if (!pending) return interaction.reply({ content: '❌ This save prompt has already expired.', flags: [MessageFlags.Ephemeral] });
            clearTimeout(pending.timeoutId);
            pendingSaves.delete(interaction.message.id);
            const state = await getState(pending.guildId);
            state.current = pending.prevCount; state.lastUserId = ownerId; state.consecutiveCount = 1;
            saveState(pending.guildId, state);
            await updateUserStat(pending.guildId, ownerId, { saves: -1, savesUsed: 1 });
            const updated = await getUserStats(pending.guildId, ownerId);
            return interaction.update({
                embeds: [E('#00cc88', '🛡️ Save used!')
                    .setDescription(`<@${ownerId}> used a **Save** — the count stays at **${pending.prevCount}**!`)
                    .addFields({ name: '🛡️ Saves remaining', value: `**${updated.saves ?? 0}**`, inline: true }, { name: '🔢 Count continues at', value: `**${pending.prevCount}**`, inline: true })],
                components: [],
            });
        }

        // Save: decline
        if (interaction.customId.startsWith('savedecline_')) {
            const ownerId = interaction.customId.split('_')[1];
            if (interaction.user.id !== ownerId)
                return interaction.reply({ content: '❌ Only the person who ruined the count can decline.', flags: [MessageFlags.Ephemeral] });
            const pending = pendingSaves.get(interaction.message.id);
            if (!pending) return interaction.reply({ content: '❌ This save prompt has already expired.', flags: [MessageFlags.Ephemeral] });
            clearTimeout(pending.timeoutId);
            pendingSaves.delete(interaction.message.id);
            doReset(null, pending.guildId, pending.state, ownerId);
            return interaction.update({
                embeds: [E('#ff4444', '💥 Count ruined!')
                    .setDescription(`<@${ownerId}> chose not to use their save. The count resets from **${pending.prevCount}** back to **1**.`)
                    .addFields({ name: '🏆 High Score', value: `**${pending.state.highScore}**`, inline: true })],
                components: [],
            });
        }

        // Stats tabs
        if (interaction.customId.startsWith('stats_')) {
            await interaction.deferUpdate();
            const parts = interaction.customId.split('_');
            const view = parts[1], tuid = parts[2], bgid = parts[3];
            try {
                if (view === 'user') {
                    const u = await client.users.fetch(tuid).catch(() => interaction.user);
                    return interaction.editReply({ embeds: [await buildUserStatsEmbed(bgid, u)], components: [statsRow(tuid, bgid, 'user')] });
                }
                if (view === 'server') {
                    const g = client.guilds.cache.get(bgid) ?? await client.guilds.fetch(bgid).catch(() => interaction.guild);
                    return interaction.editReply({ embeds: [await buildServerStatsEmbed(g)], components: [statsRow(tuid, bgid, 'server')] });
                }
            } catch (e) { console.error('stats button:', e); return interaction.editReply({ content: '❌ Failed to load stats.' }); }
        }

        // Global leaderboard tab buttons (lbt_ prefix avoids colliding with pagination lb_ buttons)
        if (interaction.customId === 'lbt_gu' || interaction.customId === 'lbt_gs') {
            await interaction.deferUpdate();
            try {
                if (interaction.customId === 'lbt_gu') {
                    const { embed, totalPages } = await buildGlobalUsersEmbed(1);
                    return interaction.editReply({ embeds: [embed], components: [globalTabRow('gu'), paginationRow('gu', '', 1, totalPages)] });
                }
                if (interaction.customId === 'lbt_gs') {
                    const { embed, totalPages } = await buildGlobalServersEmbed(1);
                    return interaction.editReply({ embeds: [embed], components: [globalTabRow('gs'), paginationRow('gs', '', 1, totalPages)] });
                }
            } catch (e) {
                console.error('global tab button:', e);
                await interaction.editReply({ content: '❌ Failed to load leaderboard. Try again in a moment.' }).catch(() => {});
            }
        }

        // Leaderboard pagination — customId format: lb_{type}[_{ctx}]_p{N} or lb_{type}[_{ctx}]_info
        if (interaction.customId.startsWith('lb_')) {
            // Parse BEFORE deferring so we can bail cleanly without leaving Discord stuck
            const id      = interaction.customId;
            const lastSeg = id.split('_').pop();
            // Disabled info button — just ack with no visual change
            if (lastSeg === 'info') return interaction.deferUpdate();
            const page = parseInt(lastSeg.replace('p', ''));
            if (isNaN(page) || page < 1) return interaction.deferUpdate();
            const seg2 = id.split('_')[1];

            await interaction.deferUpdate();
            try {
                if (seg2 === 'gu') {
                    const { embed, totalPages } = await buildGlobalUsersEmbed(page);
                    return interaction.editReply({ embeds: [embed], components: [globalTabRow('gu'), paginationRow('gu', '', page, totalPages)] });
                }
                if (seg2 === 'gs') {
                    const { embed, totalPages } = await buildGlobalServersEmbed(page);
                    return interaction.editReply({ embeds: [embed], components: [globalTabRow('gs'), paginationRow('gs', '', page, totalPages)] });
                }
                if (seg2 === 'hs') {
                    const { embed, totalPages } = await buildHighscoresEmbed(page);
                    return interaction.editReply({ embeds: [embed], components: [paginationRow('hs', '', page, totalPages)] });
                }
                if (seg2 === 'sv') {
                    const svGuildId = id.split('_')[2];
                    const { embed, totalPages } = await buildServerLbEmbed(svGuildId, page);
                    return interaction.editReply({ embeds: [embed], components: [paginationRow('sv', svGuildId, page, totalPages)] });
                }
            } catch (e) {
                console.error('lb button:', e);
                await interaction.editReply({ content: '❌ Failed to load leaderboard. Try again in a moment.' }).catch(() => {});
            }
        }

        return;
    }

    // ── Role select ───────────────────────────────────────────────────────────
    if (interaction.isRoleSelectMenu()) {
        if (!interaction.customId.startsWith('access_role_')) return;
        const roleId = interaction.values[0];
        const state  = await getState(guildId);
        state.accessRoleId = roleId;
        saveState(guildId, state);
        return interaction.update({
            embeds: [E('#5865F2', '✅ Access role updated').setDescription(`<@&${roleId}> can now use config commands.`)],
            components: [],
        });
    }

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return interaction.reply({ content: '❌ This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });

    const { commandName, options } = interaction;

    try {

        if (commandName === 'help')
            return interaction.reply({ ...buildHelpPage(1), flags: [MessageFlags.Ephemeral] });

        if (commandName === 'invite') {
            const url = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=76864&scope=bot%20applications.commands`;
            return interaction.reply({
                embeds: [E('#5865F2', '📨 Invite Counting Bot')
                    .setDescription(`[**Click here to invite me to your server!**](${url})`)
                    .addFields({ name: '🔐 Permissions requested', value: '• View Channels\n• Send Messages\n• Add Reactions\n• Read Message History\n• Manage Messages' })
                    .setFooter({ text: 'After inviting, use /counting channel to set up!' })],
                flags: [MessageFlags.Ephemeral],
            });
        }

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
                    .setFooter({ text: 'Supports: + - * / ^ pi phi e tau sqrt2' })],
            });
        }

        if (commandName === 'stats') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const targetUser = options.getUser('user') ?? interaction.user;
            return interaction.editReply({
                embeds: [await buildUserStatsEmbed(guildId, targetUser)],
                components: [statsRow(targetUser.id, guildId, 'user')],
            });
        }

        if (commandName === 'leaderboard') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const sub = options.getSubcommand();

            if (sub === 'server') {
                const { embed, totalPages } = await buildServerLbEmbed(guildId, 1);
                return interaction.editReply({ embeds: [embed], components: [paginationRow('sv', guildId, 1, totalPages)] });
            }

            if (sub === 'global') {
                const { embed, totalPages } = await buildGlobalUsersEmbed(1);
                return interaction.editReply({ embeds: [embed], components: [globalTabRow('gu'), paginationRow('gu', '', 1, totalPages)] });
            }

            if (sub === 'highscores') {
                const { embed, totalPages } = await buildHighscoresEmbed(1);
                return interaction.editReply({ embeds: [embed], components: [paginationRow('hs', '', 1, totalPages)] });
            }
        }

        if (commandName === 'config') {
            const sub = options.getSubcommand();

            if (sub === 'access') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                    return interaction.reply({ content: '❌ Only server administrators can change the access role.', flags: [MessageFlags.Ephemeral] });
                const state = await getState(guildId);
                return interaction.reply({
                    embeds: [E('#5865F2', '🔒 Access Configuration')
                        .setDescription('Select which role can use `/config` commands.\n\n**Note:** Administrators always have access regardless.')
                        .addFields({ name: 'Current access role', value: state.accessRoleId ? `<@&${state.accessRoleId}>` : 'None *(admins only)*' })],
                    components: [new ActionRowBuilder().addComponents(
                        new RoleSelectMenuBuilder().setCustomId(`access_role_${guildId}`)
                            .setPlaceholder('Select a role for config access').setMinValues(1).setMaxValues(1)
                    )],
                    flags: [MessageFlags.Ephemeral],
                });
            }

            if (!await hasPermission(interaction, guildId))
                return interaction.reply({ content: '❌ You don\'t have permission to use config commands.', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const state = await getState(guildId);

            if (sub === 'maxstreak') {
                const amount = options.getInteger('amount');
                state.maxStreak = amount; saveState(guildId, state);
                return interaction.editReply({
                    embeds: [E('#5865F2', '✅ Max streak updated').setDescription(amount === 1
                        ? 'Users can no longer count twice in a row.'
                        : `Users can now count **${amount}** times in a row before someone else must count.`)]
                });
            }
            if (sub === 'expressions') {
                const enabled = options.getBoolean('enabled');
                state.allowExpressions = enabled; saveState(guildId, state);
                return interaction.editReply({
                    embeds: [E('#5865F2', `✅ Expressions ${enabled ? 'enabled' : 'disabled'}`).setDescription(enabled
                        ? 'Users can now count with expressions like `1+1`, `3*4`, `2^3`, etc.'
                        : 'Only plain numbers are now accepted in the counting channel.')]
                });
            }
        }

        if (commandName === 'counting') {
            const sub = options.getSubcommand();

            if (sub === 'status') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const state = await getState(guildId);
                return interaction.editReply({
                    embeds: [E('#5865F2', '📊 Counting Status').addFields(
                        { name: '📍 Channel',       value: state.channelId ? `<#${state.channelId}>` : 'Not set',           inline: true },
                        { name: '🔢 Current count', value: `**${state.current}**`,                                           inline: true },
                        { name: '🏆 High score',    value: `**${state.highScore}**`,                                         inline: true },
                        { name: '🔁 Max streak',    value: `**${state.maxStreak}** in a row`,                                inline: true },
                        { name: '🧮 Expressions',   value: state.allowExpressions ? '✅ Allowed' : '❌ Disabled',            inline: true },
                        { name: '👤 Last counter',  value: state.lastUserId ? `<@${state.lastUserId}>` : 'Nobody yet',       inline: true },
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
                state.channelId = ch.id; saveState(guildId, state);
                return interaction.editReply({
                    embeds: [E('#5865F2', '✅ Counting channel set').setDescription(`The counting channel has been set to ${ch}.\nStart counting from **1**!`)]
                });
            }
            if (sub === 'reset') {
                const prev = state.current;
                state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
                saveState(guildId, state);
                if (state.channelId) {
                    const ch = interaction.guild.channels.cache.get(state.channelId);
                    if (ch) ch.send({ embeds: [E('#ff9900', '🔄 Count manually reset').setDescription(`An admin reset the count from **${prev}** back to 0.\nStart again from **1**!`)] }).catch(() => {});
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
