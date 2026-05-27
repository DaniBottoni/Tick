const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits,
        EmbedBuilder, ActivityType, MessageFlags, ActionRowBuilder,
        ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType } = require('discord.js');
const { Pool } = require('pg');
require('dns').setDefaultResultOrder('ipv4first');
const http = require('http');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 8000, connectionTimeoutMillis: 5000 });
const stateCache = new Map();
const PS = 25, SLB_MAX = 100;

// DB 
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
    return { channelId: null, current: 0, lastUserId: null, consecutiveCount: 0, maxStreak: 1, allowExpressions: true, highScore: 0, accessRoleId: null, countType: 'interactive', saves: 0, savesUsed: 0 };
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

// Stats 
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

// Paginated queries 
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
async function getGlobalServersPage(page) {
    const off = (page - 1) * PS;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, COALESCE((data->>'current')::int,0) AS cur, COALESCE((data->>'highScore')::int,0) AS hs FROM counting ORDER BY cur DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getHighscoresPage(page) {
    const off = (page - 1) * PS;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, COALESCE((data->>'highScore')::int,0) AS hs, COALESCE((data->>'current')::int,0) AS cur FROM counting ORDER BY hs DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}

// Helpers 
const M = ['🥇', '🥈', '🥉'];
const E = (color, title) => new EmbedBuilder().setColor(color).setTitle(title);
const ep = () => ({ flags: [MessageFlags.Ephemeral] });

async function guildName(id) {
    try { const g = client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null); return g ? g.name : `Server ${id}`; }
    catch { return `Server ${id}`; }
}
async function hasPerm(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const s = await getState(guildId);
    return s.accessRoleId ? interaction.member.roles.cache.has(s.accessRoleId) : false;
}

// Embed builders 
async function buildUserStatsEmbed(gid, user) {
    const [st, rank, gs] = await Promise.all([getUserStats(gid, user.id), getUserRank(gid, user.id), getState(gid)]);
    const tot = (st.correct || 0) + (st.ruined || 0), acc = tot > 0 ? Math.round((st.correct / tot) * 100) : 100;
    return E('#5865F2', `📊 Stats — ${user.username}`).setThumbnail(user.displayAvatarURL()).addFields(
        { name: '✅ Correct',      value: `**${st.correct ?? 0}**`,  inline: true },
        { name: '💥 Ruined',       value: `**${st.ruined ?? 0}**`,   inline: true },
        { name: '🎯 Accuracy',     value: `**${acc}%**`,             inline: true },
        { name: '🏅 Rank',         value: `**#${rank}**`,            inline: true },
        { name: '🔢 Current',      value: `**${gs.current}**`,       inline: true },
        { name: '🏆 High score',   value: `**${gs.highScore}**`,     inline: true },
        { name: '🛡️ Server saves', value: `**${gs.saves ?? 0}**`,   inline: true },
        { name: '🔖 Saves used',   value: `**${gs.savesUsed ?? 0}**`, inline: true },
    );
}
async function buildServerStatsEmbed(guild) {
    const [ss, gs] = await Promise.all([getServerStats(guild.id), getState(guild.id)]);
    const tc = parseInt(ss.tc) || 0, tr = parseInt(ss.tr) || 0, tu = parseInt(ss.tu) || 0, gt = tc + tr, ac = gt > 0 ? Math.round((tc / gt) * 100) : 100;
    return E('#5865F2', `📊 Server Stats — ${guild.name}`).setThumbnail(guild.iconURL()).addFields(
        { name: '👥 Counters',   value: `**${tu}**`,           inline: true },
        { name: '✅ Correct',    value: `**${tc}**`,           inline: true },
        { name: '💥 Ruined',     value: `**${tr}**`,           inline: true },
        { name: '🎯 Accuracy',   value: `**${ac}%**`,          inline: true },
        { name: '🔢 Current',    value: `**${gs.current}**`,   inline: true },
        { name: '🏆 High score', value: `**${gs.highScore}**`, inline: true },
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
    return { totalPages: tp, embed: E('#5865F2', '🌍 Global Leaderboard — Users')
        .setDescription(rows.map((r, i) => `${M[off + i] ?? `**${off + i + 1}.**`} <@${r.user_id}> — **${parseInt(r.correct)}** counts`).join('\n'))
        .setFooter({ text: `Page ${page}/${tp} · ${off + 1}–${off + rows.length} of ${total} users` }) };
}
async function buildGlobalServersEmbed(page) {
    const { rows, total } = await getGlobalServersPage(page);
    const tp = Math.max(1, Math.ceil(total / PS)), off = (page - 1) * PS;
    if (!rows.length) return { embed: E('#5865F2', '🌍 Global — Servers').setDescription('No stats yet!'), totalPages: 1 };
    const lines = await Promise.all(rows.map(async (r, i) => `${M[off + i] ?? `**${off + i + 1}.**`} **${await guildName(r.guild_id)}** — 🔢 **${r.cur}**`));
    return { totalPages: tp, embed: E('#5865F2', '🌍 Global Leaderboard — Servers').setDescription(lines.join('\n')).setFooter({ text: `Page ${page}/${tp} · ranked by current count` }) };
}
async function buildHighscoresEmbed(page) {
    const { rows, total } = await getHighscoresPage(page);
    const tp = Math.max(1, Math.ceil(total / PS)), off = (page - 1) * PS;
    if (!rows.length) return { embed: E('#5865F2', '🏅 High Score Leaderboard').setDescription('No data yet!'), totalPages: 1 };
    const lines = await Promise.all(rows.map(async (r, i) => `${M[off + i] ?? `**${off + i + 1}.**`} **${await guildName(r.guild_id)}** — 🏆 **${r.hs}** · 🔢 ${r.cur}`));
    return { totalPages: tp, embed: E('#5865F2', '🏅 All-Time High Score Leaderboard').setDescription(lines.join('\n')).setFooter({ text: `Page ${page}/${tp} · ranked by all-time high score` }) };
}

// Setup embed 
function buildSetupEmbed(state) {
    const ct = state.countType ?? 'interactive';
    return {
        embeds: [E('#5865F2', '⚙️ Counting Bot — Setup')
            .setDescription('Use the buttons below to configure the bot. All settings are saved instantly.')
            .addFields(
                { name: '📍 Counting Channel', value: state.channelId ? `<#${state.channelId}>` : 'Not set',                              inline: true },
                { name: '🎮 Count Type',        value: ct === 'interactive' ? '🎮 Interactive' : '🟢 Simple',                             inline: true },
                { name: '🔁 Max Streak',        value: `**${state.maxStreak}** in a row`,                                                  inline: true },
                { name: '🧮 Expressions',       value: state.allowExpressions ? 'Allowed' : 'Disabled',                                   inline: true },
                { name: '🔒 Access Role',       value: state.accessRoleId ? `<@&${state.accessRoleId}>` : 'Admins only',                  inline: true },
                { name: '🛡️ Server Saves',     value: `**${state.saves ?? 0}**`,                                                          inline: true },
                { name: '🔢 Current Count',     value: `**${state.current}**`,                                                            inline: true },
            )
        ],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_setchannel').setLabel('Set Channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('setup_counttype').setLabel(ct === 'interactive' ? 'Switch to Simple' : 'Switch to Interactive').setStyle(ButtonStyle.Secondary),
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

// Component rows 
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
function globalTabRow(active) {
    return new ActionRowBuilder().addComponents(B('lbt_gu', 'Users', active === 'gu'), B('lbt_gs', 'Servers', active === 'gs'));
}
function countTypeRow(current) {
    return new ActionRowBuilder().addComponents(
        B('ct_interactive', 'Interactive', current === 'interactive'),
        B('ct_simple', 'Simple', current === 'simple'),
    );
}

// Math (complex number evaluator) 
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
const CONSTS = { phi: (1 + Math.sqrt(5)) / 2, pi: Math.PI, e: Math.E, tau: Math.PI * 2, sqrt2: Math.SQRT2 };

function safeMath(expr) {
    let s = expr.trim(), norm = '';
    for (let k = 0; k < s.length; k++) {
        if (SUP[s[k]] !== undefined) {
            let sup = ''; while (k < s.length && SUP[s[k]] !== undefined) sup += SUP[s[k++]]; norm += '^' + sup; k--;
        } else norm += s[k];
    }
    s = norm.replace(/[×·•]/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '').toLowerCase();
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

    const FUNCS = new Set(['sqrt', 'cbrt']);
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
    const cs = [['phi', phi], ['pi', Math.PI], ['e', Math.E], ['sqrt2', Math.SQRT2], ['tau', Math.PI * 2]];
    for (let b = 2; b <= 50; b++) for (let x = 2; x <= 8; x++) if (Math.pow(b, x) === n) cands.push(`${b}^${x}`);
    for (const [nm, v] of cs) {
        for (let x = 1; x <= 20; x++) if (Math.round(Math.pow(v, x)) === n) { cands.push(`${nm}^${x}`); break; }
        for (let x = 1; x <= 10; x++) { const b = Math.round(Math.pow(v, x)), d = n - b; if (d !== 0 && Math.abs(d) <= 20) cands.push(`${nm}^${x}${d > 0 ? '+' + d : d}`); }
    }
    if (n > 4) for (let a = 2; a <= Math.sqrt(n); a++) if (n % a === 0) { cands.push(`${a}*${n / a}`); break; }
    if (n > 8) { outer: for (let a = 2; a <= Math.cbrt(n); a++) if (n % a === 0) { const r = n / a; for (let b = a; b <= Math.sqrt(r); b++) if (r % b === 0) { cands.push(`${a}*${b}*${r / b}`); break outer; } } }
    if (n > 2) { const a = Math.max(1, Math.floor(n * 0.35)); cands.push(`${a}+${n - a}`); }
    cands.push(`${n + Math.round(n * 0.6) + 1}-${Math.round(n * 0.6) + 1}`, `${n * (n <= 10 ? 2 : 3)}/${n <= 10 ? 2 : 3}`);
    if (n > 5) for (let a = 2; a <= 10; a++) { const base = Math.floor(n / a) * a, d = n - base; if (base > 0 && d > 0 && d < a) { cands.push(`${a}*${Math.floor(n / a)}+${d}`); break; } }
    const seen = new Set(), res = [];
    for (const c of cands.sort((a, b) => (/[a-z]/.test(b) ? 1 : 0) - (/[a-z]/.test(a) ? 1 : 0) || a.length - b.length))
        if (!seen.has(c) && res.length < 3) { seen.add(c); res.push(c); }
    if (res.length < 3) res.push(`${n - 1}+1`);
    if (res.length < 3) res.push(`${n * 2}/2`);
    if (res.length < 3) res.push(`${n + 3}-3`);
    return res.slice(0, 3);
}

// Help 
function buildHelpPage(page) {
    const pages = [
        E('#5865F2', '🎮 How to Play').setDescription('Count up together in the counting channel! Anyone who breaks the chain resets it to 1.').addFields(
            { name: 'Rules', value: '• Type the next number\n• Can\'t count twice in a row (default)\n• Wrong number resets to 1!\n• Math expressions supported' },
            { name: 'Correct', value: 'React added, count goes up' },
            { name: 'Wrong / too fast', value: 'Count resets!' },
            { name: 'Milestones', value: 'Bot celebrates every 100 counts' },
            { name: 'Saves', value: 'The server earns 1 save every 50 counts. Anyone can use it within 1 minute to undo a ruin!' },
            { name: 'Simple mode', value: 'No resets — wrong messages are silently deleted.' },
        ).setFooter({ text: 'Page 1/4' }),
        E('#5865F2', 'Commands').setDescription('All commands:').addFields(
            { name: 'Counting', value: '`/counting channel` `/counting setcount` `/counting reset`' },
            { name: 'Stats',    value: '`/stats [user]` `/leaderboard server` `/leaderboard global` `/leaderboard highscores`' },
            { name: 'Utilities', value: '`/calculate [expression]` `/invite` `/help` `/setup`' },
        ).setFooter({ text: 'Page 2/4' }),
        E('#5865F2', 'Config').setDescription('Requires Administrator or configured access role.').addFields(
            { name: '/config maxstreak <n>',      value: 'Max consecutive counts per user (1–20)' },
            { name: '/config expressions <bool>', value: 'Allow/block math expressions' },
            { name: '/config access',             value: 'Set which role can use config commands' },
            { name: '/config counttype',          value: 'Switch between Interactive and Simple mode' },
            { name: '/setup',                     value: 'All-in-one setup panel for admins' },
        ).setFooter({ text: 'Page 3/4' }),
        E('#5865F2', 'Expressions').setDescription('Math expressions, rounded to nearest whole number.').addFields(
            { name: 'Operators', value: '`+` `-` `*` `/` `^`' },
            { name: 'Constants', value: '`pi` `phi` `e` `tau` `sqrt2`' },
            { name: 'Examples',  value: '`2+2`→**4** `pi^2`→**10** `phi^10`→**11** `2^8`→**256**' },
            { name: '/calculate', value: 'Type a number to get 3 expressions, or type your own expression to evaluate it!' },
        ).setFooter({ text: 'Page 4/4' }),
    ];
    const row = new ActionRowBuilder().addComponents(
        B('help_1', 'How to Play', page === 1), B('help_2', 'Commands', page === 2), B('help_3', 'Config', page === 3), B('help_4', 'Expressions', page === 4),
    );
    return { embeds: [pages[page - 1]], components: [row] };
}

// Save / reset helpers 
function doReset(guildId, state, userId) {
    state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
    delete state.pendingSave;
    saveState(guildId, state);
    updateUserStat(guildId, userId, { ruined: 1 });
}
async function triggerRuin(channel, guildId, state, userId, reason) {
    const prev = state.current;
    const expiresAt = Date.now() + 60_000;
    state.pendingSave = { placeholder: true, userId, prevCount: prev, expiresAt };
    saveState(guildId, state);

    if ((state.saves ?? 0) > 0) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`saveuse_${userId}_${prev}_${guildId}_${expiresAt}`).setLabel(`Use Save (${state.saves} left)`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`savedecline_${userId}_${prev}_${guildId}_${expiresAt}`).setLabel('Let it reset').setStyle(ButtonStyle.Danger),
        );
        const prompt = await channel.send({
            embeds: [E('#ff9900', '⚠️ Count almost ruined!').setDescription(`<@${userId}> made a mistake! (${reason})\nYou have a **Save** — use it within **1 minute** to keep the count at **${prev}**!`)
                .addFields({ name: 'Server saves', value: `**${state.saves}**`, inline: true }, { name: 'At risk', value: `**${prev}**`, inline: true })],
            components: [row],
        }).catch(e => { console.error('triggerRuin save prompt failed:', e.message); return null; });
        if (!prompt) { doReset(guildId, state, userId); return; }
        state.pendingSave = { msgId: prompt.id, userId, prevCount: prev, expiresAt };
        saveState(guildId, state);
        setTimeout(async () => {
            const fresh = await getState(guildId);
            if (!fresh.pendingSave || fresh.pendingSave.expiresAt !== expiresAt) return;
            doReset(guildId, fresh, userId);
            await prompt.edit({ embeds: [E('#ff4444', '💥 Save expired!').setDescription(`<@${userId}> didn't use their save in time. Resets from **${prev}** to **1**.`)], components: [] }).catch(() => {});
        }, 60_000);
    } else {
        doReset(guildId, state, userId);
        await channel.send({ embeds: [E('#ff4444', '💥 Count ruined!').setDescription(`<@${userId}> ruined the count! (${reason})\nCount was at **${prev}**.`).addFields({ name: 'Reset to', value: '**1**', inline: true }, { name: 'High Score', value: `**${state.highScore}**`, inline: true }).setFooter({ text: 'Start again from 1!' })] }).catch(e => console.error('ruin msg failed:', e.message));
    }
}

// Keep-alive 
function keepAlive() {
    const ping = () => { const u = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`; (u.startsWith('https') ? require('https') : http).get(u, () => {}).on('error', () => {}); };
    setTimeout(ping, 5000); setInterval(ping, 14 * 60 * 1000);
}

// Ready 
client.once('ready', async () => {
    console.log(`Online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Counting things', type: ActivityType.Watching }], status: 'online' });
    const cmds = [
        new SlashCommandBuilder().setName('counting').setDescription('Configure or view the counting game')
            .addSubcommand(s => s.setName('channel').setDescription('Set the counting channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
            .addSubcommand(s => s.setName('setcount').setDescription('Set the current count to any number (for transferring from another bot)').addIntegerOption(o => o.setName('number').setDescription('Number to set the count to').setRequired(true).setMinValue(0).setMaxValue(10000000)))
            .addSubcommand(s => s.setName('reset').setDescription('Manually reset the count')),
        new SlashCommandBuilder().setName('config').setDescription('Configure bot settings')
            .addSubcommand(s => s.setName('view').setDescription('View current count and settings'))
            .addSubcommand(s => s.setName('maxstreak').setDescription('Max consecutive counts per user').addIntegerOption(o => o.setName('amount').setDescription('1–100').setRequired(true).setMinValue(1).setMaxValue(100)))
            .addSubcommand(s => s.setName('expressions').setDescription('Allow math expressions').addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can use config'))
            .addSubcommand(s => s.setName('counttype').setDescription('Switch between Interactive and Simple counting mode')),
        new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboards')
            .addSubcommand(s => s.setName('server').setDescription('Top counters in this server'))
            .addSubcommand(s => s.setName('global').setDescription('Global leaderboard'))
            .addSubcommand(s => s.setName('highscores').setDescription('Servers by all-time high score')),
        new SlashCommandBuilder().setName('stats').setDescription('View counting stats').addUserOption(o => o.setName('user').setDescription('User to check')),
        new SlashCommandBuilder().setName('calculate').setDescription('Calculate an expression, or get 3 expressions for a number')
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

// Message counting 
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    const gid = message.guild.id;
    const state = await getState(gid).catch(() => null);
    if (!state?.channelId || message.channel.id !== state.channelId) return;
    if (state.pendingSave) {
        if (Date.now() < state.pendingSave.expiresAt) return;
        delete state.pendingSave;
        saveState(gid, state);
    }

    const raw = message.content.trim();
    const hasConst = Object.keys(CONSTS).some(c => raw.toLowerCase().includes(c));
    const isExpr = (/[+\-*/^()]/.test(raw) && !/^\-?\d+$/.test(raw)) || hasConst;
    const value = safeMath(raw);
    const expected = state.current + 1;

    if (state.countType === 'simple') {
        const streakViolation = state.maxStreak > 0 && message.author.id === state.lastUserId && state.consecutiveCount >= state.maxStreak;
        if (value === null || value !== expected || streakViolation) {
            const me = message.guild.members.me;
            if (!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)) {
                console.error('Simple mode: missing ManageMessages permission in channel', message.channel.id);
                return;
            }
            await message.delete().catch(e => console.error('Simple mode delete failed:', e.message));
            return;
        }
        state.current = value; state.lastUserId = message.author.id;
        if (value > state.highScore) state.highScore = value;
        saveState(gid, state);
        await updateUserStat(gid, message.author.id, { correct: 1 });
        const ne = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
        await message.react(value <= 9 ? ne[value] : '✅').catch(() => {});
        if (value % 100 === 0) await message.channel.send({ embeds: [E('#00cc88', `🎉 ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`)] }).catch(() => {});
        return;
    }

    if (isExpr && !state.allowExpressions) {
        await message.react('❌').catch(() => {});
        const s = await message.channel.send({ embeds: [E('#ff4444', 'Expressions disabled').setDescription(`\`${raw}\` — expressions not allowed here!`)] }).catch(() => null);
        if (s) setTimeout(() => s.delete().catch(() => {}), 5000);
        return;
    }
    if (value === null) return; // not a number at all — ignore silently
    if (value !== expected) {
        if (!await claimMessage(message.id)) return;
        message.react('❌').catch(() => {});
        await triggerRuin(message.channel, gid, state, message.author.id, `sent \`${value}\` but expected \`${expected}\``);
        return;
    }
    if (state.maxStreak > 0 && message.author.id === state.lastUserId && state.consecutiveCount >= state.maxStreak) {
        if (!await claimMessage(message.id)) return;
        message.react('❌').catch(() => {});
        await triggerRuin(message.channel, gid, state, message.author.id, `counted more than **${state.maxStreak}** time(s) in a row`);
        return;
    }

    const same = message.author.id === state.lastUserId;
    state.current = value; state.lastUserId = message.author.id; state.consecutiveCount = same ? state.consecutiveCount + 1 : 1;
    if (value > state.highScore) state.highScore = value;
    saveState(gid, state);

    const earnedSave = value % 50 === 0;
    await updateUserStat(gid, message.author.id, { correct: 1 });
    if (earnedSave) {
        state.saves = (state.saves ?? 0) + 1;
        saveState(gid, state);
        await message.channel.send({ embeds: [E('#ffd700', '🛡️ Save earned!').setDescription(`The server earned a **Save** for reaching **${value}**!\nThe server now has **${state.saves}** save(s).`)] }).catch(() => {});
    }
    const ne = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
    await message.react(value <= 9 ? ne[value] : '✅').catch(() => {});
    if (value % 100 === 0) await message.channel.send({ embeds: [E('#00cc88', `🎉 ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`).setFooter({ text: `High score: ${state.highScore}` })] }).catch(() => {});
});

// Interactions 
client.on('interactionCreate', async interaction => {
    const gid = interaction.guild?.id;

    if (interaction.isButton()) {
        const id = interaction.customId;

        if (id.startsWith('help_')) {
            const p = parseInt(id.split('_')[1]);
            if (!isNaN(p) && p >= 1 && p <= 4) return interaction.update(buildHelpPage(p));
        }

        if (id.startsWith('setup_')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ content: 'Admins only.', ...ep() });
            const state = await getState(gid);

            if (id === 'setup_refresh') return interaction.update(buildSetupEmbed(state));
            if (id === 'setup_counttype') {
                state.countType = state.countType === 'interactive' ? 'simple' : 'interactive';
                saveState(gid, state); return interaction.update(buildSetupEmbed(state));
            }
            if (id === 'setup_expressions') {
                state.allowExpressions = !state.allowExpressions;
                saveState(gid, state); return interaction.update(buildSetupEmbed(state));
            }
            if (id === 'setup_reset') {
                const prev = state.current; state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
                saveState(gid, state);
                if (state.channelId) { const ch = interaction.guild.channels.cache.get(state.channelId); if (ch) ch.send({ embeds: [E('#ff9900', '🔄 Count reset').setDescription(`Admin reset from **${prev}** to 0. Start again from **1**!`)] }).catch(() => {}); }
                return interaction.update(buildSetupEmbed(state));
            }
            if (id === 'setup_setchannel') {
                return interaction.reply({
                    embeds: [E('#5865F2', 'Set Counting Channel').setDescription('Select the channel to use for counting:')],
                    components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').setPlaceholder('Select a text channel').addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1))],
                    ...ep(),
                });
            }
            if (id === 'setup_access') {
                return interaction.reply({
                    embeds: [E('#5865F2', 'Set Access Role').setDescription('Select which role can use `/config` commands:')],
                    components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_role_select').setPlaceholder('Select a role').setMinValues(1).setMaxValues(1))],
                    ...ep(),
                });
            }
        }

        if (id === 'ct_interactive' || id === 'ct_simple') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !await hasPerm(interaction, gid))
                return interaction.reply({ content: 'No permission.', ...ep() });
            const state = await getState(gid);
            state.countType = id === 'ct_interactive' ? 'interactive' : 'simple';
            saveState(gid, state);
            return interaction.update({
                embeds: [E('#5865F2', `Count type set to ${state.countType === 'interactive' ? 'Interactive' : 'Simple'}`)
                    .setDescription(state.countType === 'interactive'
                        ? 'Back to **Interactive** mode. Wrong numbers and streaks will reset the count!'
                        : '**Simple** mode enabled. Wrong messages are silently deleted. The count never resets!')],
                components: [countTypeRow(state.countType)],
            });
        }

        if (id.startsWith('saveuse_') || id.startsWith('savedecline_')) {
            const parts = id.split('_');
            const action = parts[0], ownerId = parts[1], prevCount = parseInt(parts[2]), btnGid = parts[3], expiresAt = parseInt(parts[4]);

            if (interaction.user.id !== ownerId) return interaction.reply({ content: 'Only the person who ruined the count can do this!', ...ep() });
            if (Date.now() > expiresAt) return interaction.reply({ content: 'Save prompt has expired.', ...ep() });

            const state = await getState(btnGid);
            delete state.pendingSave;

            if (action === 'saveuse') {
                if ((state.saves ?? 0) < 1) return interaction.reply({ content: 'The server has no saves left.', ...ep() });
                state.current = prevCount; state.lastUserId = ownerId; state.consecutiveCount = 1;
                state.saves = (state.saves ?? 1) - 1;
                state.savesUsed = (state.savesUsed ?? 0) + 1;
                saveState(btnGid, state);
                await updateUserStat(btnGid, ownerId, { savesUsed: 1 });
                return interaction.update({
                    embeds: [E('#00cc88', '🛡️ Save used!').setDescription(`<@${ownerId}> used a **Save** — count stays at **${prevCount}**!`).addFields({ name: 'Remaining', value: `**${state.saves}**`, inline: true }, { name: 'Continues at', value: `**${prevCount}**`, inline: true })],
                    components: [],
                });
            } else {
                state.current = 0; state.lastUserId = null; state.consecutiveCount = 0;
                saveState(btnGid, state);
                updateUserStat(btnGid, ownerId, { ruined: 1 });
                return interaction.update({
                    embeds: [E('#ff4444', '💥 Count ruined!').setDescription(`<@${ownerId}> declined the save. Resets from **${prevCount}** to **1**.`).addFields({ name: 'High Score', value: `**${state.highScore}**`, inline: true })],
                    components: [],
                });
            }
        }

        if (id.startsWith('stats_')) {
            await interaction.deferUpdate();
            const [, view, tuid, bgid] = id.split('_');
            try {
                if (view === 'user') { const u = await client.users.fetch(tuid).catch(() => interaction.user); return interaction.editReply({ embeds: [await buildUserStatsEmbed(bgid, u)], components: [statsRow(tuid, bgid, 'user')] }); }
                if (view === 'server') { const g = client.guilds.cache.get(bgid) ?? await client.guilds.fetch(bgid).catch(() => interaction.guild); return interaction.editReply({ embeds: [await buildServerStatsEmbed(g)], components: [statsRow(tuid, bgid, 'server')] }); }
            } catch (e) { console.error('stats btn:', e); return interaction.editReply({ content: 'Failed to load stats.' }); }
        }

        if (id === 'lbt_gu' || id === 'lbt_gs') {
            await interaction.deferUpdate();
            try {
                if (id === 'lbt_gu') { const { embed, totalPages } = await buildGlobalUsersEmbed(1);   return interaction.editReply({ embeds: [embed], components: [globalTabRow('gu'), paginationRow('gu', '', 1, totalPages)] }); }
                if (id === 'lbt_gs') { const { embed, totalPages } = await buildGlobalServersEmbed(1); return interaction.editReply({ embeds: [embed], components: [globalTabRow('gs'), paginationRow('gs', '', 1, totalPages)] }); }
            } catch (e) { console.error('tab btn:', e); await interaction.editReply({ content: 'Failed to load.' }).catch(() => {}); }
        }

        if (id.startsWith('lb_')) {
            const last = id.split('_').pop();
            if (last === 'info') return interaction.deferUpdate();
            const page = parseInt(last.replace('p', ''));
            if (isNaN(page) || page < 1) return interaction.deferUpdate();
            const type = id.split('_')[1];
            await interaction.deferUpdate();
            try {
                if (type === 'gu') { const { embed, totalPages } = await buildGlobalUsersEmbed(page);   return interaction.editReply({ embeds: [embed], components: [globalTabRow('gu'), paginationRow('gu', '', page, totalPages)] }); }
                if (type === 'gs') { const { embed, totalPages } = await buildGlobalServersEmbed(page); return interaction.editReply({ embeds: [embed], components: [globalTabRow('gs'), paginationRow('gs', '', page, totalPages)] }); }
                if (type === 'hs') { const { embed, totalPages } = await buildHighscoresEmbed(page);    return interaction.editReply({ embeds: [embed], components: [paginationRow('hs', '', page, totalPages)] }); }
                if (type === 'sv') { const svgid = id.split('_')[2]; const { embed, totalPages } = await buildServerLbEmbed(svgid, page); return interaction.editReply({ embeds: [embed], components: [paginationRow('sv', svgid, page, totalPages)] }); }
            } catch (e) { console.error('lb btn:', e); await interaction.editReply({ content: 'Failed to load. Try again.' }).catch(() => {}); }
        }

        return;
    }

    if (interaction.isRoleSelectMenu()) {
        if (interaction.customId === 'setup_role_select') {
            const state = await getState(gid); state.accessRoleId = interaction.values[0]; saveState(gid, state);
            return interaction.update({ embeds: [E('#5865F2', 'Access role set').setDescription(`<@&${state.accessRoleId}> can now use config commands.`)], components: [] });
        }
        if (interaction.customId.startsWith('access_role_')) {
            const state = await getState(gid); state.accessRoleId = interaction.values[0]; saveState(gid, state);
            return interaction.update({ embeds: [E('#5865F2', 'Access role updated').setDescription(`<@&${state.accessRoleId}> can now use config commands.`)], components: [] });
        }
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'setup_channel_select') {
        const state = await getState(gid); state.channelId = interaction.values[0]; saveState(gid, state);
        return interaction.update({ embeds: [E('#5865F2', 'Counting channel set').setDescription(`<#${state.channelId}> is now the counting channel. Start from **1**!`)], components: [] });
    }

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return interaction.reply({ content: 'Server only.', ...ep() });

    const { commandName: cmd, options } = interaction;

    try {
        if (cmd === 'help')   return interaction.reply({ ...buildHelpPage(1), ...ep() });
        if (cmd === 'invite') return interaction.reply({ embeds: [E('#5865F2', 'Invite Counting Bot').setDescription(`[**Invite me!**](https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=93248&scope=bot%20applications.commands)`).addFields({ name: 'Permissions', value: 'View Channels · Send Messages · Add Reactions · Read History · Manage Messages' })], ...ep() });

        if (cmd === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Admins only.', ...ep() });
            return interaction.reply({ ...buildSetupEmbed(await getState(gid)), ...ep() });
        }

        if (cmd === 'calculate') {
            await interaction.deferReply(ep());
            const input = options.getString('input').trim();
            const evaluated = safeMath(input);
            const looksLikeNumber = /^[\d]+$/.test(input.replace(/\s/g, ''));

            if (looksLikeNumber && evaluated !== null) {
                const exprs = generateExpressions(evaluated);
                return interaction.editReply({ embeds: [E('#5865F2', `Ways to write ${evaluated}`).setDescription(`3 expressions for **${evaluated}**:`).addFields(...exprs.map((x, i) => ({ name: `${['1️⃣', '2️⃣', '3️⃣'][i]} \`${x}\``, value: `= **${safeMath(x) ?? evaluated}**`, inline: true }))).setFooter({ text: 'Supports: + - * / ^ pi phi e tau sqrt2' })] });
            } else if (evaluated !== null) {
                return interaction.editReply({ embeds: [E('#5865F2', 'Result').addFields({ name: 'Expression', value: `\`${input}\``, inline: true }, { name: 'Result', value: `**${evaluated}**`, inline: true }, { name: 'Rounded', value: `\`${evaluated}\``, inline: true }).setFooter({ text: 'Result is rounded to the nearest whole number' })] });
            } else {
                return interaction.editReply({ embeds: [E('#ff4444', 'Invalid expression').setDescription(`\`${input}\` couldn't be evaluated. Make sure you're using valid operators and constants.\n\nConstants: \`pi\` \`phi\` \`e\` \`tau\` \`sqrt2\``)] });
            }
        }

        if (cmd === 'stats') {
            await interaction.deferReply(ep());
            const u = options.getUser('user') ?? interaction.user;
            return interaction.editReply({ embeds: [await buildUserStatsEmbed(gid, u)], components: [statsRow(u.id, gid, 'user')] });
        }

        if (cmd === 'leaderboard') {
            await interaction.deferReply(ep());
            const sub = options.getSubcommand();
            if (sub === 'server')     { const { embed, totalPages } = await buildServerLbEmbed(gid, 1);  return interaction.editReply({ embeds: [embed], components: [paginationRow('sv', gid, 1, totalPages)] }); }
            if (sub === 'global')     { const { embed, totalPages } = await buildGlobalUsersEmbed(1);    return interaction.editReply({ embeds: [embed], components: [globalTabRow('gu'), paginationRow('gu', '', 1, totalPages)] }); }
            if (sub === 'highscores') { const { embed, totalPages } = await buildHighscoresEmbed(1);     return interaction.editReply({ embeds: [embed], components: [paginationRow('hs', '', 1, totalPages)] }); }
        }

        if (cmd === 'config') {
            const sub = options.getSubcommand();
            if (sub === 'view') {
                await interaction.deferReply(ep());
                const st = await getState(gid);
                return interaction.editReply({ embeds: [E('#5865F2', 'Counting Status').addFields(
                    { name: 'Channel',    value: st.channelId ? `<#${st.channelId}>` : 'Not set',                                    inline: true },
                    { name: 'Current',    value: `**${st.current}**`,                                                                 inline: true },
                    { name: 'High',       value: `**${st.highScore}**`,                                                               inline: true },
                    { name: 'Streak',     value: `**${st.maxStreak}** in a row`,                                                      inline: true },
                    { name: 'Expr',       value: st.allowExpressions ? 'Allowed' : 'Disabled',                                        inline: true },
                    { name: 'Mode',       value: (st.countType ?? 'interactive') === 'interactive' ? 'Interactive' : 'Simple',        inline: true },
                    { name: 'Access',     value: st.accessRoleId ? `<@&${st.accessRoleId}>` : 'Admins only',                         inline: true },
                    { name: 'Saves',      value: `**${st.saves ?? 0}**`,                                                              inline: true },
                    { name: 'Last',       value: st.lastUserId ? `<@${st.lastUserId}>` : 'Nobody yet',                               inline: true },
                )] });
            }
            if (sub === 'access') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Admins only.', ...ep() });
                const state = await getState(gid);
                return interaction.reply({ embeds: [E('#5865F2', 'Access Config').setDescription('Select a role that can use `/config` commands. Admins always have access.').addFields({ name: 'Current role', value: state.accessRoleId ? `<@&${state.accessRoleId}>` : 'None (admins only)' })], components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`access_role_${gid}`).setPlaceholder('Select role').setMinValues(1).setMaxValues(1))], ...ep() });
            }
            if (!await hasPerm(interaction, gid)) return interaction.reply({ content: 'No permission.', ...ep() });
            if (sub === 'counttype') {
                const state = await getState(gid);
                return interaction.reply({
                    embeds: [E('#5865F2', 'Count Type').setDescription('Choose a counting mode:').addFields(
                        { name: 'Interactive', value: 'Wrong numbers reset the count. Streaks, saves, and reactions all apply.', inline: true },
                        { name: 'Simple',      value: 'Wrong messages are silently deleted. The count never resets.',            inline: true },
                    ).addFields({ name: 'Current mode', value: (state.countType ?? 'interactive') === 'interactive' ? '**Interactive**' : '**Simple**' })],
                    components: [countTypeRow(state.countType ?? 'interactive')],
                    ...ep(),
                });
            }
            await interaction.deferReply(ep());
            const state = await getState(gid);
            if (sub === 'maxstreak')   { state.maxStreak = options.getInteger('amount'); saveState(gid, state); return interaction.editReply({ embeds: [E('#5865F2', 'Max streak updated').setDescription(state.maxStreak === 1 ? 'Users can\'t count twice in a row.' : `Users can count **${state.maxStreak}** times in a row.`)] }); }
            if (sub === 'expressions') { state.allowExpressions = options.getBoolean('enabled'); saveState(gid, state); return interaction.editReply({ embeds: [E('#5865F2', `Expressions ${state.allowExpressions ? 'enabled' : 'disabled'}`).setDescription(state.allowExpressions ? 'Expressions like `1+1`, `pi^2` are now allowed.' : 'Only plain numbers accepted.')] }); }
        }

        if (cmd === 'counting') {
            const sub = options.getSubcommand();
            if (!await hasPerm(interaction, gid)) return interaction.reply({ content: 'No permission.', ...ep() });
            await interaction.deferReply(ep());
            const state = await getState(gid);
            if (sub === 'channel') {
                const ch = options.getChannel('channel');
                if (!ch.isTextBased()) return interaction.editReply({ content: 'Text channel required.' });
                state.channelId = ch.id; saveState(gid, state);
                return interaction.editReply({ embeds: [E('#5865F2', 'Channel set').setDescription(`Counting channel set to ${ch}. Start from **1**!`)] });
            }
            if (sub === 'setcount') {
                const num = options.getInteger('number'), prev = state.current;
                state.current = num; state.lastUserId = null; state.consecutiveCount = 0;
                if (num > state.highScore) state.highScore = num;
                saveState(gid, state);
                if (state.channelId) { const ch = interaction.guild.channels.cache.get(state.channelId); if (ch) ch.send({ embeds: [E('#5865F2', 'Count set').setDescription(`Count manually set from **${prev}** to **${num}**. Next number is **${num + 1}**.`)] }).catch(() => {}); }
                return interaction.editReply({ content: `Count set to **${num}**. Next number is **${num + 1}**.` });
            }
            if (sub === 'reset') {
                const prev = state.current; state.current = 0; state.lastUserId = null; state.consecutiveCount = 0; saveState(gid, state);
                if (state.channelId) { const ch = interaction.guild.channels.cache.get(state.channelId); if (ch) ch.send({ embeds: [E('#ff9900', '🔄 Count reset').setDescription(`Admin reset from **${prev}** to 0. Start again from **1**!`)] }).catch(() => {}); }
                return interaction.editReply({ content: `Count reset from **${prev}** to 0.` });
            }
        }
    } catch (error) {
        if (error?.code === 40060) return;
        console.error('Interaction error:', error);
        try { const m = { content: 'Something went wrong.', ...ep() }; if (interaction.deferred) await interaction.editReply(m).catch(() => {}); else if (!interaction.replied) await interaction.reply(m).catch(() => {}); } catch {}
    }
});

process.on('unhandledRejection', e => console.error(e));
client.on('error', e => console.error('Discord error:', e));
client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { const ok = req.url === '/' || req.url === '/health'; res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' }); res.end(ok ? 'Counting bot running!' : 'Not found'); }).listen(PORT, () => console.log(`HTTP on port ${PORT}`));
