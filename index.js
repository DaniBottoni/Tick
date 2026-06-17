const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActivityType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType } = require('discord.js');
const { Pool } = require('pg');
require('dns').setDefaultResultOrder('ipv4first');
const http = require('http');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 8000, connectionTimeoutMillis: 5000, idleTimeoutMillis: 600000, max: 3 });
const stateCache = new Map();
const PS = 25, SLB_MAX = 100;

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS counting   (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS user_stats (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (guild_id, user_id));
        CREATE INDEX IF NOT EXISTS user_stats_user ON user_stats(user_id);
        CREATE TABLE IF NOT EXISTS dedup (message_id TEXT PRIMARY KEY, claimed_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS support_announced (guild_id TEXT PRIMARY KEY, announced_at TIMESTAMPTZ DEFAULT NOW());
    `);
    pool.query(`DELETE FROM dedup WHERE claimed_at < NOW() - INTERVAL '5 minutes'`).catch(() => {});
}
async function claimMessage(mid) {
    try { const r = await pool.query('INSERT INTO dedup (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id', [mid]); return r.rowCount > 0; }
    catch { return true; }
}
function defaultState() {
    return { channelId: null, current: 0, lastUserId: null, consecutiveCount: 0, maxStreak: 1, allowExpressions: true, highScore: 0, accessRoleId: null, countType: 'interactive', saves: 0, savesUsed: 0, countdownCycles: 0, countdownStart: 100, randomModifier: null, randomModifierLabel: null };
}
async function getState(gid) {
    if (stateCache.has(gid)) return stateCache.get(gid);
    const r = await pool.query('SELECT data FROM counting WHERE guild_id=$1', [gid]);
    const d = r.rows[0]?.data ?? defaultState();
    if (!d.countType) d.countType = 'interactive';
    stateCache.set(gid, d); return d;
}
function saveState(gid, data) {
    stateCache.set(gid, data);
    pool.query('INSERT INTO counting (guild_id,data) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET data=$2', [gid, data]).catch(e => console.error('saveState:', e.message));
}

async function updateUserStat(gid, uid, delta) {
    try {
        const r = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
        const cur = r.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
        for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + v;
        await pool.query('INSERT INTO user_stats (guild_id,user_id,data) VALUES ($1,$2,$3) ON CONFLICT (guild_id,user_id) DO UPDATE SET data=$3', [gid, uid, cur]);
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
async function getServerLbPage(gid, page) {
    const off = Math.min((page-1)*PS, SLB_MAX-PS);
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id,data FROM user_stats WHERE guild_id=$1 ORDER BY COALESCE((data->>'correct')::int,0) DESC LIMIT $2 OFFSET $3`, [gid, PS, off]),
        pool.query(`SELECT LEAST(COUNT(*), $2) AS cnt FROM user_stats WHERE guild_id=$1`, [gid, SLB_MAX]),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getGlobalUsersPage(page) {
    const off = (page-1)*PS;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id, SUM(COALESCE((data->>'correct')::int,0)) AS correct, SUM(COALESCE((data->>'ruined')::int,0)) AS ruined FROM user_stats GROUP BY user_id ORDER BY correct DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(DISTINCT user_id) AS cnt FROM user_stats`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getGlobalServersPage(page, filter) {
    const off = (page-1)*PS;
    const where = filter ? `WHERE COALESCE(data->>'countType','interactive')='${filter}'` : '';
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, COALESCE((data->>'current')::int,0) AS cur, COALESCE((data->>'highScore')::int,0) AS hs, COALESCE(data->>'countType','interactive') AS mode FROM counting ${where} ORDER BY cur DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting ${where}`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getHighscoresPage(page, filter) {
    const off = (page-1)*PS;
    const where = filter === 'countdown' ? `WHERE COALESCE(data->>'countType','interactive')='countdown'`
                : filter               ? `WHERE COALESCE(data->>'countType','interactive')='${filter}'`
                :                        `WHERE COALESCE(data->>'countType','interactive') != 'countdown'`;
    const scoreExpr = filter === 'countdown' ? `COALESCE((data->>'countdownCycles')::int,0)` : `COALESCE((data->>'highScore')::int,0)`;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, ${scoreExpr} AS score, COALESCE((data->>'current')::int,0) AS cur, COALESCE(data->>'countType','interactive') AS mode FROM counting ${where} ORDER BY score DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting ${where}`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}

const M = ['🥇','🥈','🥉'];
const E = (color, title) => new EmbedBuilder().setColor(color).setTitle(title);
const ep = () => ({ flags: [MessageFlags.Ephemeral] });
const MODE_EMOJI = { interactive:'🎮', simple:'🟢', countdown:'⏳', random:'🎲' };
const MODE_LABEL = { interactive:'Interactive', simple:'Simple', countdown:'Countdown', random:'Random' };

const guildNameCache = new Map();
async function guildName(id) {
    if (guildNameCache.has(id)) return guildNameCache.get(id);
    try { const g = client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null); const name = g?.name ?? null; if (name) { guildNameCache.set(id, name); return name; } } catch {}
    return null;
}
async function hasPerm(interaction, gid) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const s = await getState(gid);
    return s.accessRoleId ? interaction.member.roles.cache.has(s.accessRoleId) : false;
}

const RANDOM_MODIFIERS = [
    { id:'every2',     label:'\u23e9 Count every 2nd number',    desc:'Skip every other number! Only even numbers count.',           check:n=>n%2===0,    next:n=>n+2,           hint:n=>`Next: **${n+2}**` },
    { id:'every3',     label:'\u23e9 Count every 3rd number',    desc:'Only multiples of 3!',                                        check:n=>n%3===0,    next:n=>n+3,           hint:n=>`Next: **${n+3}**` },
    { id:'primes',     label:'\u{1F522} Primes only',            desc:'Only prime numbers are valid!',                               check:isPrime,       next:nextPrime,        hint:n=>`Next prime: **${nextPrime(n)}**` },
    { id:'fibonacci',  label:'\u{1F300} Fibonacci sequence',     desc:'Follow the Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13\u2026', check:isFibonacci,   next:nextFibonacci,    hint:n=>`Next Fibonacci: **${nextFibonacci(n)}**` },
    { id:'squares',    label:'\u{1F7E5} Perfect squares',        desc:'Only perfect squares! 1, 4, 9, 16, 25\u2026',                check:n=>{const s=Math.round(Math.sqrt(n));return s*s===n;}, next:n=>{const s=Math.round(Math.sqrt(n));return(s+1)*(s+1);}, hint:n=>{const s=Math.round(Math.sqrt(n));return`Next square: **${(s+1)*(s+1)}**`;} },
    { id:'palindromes',label:'\u{1F504} Palindrome numbers',     desc:'Only numbers that read the same forwards and backwards!',    check:n=>{const s=String(n);return s===s.split('').reverse().join('');}, next:n=>{let m=n+1;while(true){const s=String(m);if(s===s.split('').reverse().join(''))return m;m++;}}, hint:n=>{let m=n+1;while(true){const s=String(m);if(s===s.split('').reverse().join(''))return`Next palindrome: **${m}**`;m++;}} },
    { id:'lucky7',     label:'\u{1F340} Multiples of 7',         desc:'Lucky sevens! Only multiples of 7.',                         check:n=>n%7===0,    next:n=>n+7,           hint:n=>`Next: **${n+7}**` },
    { id:'triangular', label:'\u{1F53A} Triangular numbers',     desc:'Only triangular numbers! 1, 3, 6, 10, 15, 21\u2026',        check:isTriangular,  next:nextTriangular,   hint:n=>`Next triangular: **${nextTriangular(n)}**` },
];
function isPrime(n) { if(n<2)return false;if(n===2)return true;if(n%2===0)return false;for(let i=3;i<=Math.sqrt(n);i+=2)if(n%i===0)return false;return true; }
function nextPrime(n) { let m=n+1;while(!isPrime(m))m++;return m; }
function isFibonacci(n) { const sq=x=>{const s=Math.round(Math.sqrt(x));return s*s===x;};return sq(5*n*n+4)||sq(5*n*n-4); }
function nextFibonacci(n) { let a=1,b=1;while(b<=n){const c=a+b;a=b;b=c;}return b; }
function isTriangular(n) { const x=(Math.sqrt(8*n+1)-1)/2;return Math.abs(x-Math.round(x))<1e-9; }
function nextTriangular(n) { let t=1,k=1;while(t<=n){k++;t=k*(k+1)/2;}return t; }
function pickRandomModifier() { return RANDOM_MODIFIERS[Math.floor(Math.random()*RANDOM_MODIFIERS.length)]; }
function getModifier(id) { return RANDOM_MODIFIERS.find(m=>m.id===id)??RANDOM_MODIFIERS[0]; }
function firstValidForModifier(modId) { const mod=getModifier(modId);let n=1;while(!mod.check(n))n++;return n; }

async function buildUserStatsEmbed(gid, user) {
    const [st, rank, gs] = await Promise.all([getUserStats(gid,user.id), getUserRank(gid,user.id), getState(gid)]);
    const tot=(st.correct||0)+(st.ruined||0), acc=tot>0?Math.round((st.correct/tot)*100):100;
    return E('#5865F2',`\u{1F4CA} Stats \u2014 ${user.username}`).setThumbnail(user.displayAvatarURL()).addFields(
        {name:'\u2705 Correct',value:`**${st.correct??0}**`,inline:true},
        {name:'\u{1F4A5} Ruined',value:`**${st.ruined??0}**`,inline:true},
        {name:'\u{1F3AF} Accuracy',value:`**${acc}%**`,inline:true},
        {name:'\u{1F3C5} Rank',value:`**#${rank}**`,inline:true},
        {name:'\u{1F516} Saves used',value:`**${st.savesUsed??0}**`,inline:true},
        {name:`${MODE_EMOJI[gs.countType??'interactive']} Mode`,value:`**${MODE_LABEL[gs.countType??'interactive']}**`,inline:true},
    );
}
async function buildServerStatsEmbed(guild) {
    const [ss, gs] = await Promise.all([getServerStats(guild.id), getState(guild.id)]);
    const tc=parseInt(ss.tc)||0,tr=parseInt(ss.tr)||0,tu=parseInt(ss.tu)||0,gt=tc+tr,ac=gt>0?Math.round((tc/gt)*100):100;
    const extra=[];
    if(gs.countType==='countdown')extra.push({name:'\u23f3 Cycles completed',value:`**${gs.countdownCycles??0}**`,inline:true});
    if(gs.countType==='random'&&gs.randomModifierLabel)extra.push({name:'\u{1F3B2} Current modifier',value:gs.randomModifierLabel,inline:true});
    return E('#5865F2',`\u{1F4CA} Server Stats \u2014 ${guild.name}`).setThumbnail(guild.iconURL()).addFields(
        {name:'\u{1F465} Counters',value:`**${tu}**`,inline:true},{name:'\u2705 Correct',value:`**${tc}**`,inline:true},{name:'\u{1F4A5} Ruined',value:`**${tr}**`,inline:true},
        {name:'\u{1F3AF} Accuracy',value:`**${ac}%**`,inline:true},{name:'\u{1F522} Current',value:`**${gs.current}**`,inline:true},{name:'\u{1F3C6} High score',value:`**${gs.highScore}**`,inline:true},
        {name:`${MODE_EMOJI[gs.countType??'interactive']} Mode`,value:`**${MODE_LABEL[gs.countType??'interactive']}**`,inline:true},...extra,
    );
}
async function buildServerLbEmbed(gid, page) {
    const {rows,total}=await getServerLbPage(gid,page);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    if(!rows.length)return{embed:E('#5865F2','\u{1F3C6} Server Leaderboard').setDescription('No stats yet!'),totalPages:1};
    return{totalPages:tp,embed:E('#5865F2','\u{1F3C6} Server Leaderboard')
        .setDescription(rows.map((r,i)=>`${M[off+i]??`**${off+i+1}.**`} <@${r.user_id}> \u2014 **${r.data.correct??0}** counts${r.data.ruined?` *(${r.data.ruined} ruined)*`:''}`).join('\n'))
        .setFooter({text:`Page ${page}/${tp} \u00b7 ${off+1}\u2013${off+rows.length} of ${total}`})};
}
async function buildGlobalUsersEmbed(page) {
    const {rows,total}=await getGlobalUsersPage(page);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    if(!rows.length)return{embed:E('#5865F2','\u{1F30D} Global \u2014 Users').setDescription('No stats yet!'),totalPages:1};
    const lines=await Promise.all(rows.map(async(r,i)=>{
        let display;try{const u=await client.users.fetch(r.user_id);display=`<@${u.id}> (@${u.username})`;}catch{display=`<@${r.user_id}>`;}
        return`${M[off+i]??`**${off+i+1}.**`} ${display} \u2014 **${parseInt(r.correct)}** counts`;
    }));
    return{totalPages:tp,embed:E('#5865F2','\u{1F30D} Global Leaderboard \u2014 Users').setDescription(lines.join('\n')).setFooter({text:`Page ${page}/${tp} \u00b7 ${off+1}\u2013${off+rows.length} of ${total} users`})};
}
async function buildGlobalServersEmbed(page, filter) {
    const {rows,total}=await getGlobalServersPage(page,filter);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    const titles={interactive:'\u{1F3AE} Global \u2014 Interactive Servers',simple:'\u{1F7E2} Global \u2014 Simple Servers',countdown:'\u23f3 Global \u2014 Countdown Servers',random:'\u{1F3B2} Global \u2014 Random Servers'};
    if(!rows.length)return{embed:E('#5865F2',titles[filter]??'\u{1F30D} Global \u2014 Servers').setDescription('No servers found!'),totalPages:1,filter};
    const resolved=(await Promise.all(rows.map(async r=>{const name=await guildName(r.guild_id);return name?{name,emoji:MODE_EMOJI[r.mode]??'\u{1F3AE}',cur:r.cur}:null;}))).filter(Boolean)
        .map((r,i)=>`${M[off+i]??`**${off+i+1}.**`} **${r.name}** ${r.emoji} \u2014 \u{1F522} **${r.cur}**`);
    if(!resolved.length)return{embed:E('#5865F2',titles[filter]).setDescription('No active servers found!'),totalPages:1,filter};
    return{totalPages:tp,filter,embed:E('#5865F2',titles[filter]).setDescription(resolved.join('\n')).setFooter({text:`Page ${page}/${tp}`})};
}
async function buildHighscoresEmbed(page, filter='interactive') {
    const {rows,total}=await getHighscoresPage(page,filter);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    const titles={interactive:'\u{1F3C5} High Scores \u2014 Interactive',simple:'\u{1F3C5} High Scores \u2014 Simple',random:'\u{1F3C5} High Scores \u2014 Random',countdown:'\u{1F3C5} High Scores \u2014 Countdown Cycles'};
    const scoreLabel=filter==='countdown'?'cycles':'high score';
    if(!rows.length)return{embed:E('#5865F2',titles[filter]).setDescription('No data yet!'),totalPages:1};
    const resolved=(await Promise.all(rows.map(async r=>{const name=await guildName(r.guild_id);return name?{name,score:r.score}:null;}))).filter(Boolean)
        .map((r,i)=>`${M[off+i]??`**${off+i+1}.**`} **${r.name}** \u2014 ${filter==='countdown'?'\u{1F504}':'\u{1F3C6}'} **${r.score}** ${scoreLabel}`);
    if(!resolved.length)return{embed:E('#5865F2',titles[filter]).setDescription('No active servers found!'),totalPages:1};
    return{totalPages:tp,embed:E('#5865F2',titles[filter]).setDescription(resolved.join('\n')).setFooter({text:`Page ${page}/${tp}`})};
}

function buildSetupEmbed(state) {
    const ct=state.countType??'interactive';
    const modeDisplay={interactive:'\u{1F3AE} Interactive',simple:'\u{1F7E2} Simple',countdown:'\u23f3 Countdown',random:'\u{1F3B2} Random'}[ct]??'\u{1F3AE} Interactive';
    const extraField=ct==='countdown'?[{name:'\u23f3 Countdown Cycles',value:`**${state.countdownCycles??0}**`,inline:true}]:ct==='random'&&state.randomModifierLabel?[{name:'\u{1F3B2} Current Modifier',value:state.randomModifierLabel,inline:true}]:[];
    return {
        embeds:[E('#5865F2','\u2699\ufe0f Counting Bot \u2014 Setup').setDescription('Use the buttons below to configure the bot. All settings are saved instantly.').addFields(
            {name:'\u{1F4CD} Counting Channel',value:state.channelId?`<#${state.channelId}>`:'Not set',inline:true},
            {name:'\u{1F3AE} Count Type',value:modeDisplay,inline:true},
            {name:'\u{1F501} Max Streak',value:`**${state.maxStreak}** in a row`,inline:true},
            {name:'\u{1F9EE} Expressions',value:state.allowExpressions?'Allowed':'Disabled',inline:true},
            {name:'\u{1F512} Access Role',value:state.accessRoleId?`<@&${state.accessRoleId}>`:'Admins only',inline:true},
            {name:'\u{1F6E1}\ufe0f Server Saves',value:`**${state.saves??0}**`,inline:true},
            {name:'\u{1F522} Current Count',value:`**${state.current}**`,inline:true},
            ...extraField,
        )],
        components:[
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_setchannel').setLabel('Set Channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('setup_counttype').setLabel('Change Mode').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_expressions').setLabel(state.allowExpressions?'Disable Expressions':'Enable Expressions').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_access').setLabel('Set Access Role').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_reset').setLabel('Reset Count').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('setup_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
            ),
        ],
    };
}

const B=(id,label,active)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(active?ButtonStyle.Primary:ButtonStyle.Secondary);
const statsRow=(uid,gid,active)=>new ActionRowBuilder().addComponents(B(`stats_user_${uid}_${gid}`,'User Stats',active==='user'),B(`stats_server_${uid}_${gid}`,'Server Stats',active==='server'));
function paginationRow(type,ctx,page,tp){const base=ctx?`lb_${type}_${ctx}`:`lb_${type}`;return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p${page-1}`).setLabel('\u25c4').setStyle(ButtonStyle.Secondary).setDisabled(page<=1),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${tp}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p${page+1}`).setLabel('\u25ba').setStyle(ButtonStyle.Secondary).setDisabled(page>=tp),new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));}
function globalTabRow(active){return new ActionRowBuilder().addComponents(B('lbt_gu','\u{1F465} Users',active==='gu'),B('lbt_gs_interactive','\u{1F3AE} Interactive',active==='gs_interactive'),B('lbt_gs_simple','\u{1F7E2} Simple',active==='gs_simple'),B('lbt_gs_countdown','\u23f3 Countdown',active==='gs_countdown'),B('lbt_gs_random','\u{1F3B2} Random',active==='gs_random'));}
function highscoreTabRow(active){return new ActionRowBuilder().addComponents(B('hst_interactive','\u{1F3AE} Interactive',active==='interactive'),B('hst_simple','\u{1F7E2} Simple',active==='simple'),B('hst_random','\u{1F3B2} Random',active==='random'),B('hst_countdown','\u23f3 Countdown',active==='countdown'));}
function countTypeRow(current){return new ActionRowBuilder().addComponents(B('ct_interactive','\u{1F3AE} Interactive',current==='interactive'),B('ct_simple','\u{1F7E2} Simple',current==='simple'),B('ct_countdown','\u23f3 Countdown',current==='countdown'),B('ct_random','\u{1F3B2} Random',current==='random'));}

const SUP={'\u2070':'0','\u00b9':'1','\u00b2':'2','\u00b3':'3','\u2074':'4','\u2075':'5','\u2076':'6','\u2077':'7','\u2078':'8','\u2079':'9','\u207a':'+','\u207b':'-'};
class C{constructor(r=0,i=0){this.r=r;this.i=i;}static of(x){return x instanceof C?x:new C(+x,0);}add(b){b=C.of(b);return new C(this.r+b.r,this.i+b.i);}sub(b){b=C.of(b);return new C(this.r-b.r,this.i-b.i);}mul(b){b=C.of(b);return new C(this.r*b.r-this.i*b.i,this.r*b.i+this.i*b.r);}div(b){b=C.of(b);const d=b.r*b.r+b.i*b.i;if(!d)return new C(NaN,NaN);return new C((this.r*b.r+this.i*b.i)/d,(this.i*b.r-this.r*b.i)/d);}pow(b){b=C.of(b);if(this.r===0&&this.i===0)return(b.r===0&&b.i===0)?new C(1):new C(0);return this.ln().mul(b).exp();}ln(){return new C(Math.log(Math.hypot(this.r,this.i)),Math.atan2(this.i,this.r));}exp(){const e=Math.exp(this.r);return new C(e*Math.cos(this.i),e*Math.sin(this.i));}neg(){return new C(-this.r,-this.i);}sqrt(){const m=Math.hypot(this.r,this.i)**0.5,a=Math.atan2(this.i,this.r)/2;return new C(m*Math.cos(a),m*Math.sin(a));}cbrt(){const m=Math.hypot(this.r,this.i)**(1/3),a=Math.atan2(this.i,this.r)/3;return new C(m*Math.cos(a),m*Math.sin(a));}nthRoot(n){const m=Math.hypot(this.r,this.i)**(1/n),a=Math.atan2(this.i,this.r)/n;return new C(m*Math.cos(a),m*Math.sin(a));}isReal(tol=1e-6){return Math.abs(this.i)<=tol;}}
const CCONSTS={pi:new C(Math.PI),e:new C(Math.E),phi:new C((1+Math.sqrt(5))/2),tau:new C(Math.PI*2),sqrt2:new C(Math.SQRT2),i:new C(0,1)};
function lambertW(x){if(x<-1/Math.E)return NaN;let w=x<1?x:Math.log(x);for(let i=0;i<100;i++){const ew=Math.exp(w),f=w*ew-x,df=ew*(w+1);const dw=f/(df-(w+2)*f/(2*(w+1)));w-=dw;if(Math.abs(dw)<1e-12)break;}return w;}
const CFUNCS={floor:v=>new C(Math.floor(v.r)),ceil:v=>new C(Math.ceil(v.r)),round:v=>new C(Math.round(v.r)),abs:v=>new C(Math.hypot(v.r,v.i)),ln:v=>new C(Math.log(v.r)),log:v=>new C(Math.log10(v.r)),log2:v=>new C(Math.log2(v.r)),log10:v=>new C(Math.log10(v.r)),exp:v=>new C(Math.exp(v.r)),sin:v=>new C(Math.sin(v.r)),cos:v=>new C(Math.cos(v.r)),tan:v=>new C(Math.tan(v.r)),asin:v=>new C(Math.asin(v.r)),acos:v=>new C(Math.acos(v.r)),atan:v=>new C(Math.atan(v.r)),sinh:v=>new C(Math.sinh(v.r)),cosh:v=>new C(Math.cosh(v.r)),tanh:v=>new C(Math.tanh(v.r)),arcsin:v=>new C(Math.asin(v.r)),arccos:v=>new C(Math.acos(v.r)),arctan:v=>new C(Math.atan(v.r)),lambertw:v=>new C(lambertW(v.r)),lw:v=>new C(lambertW(v.r)),w:v=>new C(lambertW(v.r))};
const CONSTS={phi:(1+Math.sqrt(5))/2,pi:Math.PI,e:Math.E,tau:Math.PI*2,sqrt2:Math.SQRT2};
function safeMath(expr){
    let s=expr.trim(),norm='';
    for(let k=0;k<s.length;k++){if(SUP[s[k]]!==undefined){let sup='';while(k<s.length&&SUP[s[k]]!==undefined)sup+=SUP[s[k++]];norm+='^'+sup;k--;}else norm+=s[k];}
    s=norm.replace(/[\u00d7\u00b7\u2022]/g,'*').replace(/\u00f7/g,'/').replace(/\u2212/g,'-').replace(/\s+/g,'').toLowerCase();
    s=s.replace(/(?<=[\d)])x(?=[\d(])/g,'*').replace(/\*\*/g,'^').replace(/(\d+)\u221a/g,(_,n)=>`nrt${n}(`).replace(/\u221c/g,'nrt4(').replace(/\u221b/g,'cbrt(').replace(/\u221a/g,'sqrt(');
    if(/[+\-]{2,}/.test(s))return null;
    let tokens=[],k=0;
    while(k<s.length){if(/\d/.test(s[k])||s[k]==='.'){let n='';while(k<s.length&&(/\d/.test(s[k])||s[k]==='.')){ n+=s[k++];}tokens.push({t:'n',v:parseFloat(n)});}else if(/[a-z]/.test(s[k])){let id='';while(k<s.length&&/[a-z0-9]/.test(s[k]))id+=s[k++];tokens.push({t:'id',v:id});}else if('+-*/^(),'.includes(s[k])){tokens.push({t:'op',v:s[k++]});}else k++;}
    const FUNCS=new Set(['sqrt','cbrt','floor','ceil','round','abs','ln','log','log2','log10','exp','sin','cos','tan','asin','acos','atan','arcsin','arccos','arctan','sinh','cosh','tanh','lambertw','lw','w','pow']);
    const isFunc=v=>FUNCS.has(v)||/^nrt\d+$/.test(v);
    const out=[];
    for(let j=0;j<tokens.length;j++){out.push(tokens[j]);const cur=tokens[j],nxt=tokens[j+1];if(!nxt)continue;const lOk=cur.t==='n'||(cur.t==='id'&&!isFunc(cur.v))||(cur.t==='op'&&cur.v===')');const rOk=nxt.t==='n'||nxt.t==='id'||(nxt.t==='op'&&nxt.v==='(');const fc=nxt.t==='op'&&nxt.v==='('&&cur.t==='id'&&isFunc(cur.v);if(lOk&&rOk&&!fc)out.push({t:'op',v:'*'});}
    tokens=out;let pos=0;const peek=()=>tokens[pos],consume=()=>tokens[pos++];
    function parseExpr(){let l=parseTerm();while(peek()&&(peek().v==='+'||peek().v==='-')){const op=consume().v;const r=parseTerm();l=op==='+'?l.add(r):l.sub(r);}return l;}
    function parseTerm(){let l=parsePow();while(peek()&&(peek().v==='*'||peek().v==='/')){const op=consume().v;const r=parsePow();l=op==='*'?l.mul(r):l.div(r);}return l;}
    function parsePow(){const b=parseUnary();if(peek()&&peek().v==='^'){consume();return b.pow(parsePow());}return b;}
    function parseUnary(){if(peek()&&peek().v==='-'){consume();return parseUnary().neg();}if(peek()&&peek().v==='+'){consume();return parseUnary();}return parseAtom();}
    function parseAtom(){const tok=peek();if(!tok)throw new Error('unexpected end');if(tok.t==='n'){consume();return new C(tok.v,0);}if(tok.t==='id'){consume();if(peek()&&peek().v==='('){consume();const arg=parseExpr();const arg2=peek()&&peek().v===','?(consume(),parseExpr()):null;if(peek()&&peek().v===')')consume();if(tok.v==='pow'){if(arg2===null)throw new Error('pow requires 2 args');return arg.pow(arg2);}if(tok.v==='sqrt')return arg2===null?arg.sqrt():arg.nthRoot(arg2.r);if(tok.v==='cbrt')return arg.cbrt();if(CFUNCS[tok.v])return CFUNCS[tok.v](arg);if(/^nrt(\d+)$/.test(tok.v))return arg.nthRoot(parseInt(tok.v.slice(3)));throw new Error('unknown fn: '+tok.v);}if(CCONSTS[tok.v])return CCONSTS[tok.v];throw new Error('unknown id: '+tok.v);}if(tok.t==='op'&&tok.v==='('){consume();const val=parseExpr();if(peek()&&peek().v===')')consume();return val;}throw new Error('unexpected: '+JSON.stringify(tok));}
    try{const res=parseExpr();if(!res.isReal()||!isFinite(res.r)||isNaN(res.r))return null;const r=Math.round(res.r);return Math.abs(r)>10_000_000?null:r;}catch{return null;}
}

function generateExpressions(n){
    const cands=[],phi=(1+Math.sqrt(5))/2;
    const cs=[['phi',phi],['pi',Math.PI],['e',Math.E],['sqrt2',Math.SQRT2],['tau',Math.PI*2]];
    for(let b=2;b<=50;b++)for(let x=2;x<=8;x++)if(Math.pow(b,x)===n)cands.push(`${b}^${x}`);
    for(const[nm,v]of cs){for(let x=1;x<=20;x++)if(Math.round(Math.pow(v,x))===n){cands.push(`${nm}^${x}`);break;}for(let x=1;x<=10;x++){const b=Math.round(Math.pow(v,x)),d=n-b;if(d!==0&&Math.abs(d)<=20)cands.push(`${nm}^${x}${d>0?'+'+d:d}`);}}
    if(n>4)for(let a=2;a<=Math.sqrt(n);a++)if(n%a===0){cands.push(`${a}*${n/a}`);break;}
    if(n>8){outer:for(let a=2;a<=Math.cbrt(n);a++)if(n%a===0){const r=n/a;for(let b=a;b<=Math.sqrt(r);b++)if(r%b===0){cands.push(`${a}*${b}*${r/b}`);break outer;}}}
    if(n>2){const a=Math.max(1,Math.floor(n*0.35));cands.push(`${a}+${n-a}`);}
    cands.push(`${n+Math.round(n*0.6)+1}-${Math.round(n*0.6)+1}`,`${n*(n<=10?2:3)}/${n<=10?2:3}`);
    if(n>5)for(let a=2;a<=10;a++){const base=Math.floor(n/a)*a,d=n-base;if(base>0&&d>0&&d<a){cands.push(`${a}*${Math.floor(n/a)}+${d}`);break;}}
    const seen=new Set(),res=[];
    for(const c of cands.sort((a,b)=>(/[a-z]/.test(b)?1:0)-(/[a-z]/.test(a)?1:0)||a.length-b.length))if(!seen.has(c)&&res.length<3){seen.add(c);res.push(c);}
    if(res.length<3)res.push(`${n-1}+1`);if(res.length<3)res.push(`${n*2}/2`);if(res.length<3)res.push(`${n+3}-3`);
    return res.slice(0,3);
}

function buildHelpPage(page){
    const pages=[
        E('#5865F2','\u{1F3AE} How to Play').setDescription('Count up (or down!) together in the counting channel.').addFields(
            {name:'Rules',value:"• Type the next number\n• Can't count twice in a row (default)\n• Wrong number resets to 1!\n• Math expressions supported"},
            {name:'Correct',value:'React added, count goes up'},{name:'Wrong / too fast',value:'Count resets!'},
            {name:'Milestones',value:'Bot celebrates every 100 counts'},
            {name:'Saves',value:'Earned at 50, 100, 250, 500, 1000, 2000, then every 2000. Anyone can use one within 1 minute to undo a ruin!'},
            {name:'Simple mode',value:'No resets \u2014 wrong messages are silently deleted.'},
        ).setFooter({text:'Page 1/5'}),
        E('#5865F2','Commands').setDescription('All commands:').addFields(
            {name:'Counting',value:'`/counting reset`'},
            {name:'Config',value:'`/config channel` `/config setcount` `/config view` `/config maxstreak` `/config expressions` `/config access` `/config counttype`'},
            {name:'Stats',value:'`/stats [user]` `/leaderboard server` `/leaderboard global` `/leaderboard highscores`'},
            {name:'Utilities',value:'`/calculate [expression]` `/invite` `/help` `/setup`'},
            {name:'\u{1F6E0}\ufe0f Support Server',value:`Need help or want to report a bug? [Join the support server](${SUPPORT_URL})`},
        ).setFooter({text:'Page 2/5'}),
        E('#5865F2','Config').setDescription('Requires Administrator or configured access role.').addFields(
            {name:'/config maxstreak <n>',value:'Max consecutive counts per user (1\u2013100)'},
            {name:'/config expressions <bool>',value:'Allow/block math expressions'},
            {name:'/config access',value:'Set which role can use config commands'},
            {name:'/config counttype',value:'Switch between Interactive, Simple, Countdown, and Random mode'},
            {name:'/setup',value:'All-in-one setup panel for admins'},
        ).setFooter({text:'Page 3/5'}),
        E('#5865F2','\u23f3 Countdown & \u{1F3B2} Random Modes').addFields(
            {name:'\u23f3 Countdown Mode',value:'Count DOWN from 100 to 1! When you hit 1, the cycle completes and resets. Each server tracks its completed cycles on the global leaderboard.'},
            {name:'Countdown Rules',value:'• Type the next number going DOWN\n• Wrong number resets to 100\n• Cycles are tracked globally'},
            {name:'\u{1F3B2} Random Mode',value:'Like Interactive, but a random modifier changes what numbers are valid! The modifier changes every time the count resets.'},
            {name:'Random Modifiers',value:'• Every 2nd / 3rd number\n• Primes only\n• Fibonacci sequence\n• Perfect squares\n• Palindromes\n• Multiples of 7\n• Triangular numbers'},
        ).setFooter({text:'Page 4/5'}),
        E('#5865F2','Expressions').setDescription('Math expressions, rounded to nearest whole number.').addFields(
            {name:'Operators',value:'`+` `-` `*` `/` `^`'},
            {name:'Constants',value:'`pi` `phi` `e` `tau` `sqrt2`'},
            {name:'Functions',value:'`ln` `log` `log2` `sqrt(x,n)` `cbrt` `pow(x,n)` `sin` `cos` `tan` `asin`/`arcsin` `acos`/`arccos` `atan`/`arctan` `floor` `ceil` `abs` `exp` `round`'},
            {name:'Examples',value:'`ln(e)`\u2192**1** `log(10)`\u2192**1** `sin(pi)`\u2192**0** `pi^2`\u2192**10** `2^8`\u2192**256**'},
            {name:'/calculate',value:'Type a number to get 3 expressions, or type your own expression to evaluate it!'},
        ).setFooter({text:'Page 5/5'}),
    ];
    return{embeds:[pages[page-1]],components:[new ActionRowBuilder().addComponents(B('help_1','How to Play',page===1),B('help_2','Commands',page===2),B('help_3','Config',page===3),B('help_4','New Modes',page===4),B('help_5','Expressions',page===5))]};
}

function earnsSave(v){const ms=[50,100,250,500,1000,2000];return ms.includes(v)||(v>2000&&v%2000===0);}
function nextSaveAt(v){const ms=[50,100,250,500,1000,2000];for(const m of ms)if(v<m)return m;return Math.ceil((v+1)/2000)*2000;}
function doReset(gid,state,userId){
    if(state.countType==='countdown'){state.current=state.countdownStart??100;}
    else if(state.countType==='random'){const mod=pickRandomModifier();state.randomModifier=mod.id;state.randomModifierLabel=mod.label;state.current=0;}
    else{state.current=0;}
    state.lastUserId=null;state.consecutiveCount=0;delete state.pendingSave;
    saveState(gid,state);updateUserStat(gid,userId,{ruined:1});
}
function resetOnModeSwitch(gid,state,newType,guild){
    const mod=newType==='random'?pickRandomModifier():null;
    if(mod){state.randomModifier=mod.id;state.randomModifierLabel=mod.label;}
    state.current=newType==='countdown'?(state.countdownStart??100):0;
    state.lastUserId=null;state.consecutiveCount=0;delete state.pendingSave;
    saveState(gid,state);
    if(state.channelId&&guild){const ch=guild.channels.cache.get(state.channelId);if(ch){const startFrom=newType==='countdown'?state.countdownStart??100:1;const modNote=mod?`\nModifier: **${mod.label}**`:'';ch.send({embeds:[E('#ff9900',`${MODE_EMOJI[newType]} Switched to ${MODE_LABEL[newType]} mode`).setDescription(`Count reset. Start again from **${startFrom}**!${modNote}`)]}).catch(()=>{});}}
}
async function triggerRuin(channel,gid,state,userId,reason){
    const prev=state.current,expiresAt=Date.now()+60_000;
    state.pendingSave={placeholder:true,userId,prevCount:prev,expiresAt};saveState(gid,state);
    if((state.saves??0)>0&&state.countType!=='simple'&&state.countType!=='countdown'){
        const row=new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`saveuse_${userId}_${prev}_${gid}_${expiresAt}`).setLabel(`Use Save (${state.saves} left)`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`savedecline_${userId}_${prev}_${gid}_${expiresAt}`).setLabel('Let it reset').setStyle(ButtonStyle.Danger),
        );
        const prompt=await channel.send({embeds:[E('#ff9900','\u26a0\ufe0f Count almost ruined!').setDescription(`<@${userId}> made a mistake! (${reason})\nYou have a **Save** \u2014 use it within **1 minute** to keep the count at **${prev}**!`).addFields({name:'Server saves',value:`**${state.saves}**`,inline:true},{name:'At risk',value:`**${prev}**`,inline:true})],components:[row]}).catch(e=>{console.error('triggerRuin save prompt failed:',e.message);return null;});
        if(!prompt){doReset(gid,state,userId);return;}
        state.pendingSave={msgId:prompt.id,userId,prevCount:prev,expiresAt};saveState(gid,state);
        setTimeout(async()=>{
            const fresh=await getState(gid);if(!fresh.pendingSave||fresh.pendingSave.expiresAt!==expiresAt)return;
            doReset(gid,fresh,userId);
            const note=fresh.countType==='random'?`\nNew modifier: **${fresh.randomModifierLabel}**`:'';
            await prompt.edit({embeds:[E('#ff4444','\u{1F4A5} Save expired!').setDescription(`<@${userId}> didn't use their save in time. Count resets!${note}`)],components:[]}).catch(()=>{});
        },60_000);
    }else{
        doReset(gid,state,userId);
        const resetTo=state.countType==='countdown'?(state.countdownStart??100):1;
        const note=state.countType==='random'?`\nNew modifier: **${state.randomModifierLabel}**`:'';
        await channel.send({embeds:[E('#ff4444','\u{1F4A5} Count ruined!').setDescription(`<@${userId}> ruined the count! (${reason})\nCount was at **${prev}**.${note}`).addFields({name:'Reset to',value:`**${resetTo}**`,inline:true},{name:'High Score',value:`**${state.highScore}**`,inline:true}).setFooter({text:`Start again from ${resetTo}!`})]}).catch(e=>console.error('ruin msg failed:',e.message));
    }
}

const SUPPORT_URL='https://discord.gg/Qrp82cRhUW';
async function hasAnnouncedSupport(gid){try{const r=await pool.query('SELECT 1 FROM support_announced WHERE guild_id=$1',[gid]);return r.rowCount>0;}catch{return true;}}
function markSupportAnnounced(gid){pool.query('INSERT INTO support_announced (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING',[gid]).catch(()=>{});}
function pickAdminChannel(guild){
    const text=guild.channels.cache.filter(c=>c.isTextBased&&c.isTextBased()&&c.viewable);
    const botMember=guild.members.me;
    const canSend=ch=>botMember&&ch.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages);
    const adminOnly=text.filter(ch=>{
        if(!canSend(ch))return false;
        const everyone=guild.roles.everyone;
        const everyonePerms=ch.permissionsFor(everyone);
        return everyonePerms&&!everyonePerms.has(PermissionFlagsBits.ViewChannel);
    });
    const nameMatch=ch=>/admin|staff|mod|owner|management/i.test(ch.name);
    return adminOnly.find(nameMatch)??adminOnly.first()??text.filter(canSend).find(nameMatch)??guild.systemChannel??text.filter(canSend).first()??null;
}
async function announceSupportServer(guild){
    if(await hasAnnouncedSupport(guild.id))return;
    const ch=pickAdminChannel(guild);
    if(ch){await ch.send({embeds:[E('#5865F2','\u{1F44B} Thanks for adding Counting Bot!').setDescription(`Need help, want to report a bug, or have a feature request?\nJoin the support server: ${SUPPORT_URL}`)]}).catch(()=>{});}
    markSupportAnnounced(guild.id);
}
function keepAlive(){const ping=()=>{const u=process.env.RENDER_EXTERNAL_URL||`http://localhost:${process.env.PORT||3000}`;(u.startsWith('https')?require('https'):http).get(u,()=>{}).on('error',()=>{});};setTimeout(ping,5000);setInterval(ping,14*60*1000);}

client.once('ready',async()=>{
    console.log(`Online as ${client.user.tag}`);
    client.user.setPresence({activities:[{name:'Counting things',type:ActivityType.Watching}],status:'online'});
    const cmds=[
        new SlashCommandBuilder().setName('counting').setDescription('Configure or view the counting game').addSubcommand(s=>s.setName('reset').setDescription('Manually reset the count')),
        new SlashCommandBuilder().setName('config').setDescription('Configure bot settings')
            .addSubcommand(s=>s.setName('channel').setDescription('Set the counting channel').addChannelOption(o=>o.setName('channel').setDescription('Channel').setRequired(true)))
            .addSubcommand(s=>s.setName('setcount').setDescription('Set the current count').addIntegerOption(o=>o.setName('number').setDescription('Number').setRequired(true).setMinValue(0).setMaxValue(1000)))
            .addSubcommand(s=>s.setName('view').setDescription('View current count and settings'))
            .addSubcommand(s=>s.setName('maxstreak').setDescription('Max consecutive counts per user').addIntegerOption(o=>o.setName('amount').setDescription('1\u2013100').setRequired(true).setMinValue(1).setMaxValue(100)))
            .addSubcommand(s=>s.setName('expressions').setDescription('Allow math expressions').addBooleanOption(o=>o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
            .addSubcommand(s=>s.setName('access').setDescription('Set which role can use config'))
            .addSubcommand(s=>s.setName('counttype').setDescription('Switch counting mode')),
        new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboards')
            .addSubcommand(s=>s.setName('server').setDescription('Top counters in this server'))
            .addSubcommand(s=>s.setName('global').setDescription('Global leaderboard'))
            .addSubcommand(s=>s.setName('highscores').setDescription('Servers by mode high score / cycles')),
        new SlashCommandBuilder().setName('stats').setDescription('View counting stats').addUserOption(o=>o.setName('user').setDescription('User to check')),
        new SlashCommandBuilder().setName('calculate').setDescription('Calculate an expression, or get 3 expressions for a number').addStringOption(o=>o.setName('input').setDescription('A number or expression').setRequired(true)),
        new SlashCommandBuilder().setName('setup').setDescription('Open the bot setup panel (admin only)'),
        new SlashCommandBuilder().setName('invite').setDescription('Invite this bot'),
        new SlashCommandBuilder().setName('help').setDescription('View all commands'),
    ].map(c=>c.toJSON());
    await client.application.commands.set(cmds);console.log('Commands registered');
    try{await initDB();const r=await pool.query('SELECT guild_id,data FROM counting');for(const{guild_id,data}of r.rows)stateCache.set(guild_id,data);console.log(`Loaded ${r.rows.length} guild(s)`);}catch(e){console.error('DB init failed:',e.message);}
    keepAlive();
    for(const guild of client.guilds.cache.values()){await announceSupportServer(guild).catch(()=>{});}
});
client.on('guildCreate',guild=>{announceSupportServer(guild).catch(()=>{});});

client.on('messageCreate',async message=>{
    if(message.author.bot||!message.guild)return;
    const gid=message.guild.id;
    const state=await getState(gid).catch(()=>null);
    if(!state?.channelId||message.channel.id!==state.channelId)return;
    if(state.pendingSave){if(Date.now()<state.pendingSave.expiresAt)return;delete state.pendingSave;saveState(gid,state);}
    const raw=message.content.trim();
    const hasConst=Object.keys(CONSTS).some(c=>new RegExp(`(?<![a-z])${c}(?![a-z])`,'i').test(raw));
    const hasFancyOp=/[\u00d7\u00b7\u00f7\u00b2\u00b3\u00b9\u2070\u2074\u2075\u2076\u2077\u2078\u2079\u207a\u207b\u221a\u221b\u221c]/.test(raw)||/\d[xX]\d/.test(raw);
    const isExpr=(/[+\-*/^()]/.test(raw)&&!/^\-?\d+$/.test(raw))||hasConst||hasFancyOp;
    const value=safeMath(raw);
    const NE=['\u0030\ufe0f\u20e3','\u0031\ufe0f\u20e3','\u0032\ufe0f\u20e3','\u0033\ufe0f\u20e3','\u0034\ufe0f\u20e3','\u0035\ufe0f\u20e3','\u0036\ufe0f\u20e3','\u0037\ufe0f\u20e3','\u0038\ufe0f\u20e3','\u0039\ufe0f\u20e3'];

    if(state.countType==='simple'){
        const expected=state.current+1,sameUser=message.author.id===state.lastUserId;
        const newStreak=sameUser?state.consecutiveCount+1:1,streakViolation=state.maxStreak>0&&sameUser&&newStreak>state.maxStreak;
        if(!(value!==null||isExpr))return;
        if(value===null||value!==expected||streakViolation){const me=message.guild.members.me;if(!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages))return;await message.delete().catch(()=>{});return;}
        state.current=value;state.lastUserId=message.author.id;state.consecutiveCount=newStreak;
        if(value>state.highScore)state.highScore=value;saveState(gid,state);updateUserStat(gid,message.author.id,{correct:1});
        await message.react(value<=9?NE[value]:'\u2705').catch(()=>{});
        if(value%100===0)await message.channel.send({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`)]}).catch(()=>{});
        return;
    }
    if(state.countType==='countdown'){
        if(isExpr&&!state.allowExpressions){await message.react('\u274c').catch(()=>{});const s=await message.channel.send({embeds:[E('#ff4444','Expressions disabled').setDescription('Expressions not allowed here!')]}).catch(()=>null);if(s)setTimeout(()=>s.delete().catch(()=>{}),5000);return;}
        if(value===null)return;
        const start=state.countdownStart??100;
        if(state.current===0||state.current>start)state.current=start;
        const expected=state.current-1;
        if(value!==expected){if(!await claimMessage(message.id))return;message.react('\u274c').catch(()=>{});await triggerRuin(message.channel,gid,state,message.author.id,`sent \`${value}\` but expected \`${expected}\``);return;}
        if(state.maxStreak>0&&message.author.id===state.lastUserId&&state.consecutiveCount>=state.maxStreak){if(!await claimMessage(message.id))return;message.react('\u274c').catch(()=>{});await triggerRuin(message.channel,gid,state,message.author.id,`counted more than **${state.maxStreak}** time(s) in a row`);return;}
        const same=message.author.id===state.lastUserId;
        state.current=value;state.lastUserId=message.author.id;state.consecutiveCount=same?state.consecutiveCount+1:1;
        saveState(gid,state);updateUserStat(gid,message.author.id,{correct:1});
        await message.react(value<=9&&value>=0?NE[value]:'\u2705').catch(()=>{});
        if(value===1){
            state.countdownCycles=(state.countdownCycles??0)+1;state.current=start;state.lastUserId=null;state.consecutiveCount=0;saveState(gid,state);
            await message.channel.send({embeds:[E('#ffd700',`\u{1F389} Countdown Complete! Cycle #${state.countdownCycles}`).setDescription(`The count reached **1**! \u{1F38A} Incredible work, <@${message.author.id}> finished it off!\nThe countdown resets to **${start}**. Let's go again!`).addFields({name:'\u{1F504} Cycles completed',value:`**${state.countdownCycles}**`,inline:true},{name:'\u{1F522} Restarting from',value:`**${start}**`,inline:true}).setFooter({text:'Can you do it again?'})]}).catch(()=>{});
        }else if(value%25===0){
            await message.channel.send({embeds:[E('#00cc88',`\u23f3 ${value} to go!`).setDescription(`Getting closer! **${value}** left to count down.`)]}).catch(()=>{});
        }
        return;
    }
    if(state.countType==='random'){
        if(!state.randomModifier){const mod=pickRandomModifier();state.randomModifier=mod.id;state.randomModifierLabel=mod.label;saveState(gid,state);await message.channel.send({embeds:[E('#9b59b6','\u{1F3B2} New Random Modifier!').setDescription(`The modifier for this round is:\n**${mod.label}**\n${mod.desc}`)]}).catch(()=>{});}
        if(isExpr&&!state.allowExpressions){await message.react('\u274c').catch(()=>{});const s=await message.channel.send({embeds:[E('#ff4444','Expressions disabled').setDescription('Expressions not allowed!')]}).catch(()=>null);if(s)setTimeout(()=>s.delete().catch(()=>{}),5000);return;}
        if(value===null)return;
        const mod=getModifier(state.randomModifier);
        const expected=state.current===0?firstValidForModifier(state.randomModifier):mod.next(state.current);
        if(value!==expected){if(!await claimMessage(message.id))return;message.react('\u274c').catch(()=>{});await triggerRuin(message.channel,gid,state,message.author.id,`sent \`${value}\` but expected \`${expected}\` (modifier: ${mod.label})`);return;}
        if(state.maxStreak>0&&message.author.id===state.lastUserId&&state.consecutiveCount>=state.maxStreak){if(!await claimMessage(message.id))return;message.react('\u274c').catch(()=>{});await triggerRuin(message.channel,gid,state,message.author.id,`counted more than **${state.maxStreak}** time(s) in a row`);return;}
        const same=message.author.id===state.lastUserId;
        state.current=value;state.lastUserId=message.author.id;state.consecutiveCount=same?state.consecutiveCount+1:1;
        if(value>state.highScore)state.highScore=value;saveState(gid,state);updateUserStat(gid,message.author.id,{correct:1});
        if(earnsSave(value)){state.saves=(state.saves??0)+1;saveState(gid,state);await message.channel.send({embeds:[E('#ffd700','\u{1F6E1}\ufe0f Save earned!').setDescription(`The server earned a **Save** for reaching **${value}**! (**${state.saves}** total)\nNext save at **${nextSaveAt(value)}**.`)]}).catch(()=>{});}
        await message.react('\u2705').catch(()=>{});
        if(value%10===0||value<=5)await message.channel.send({embeds:[E('#9b59b6',`\u{1F3B2} ${value}!`).setDescription(`${mod.hint(value)} \u2014 Modifier: **${mod.label}**`)]}).catch(()=>{});
        if(value%100===0)await message.channel.send({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>! \u{1F3B2} Modifier: ${mod.label}`).setFooter({text:`High score: ${state.highScore}`})]}).catch(()=>{});
        return;
    }
    // INTERACTIVE
    const expected=state.current+1;
    if(isExpr&&!state.allowExpressions){await message.react('\u274c').catch(()=>{});const s=await message.channel.send({embeds:[E('#ff4444','Expressions disabled').setDescription(`\`${raw}\` \u2014 expressions not allowed here!`)]}).catch(()=>null);if(s)setTimeout(()=>s.delete().catch(()=>{}),5000);return;}
    if(value===null)return;
    if(value!==expected){if(!await claimMessage(message.id))return;message.react('\u274c').catch(()=>{});await triggerRuin(message.channel,gid,state,message.author.id,`sent \`${value}\` but expected \`${expected}\``);return;}
    if(state.maxStreak>0&&message.author.id===state.lastUserId&&state.consecutiveCount>=state.maxStreak){if(!await claimMessage(message.id))return;message.react('\u274c').catch(()=>{});await triggerRuin(message.channel,gid,state,message.author.id,`counted more than **${state.maxStreak}** time(s) in a row`);return;}
    const same=message.author.id===state.lastUserId;
    state.current=value;state.lastUserId=message.author.id;state.consecutiveCount=same?state.consecutiveCount+1:1;
    if(value>state.highScore)state.highScore=value;saveState(gid,state);updateUserStat(gid,message.author.id,{correct:1});
    if(earnsSave(value)){state.saves=(state.saves??0)+1;saveState(gid,state);await message.channel.send({embeds:[E('#ffd700','\u{1F6E1}\ufe0f Save earned!').setDescription(`The server earned a **Save** for reaching **${value}**!\nThe server now has **${state.saves}** save(s). Next save at **${nextSaveAt(value)}**.`)]}).catch(()=>{});}
    await message.react(value<=9?NE[value]:'\u2705').catch(()=>{});
    if(value%100===0)await message.channel.send({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`).setFooter({text:`High score: ${state.highScore}`})]}).catch(()=>{});
});

client.on('interactionCreate',async interaction=>{
    const gid=interaction.guild?.id;
    if(interaction.isButton()){
        const id=interaction.customId;
        if(id.startsWith('help_')){const p=parseInt(id.split('_')[1]);if(!isNaN(p)&&p>=1&&p<=5)return interaction.update(buildHelpPage(p));}
        if(id.startsWith('calc_copy_')){const parts=id.split('_');const expr=parts.slice(3).join('_');return interaction.reply({content:`\`${expr}\`\nTap and hold to copy — then paste it in the counting channel!`,...ep()});}
        if(id.startsWith('setup_')){
            if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator))return interaction.reply({content:'Admins only.',...ep()});
            const state=await getState(gid);
            if(id==='setup_refresh')return interaction.update(buildSetupEmbed(state));
            if(id==='setup_counttype'){const cycle={interactive:'simple',simple:'countdown',countdown:'random',random:'interactive'};state.countType=cycle[state.countType??'interactive']??'interactive';resetOnModeSwitch(gid,state,state.countType,interaction.guild);return interaction.update(buildSetupEmbed(state));}
            if(id==='setup_expressions'){state.allowExpressions=!state.allowExpressions;saveState(gid,state);return interaction.update(buildSetupEmbed(state));}
            if(id==='setup_reset'){const prev=state.current;state.current=state.countType==='countdown'?state.countdownStart??100:0;state.lastUserId=null;state.consecutiveCount=0;saveState(gid,state);if(state.channelId){const ch=interaction.guild.channels.cache.get(state.channelId);if(ch)ch.send({embeds:[E('#ff9900','\u{1F504} Count reset').setDescription(`Admin reset from **${prev}**. Start again!`)]}).catch(()=>{});}return interaction.update(buildSetupEmbed(state));}
            if(id==='setup_setchannel')return interaction.reply({embeds:[E('#5865F2','Set Counting Channel').setDescription('Select the channel to use for counting:')],components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').setPlaceholder('Select a text channel').addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1))],...ep()});
            if(id==='setup_access')return interaction.reply({embeds:[E('#5865F2','Set Access Role').setDescription('Select which role can use `/config` commands:')],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_role_select').setPlaceholder('Select a role').setMinValues(1).setMaxValues(1))],...ep()});
        }
        if(['ct_interactive','ct_simple','ct_countdown','ct_random'].includes(id)){
            if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)&&!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            const state=await getState(gid),newType=id.slice(3);
            state.countType=newType;resetOnModeSwitch(gid,state,newType,interaction.guild);
            const desc={interactive:'Back to **Interactive** mode. Wrong numbers and streaks will reset the count!',simple:'**Simple** mode enabled. Wrong messages are silently deleted.',countdown:`**Countdown** mode enabled! Count DOWN from **${state.countdownStart??100}** to **1**. Complete a cycle to earn glory!`,random:`**Random** mode enabled! Current modifier: **${state.randomModifierLabel??'none'}**\nThe modifier changes every reset \u2014 good luck!`};
            return interaction.update({embeds:[E('#5865F2',`Mode set to ${MODE_EMOJI[newType]} ${MODE_LABEL[newType]}`).setDescription(desc[newType])],components:[countTypeRow(newType)]});
        }
        if(id.startsWith('saveuse_')||id.startsWith('savedecline_')){
            const parts=id.split('_'),action=parts[0],ownerId=parts[1],prevCount=parseInt(parts[2]),btnGid=parts[3],expiresAt=parseInt(parts[4]);
            if(interaction.user.id!==ownerId)return interaction.reply({content:'Only the person who ruined the count can do this!',...ep()});
            if(Date.now()>expiresAt)return interaction.reply({content:'Save prompt has expired.',...ep()});
            const state=await getState(btnGid);delete state.pendingSave;
            if(action==='saveuse'){
                if((state.saves??0)<1)return interaction.reply({content:'The server has no saves left.',...ep()});
                state.current=prevCount;state.lastUserId=ownerId;state.consecutiveCount=1;state.saves=(state.saves??1)-1;state.savesUsed=(state.savesUsed??0)+1;
                saveState(btnGid,state);await updateUserStat(btnGid,ownerId,{savesUsed:1});
                const nextNum=state.countType==='countdown'?prevCount-1:prevCount+1;
                return interaction.update({embeds:[E('#00cc88','\u{1F6E1}\ufe0f Save used!').setDescription(`<@${ownerId}> used a **Save** \u2014 count stays at **${prevCount}**!`).addFields({name:'Remaining',value:`**${state.saves}**`,inline:true},{name:'Next number',value:`**${nextNum}**`,inline:true})],components:[]});
            }else{
                const resetTo=state.countType==='countdown'?(state.countdownStart??100):1;
                if(state.countType==='countdown'){state.current=resetTo;}else if(state.countType==='random'){const mod=pickRandomModifier();state.randomModifier=mod.id;state.randomModifierLabel=mod.label;state.current=0;}else{state.current=0;}
                state.lastUserId=null;state.consecutiveCount=0;saveState(btnGid,state);updateUserStat(btnGid,ownerId,{ruined:1});
                const note=state.countType==='random'?`\nNew modifier: **${state.randomModifierLabel}**`:'';
                return interaction.update({embeds:[E('#ff4444','\u{1F4A5} Count ruined!').setDescription(`<@${ownerId}> declined the save. Count resets to **${resetTo}**.${note}`).addFields({name:'High Score',value:`**${state.highScore}**`,inline:true})],components:[]});
            }
        }
        if(id.startsWith('stats_')){
            await interaction.deferUpdate();const[,view,tuid,bgid]=id.split('_');
            try{if(view==='user'){const u=await client.users.fetch(tuid).catch(()=>interaction.user);return interaction.editReply({embeds:[await buildUserStatsEmbed(bgid,u)],components:[statsRow(tuid,bgid,'user')]});}
            if(view==='server'){const g=client.guilds.cache.get(bgid)??await client.guilds.fetch(bgid).catch(()=>interaction.guild);return interaction.editReply({embeds:[await buildServerStatsEmbed(g)],components:[statsRow(tuid,bgid,'server')]});}}
            catch{return interaction.editReply({content:'Failed to load stats.'});}
        }
        if(id.startsWith('lbt_')){
            await interaction.deferUpdate();
            try{
                if(id==='lbt_gu'){const{embed,totalPages}=await buildGlobalUsersEmbed(1);return interaction.editReply({embeds:[embed],components:[globalTabRow('gu'),paginationRow('gu','',1,totalPages)]});}
                const sf=id.replace('lbt_gs_','');
                if(['interactive','simple','countdown','random'].includes(sf)){const r=await buildGlobalServersEmbed(1,sf),base=`lb_gs_f${sf}`;const pRow=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p0`).setLabel('\u25c4').setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`1/${r.totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p2`).setLabel('\u25ba').setStyle(ButtonStyle.Secondary).setDisabled(r.totalPages<=1),new ButtonBuilder().setCustomId(`${base}_p1`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));return interaction.editReply({embeds:[r.embed],components:[globalTabRow(`gs_${sf}`),pRow]});}
            }catch(e){console.error('tab btn:',e);await interaction.editReply({content:'Failed to load.'}).catch(()=>{});}
        }
        if(id.startsWith('hst_')){
            await interaction.deferUpdate();const filter=id.slice(4);
            try{const{embed,totalPages}=await buildHighscoresEmbed(1,filter);return interaction.editReply({embeds:[embed],components:[highscoreTabRow(filter),paginationRow(`hs_${filter}`,'',1,totalPages)]});}
            catch(e){console.error('hst btn:',e);await interaction.editReply({content:'\u274c Failed.'}).catch(()=>{});}
        }
        if(id.startsWith('lb_')){
            const last=id.split('_').pop();if(last==='info')return interaction.deferUpdate();
            const page=parseInt(last.replace('p',''));if(isNaN(page)||page<1)return interaction.deferUpdate();
            await interaction.deferUpdate();
            try{
                const type=id.split('_')[1];
                if(type==='gu'){const{embed,totalPages}=await buildGlobalUsersEmbed(page);return interaction.editReply({embeds:[embed],components:[globalTabRow('gu'),paginationRow('gu','',page,totalPages)]});}
                if(type==='gs'){const fs=id.split('_').find(s=>s.startsWith('f')),filter=fs?fs.slice(1):'interactive';const r=await buildGlobalServersEmbed(page,filter),base=`lb_gs_f${filter}`;const pRow=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p${page-1}`).setLabel('\u25c4').setStyle(ButtonStyle.Secondary).setDisabled(page<=1),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${r.totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p${page+1}`).setLabel('\u25ba').setStyle(ButtonStyle.Secondary).setDisabled(page>=r.totalPages),new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));return interaction.editReply({embeds:[r.embed],components:[globalTabRow(`gs_${filter}`),pRow]});}
                if(type==='hs'){const parts=id.split('_'),fi=parts.findIndex(p=>['interactive','simple','random','countdown'].includes(p)),filter=fi!==-1?parts[fi]:'interactive';const{embed,totalPages}=await buildHighscoresEmbed(page,filter);return interaction.editReply({embeds:[embed],components:[highscoreTabRow(filter),paginationRow(`hs_${filter}`,'',page,totalPages)]});}
                if(type==='sv'){const svgid=id.split('_')[2];const{embed,totalPages}=await buildServerLbEmbed(svgid,page);return interaction.editReply({embeds:[embed],components:[paginationRow('sv',svgid,page,totalPages)]});}
            }catch(e){console.error('lb btn:',e);await interaction.editReply({content:'Failed to load. Try again.'}).catch(()=>{});}
        }
        return;
    }
    if(interaction.isRoleSelectMenu()){
        if(interaction.customId==='setup_role_select'||interaction.customId.startsWith('access_role_')){
            const state=await getState(gid);state.accessRoleId=interaction.values[0];saveState(gid,state);
            return interaction.update({embeds:[E('#5865F2','Access role set').setDescription(`<@&${state.accessRoleId}> can now use config commands.`)],components:[]});
        }
    }
    if(interaction.isChannelSelectMenu()&&interaction.customId==='setup_channel_select'){
        const state=await getState(gid);state.channelId=interaction.values[0];saveState(gid,state);
        return interaction.update({embeds:[E('#5865F2','Counting channel set').setDescription(`<#${state.channelId}> is now the counting channel. Start from **1**!`)],components:[]});
    }
    if(!interaction.isChatInputCommand())return;
    if(!interaction.guild)return interaction.reply({content:'Server only.',...ep()});
    const{commandName:cmd,options}=interaction;
    try{
        if(cmd==='help')return interaction.reply({...buildHelpPage(1),...ep()});
        if(cmd==='invite')return interaction.reply({embeds:[E('#5865F2','Invite Counting Bot').setDescription(`[**Invite me!**](https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=93248&scope=bot%20applications.commands)`).addFields({name:'Permissions',value:'View Channels \u00b7 Send Messages \u00b7 Add Reactions \u00b7 Read History \u00b7 Manage Messages'})],...ep()});
        if(cmd==='setup'){if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator))return interaction.reply({content:'Admins only.',...ep()});return interaction.reply({...buildSetupEmbed(await getState(gid)),...ep()});}
        if(cmd==='calculate'){
            await interaction.deferReply(ep());
            const input=options.getString('input').trim(),evaluated=safeMath(input),looksLikeNumber=/^[\d]+$/.test(input.replace(/\s/g,''));
            if(looksLikeNumber&&evaluated!==null){const exprs=generateExpressions(evaluated);const copyRow=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`calc_copy_0_${exprs[0]}`).setLabel(`Copy: ${exprs[0]}`).setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`calc_copy_1_${exprs[1]}`).setLabel(`Copy: ${exprs[1]}`).setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`calc_copy_2_${exprs[2]}`).setLabel(`Copy: ${exprs[2]}`).setStyle(ButtonStyle.Secondary),);return interaction.editReply({embeds:[E('#5865F2',`Ways to write ${evaluated}`).setDescription(`3 expressions for **${evaluated}**:`).addFields(...exprs.map((x,i)=>({name:`${['\u0031\ufe0f\u20e3','\u0032\ufe0f\u20e3','\u0033\ufe0f\u20e3'][i]} \`${x}\``,value:`= **${safeMath(x)??evaluated}**`,inline:true}))).setFooter({text:'Supports: + - * / ^ pi phi e tau sqrt2 \u00b7 ln log sin cos tan sqrt cbrt'})],components:[copyRow]});}
            if(evaluated!==null)return interaction.editReply({embeds:[E('#5865F2','Result').addFields({name:'Expression',value:`\`${input}\``,inline:true},{name:'Result',value:`**${evaluated}**`,inline:true}).setFooter({text:'Rounded to nearest whole number'})]});
            return interaction.editReply({embeds:[E('#ff4444','Invalid expression').setDescription(`\`${input}\` couldn't be evaluated.\n\nConstants: \`pi\` \`phi\` \`e\` \`tau\` \`sqrt2\``)]});
        }
        if(cmd==='stats'){await interaction.deferReply(ep());const u=options.getUser('user')??interaction.user;return interaction.editReply({embeds:[await buildUserStatsEmbed(gid,u)],components:[statsRow(u.id,gid,'user')]});}
        if(cmd==='leaderboard'){
            await interaction.deferReply(ep());const sub=options.getSubcommand();
            if(sub==='server'){const{embed,totalPages}=await buildServerLbEmbed(gid,1);return interaction.editReply({embeds:[embed],components:[paginationRow('sv',gid,1,totalPages)]});}
            if(sub==='global'){const{embed,totalPages}=await buildGlobalUsersEmbed(1);return interaction.editReply({embeds:[embed],components:[globalTabRow('gu'),paginationRow('gu','',1,totalPages)]});}
            if(sub==='highscores'){const{embed,totalPages}=await buildHighscoresEmbed(1,'interactive');return interaction.editReply({embeds:[embed],components:[highscoreTabRow('interactive'),paginationRow('hs_interactive','',1,totalPages)]});}
        }
        if(cmd==='config'){
            const sub=options.getSubcommand();
            if(sub==='view'){
                await interaction.deferReply(ep());const st=await getState(gid);
                const extra=[];
                if(st.countType==='countdown')extra.push({name:'\u23f3 Cycles',value:`**${st.countdownCycles??0}**`,inline:true});
                if(st.countType==='random'&&st.randomModifierLabel)extra.push({name:'\u{1F3B2} Modifier',value:st.randomModifierLabel,inline:true});
                return interaction.editReply({embeds:[E('#5865F2','Counting Status').addFields(
                    {name:'Channel',value:st.channelId?`<#${st.channelId}>`:'Not set',inline:true},{name:'Current',value:`**${st.current}**`,inline:true},{name:'High',value:`**${st.highScore}**`,inline:true},
                    {name:'Streak',value:`**${st.maxStreak}** in a row`,inline:true},{name:'Expr',value:st.allowExpressions?'Allowed':'Disabled',inline:true},{name:'Mode',value:`${MODE_EMOJI[st.countType??'interactive']} ${MODE_LABEL[st.countType??'interactive']}`,inline:true},
                    {name:'Access',value:st.accessRoleId?`<@&${st.accessRoleId}>`:'Admins only',inline:true},{name:'Saves',value:`**${st.saves??0}**`,inline:true},{name:'Last',value:st.lastUserId?`<@${st.lastUserId}>`:'Nobody yet',inline:true},
                    ...extra,
                )]});
            }
            if(sub==='access'){if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator))return interaction.reply({content:'Admins only.',...ep()});const state=await getState(gid);return interaction.reply({embeds:[E('#5865F2','Access Config').setDescription('Select a role that can use `/config` commands.').addFields({name:'Current role',value:state.accessRoleId?`<@&${state.accessRoleId}>`:'None (admins only)'})],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`access_role_${gid}`).setPlaceholder('Select role').setMinValues(1).setMaxValues(1))],...ep()});}
            if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            if(sub==='counttype'){const state=await getState(gid);return interaction.reply({embeds:[E('#5865F2','Count Type').setDescription('Choose a counting mode:').addFields({name:'\u{1F3AE} Interactive',value:'Wrong numbers reset the count. Streaks, saves, and reactions apply.',inline:true},{name:'\u{1F7E2} Simple',value:'Wrong messages are silently deleted. Count never resets.',inline:true},{name:'\u23f3 Countdown',value:'Count DOWN from 100 to 1. Complete cycles for glory!',inline:true},{name:'\u{1F3B2} Random',value:'Interactive with a random modifier (primes, Fibonacci, etc.) that changes on each reset!',inline:true},{name:'Current mode',value:`**${MODE_EMOJI[state.countType??'interactive']} ${MODE_LABEL[state.countType??'interactive']}**`})],components:[countTypeRow(state.countType??'interactive')],...ep()});}
            await interaction.deferReply(ep());const state=await getState(gid);
            if(sub==='channel'){const ch=options.getChannel('channel');if(!ch.isTextBased())return interaction.editReply({content:'Text channel required.'});state.channelId=ch.id;saveState(gid,state);return interaction.editReply({embeds:[E('#5865F2','Channel set').setDescription(`Counting channel set to ${ch}. Start from **1**!`)]});}
            if(sub==='setcount'){const num=options.getInteger('number'),prev=state.current;if(state.countType!=='countdown'&&num>state.highScore)state.highScore=num;state.current=num;state.lastUserId=null;state.consecutiveCount=0;saveState(gid,state);if(state.channelId){const ch=interaction.guild.channels.cache.get(state.channelId);if(ch)ch.send({embeds:[E('#5865F2','Count set').setDescription(`Count set from **${prev}** to **${num}**. Next: **${state.countType==='countdown'?num-1:num+1}**.`)]}).catch(()=>{});}return interaction.editReply({content:`Count set to **${num}**.`});}
            if(sub==='maxstreak'){state.maxStreak=options.getInteger('amount');saveState(gid,state);return interaction.editReply({embeds:[E('#5865F2','Max streak updated').setDescription(state.maxStreak===1?"Users can't count twice in a row.":`Users can count **${state.maxStreak}** times in a row.`)]});}
            if(sub==='expressions'){state.allowExpressions=options.getBoolean('enabled');saveState(gid,state);return interaction.editReply({embeds:[E('#5865F2',`Expressions ${state.allowExpressions?'enabled':'disabled'}`).setDescription(state.allowExpressions?'Expressions like `1+1`, `pi^2` are now allowed.':'Only plain numbers accepted.')]});}
        }
        if(cmd==='counting'){
            const sub=options.getSubcommand();if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            await interaction.deferReply(ep());const state=await getState(gid);
            if(sub==='reset'){
                const prev=state.current;
                if(state.countType==='countdown'){state.current=state.countdownStart??100;}else if(state.countType==='random'){const mod=pickRandomModifier();state.randomModifier=mod.id;state.randomModifierLabel=mod.label;state.current=0;}else{state.current=0;}
                state.lastUserId=null;state.consecutiveCount=0;saveState(gid,state);
                const resetTo=state.countType==='countdown'?state.countdownStart??100:1;
                if(state.channelId){const ch=interaction.guild.channels.cache.get(state.channelId);const extra=state.countType==='random'?`\nNew modifier: **${state.randomModifierLabel}**`:'';if(ch)ch.send({embeds:[E('#ff9900','\u{1F504} Count reset').setDescription(`Admin reset from **${prev}**. Start again from **${resetTo}**!${extra}`)]}).catch(()=>{});}
                return interaction.editReply({content:`Count reset from **${prev}**.`});
            }
        }
    }catch(error){
        if(error?.code===40060)return;
        console.error('Interaction error:',error);
        try{const m={content:'Something went wrong.',...ep()};if(interaction.deferred)await interaction.editReply(m).catch(()=>{});else if(!interaction.replied)await interaction.reply(m).catch(()=>{});}catch{}
    }
});

process.on('unhandledRejection',e=>console.error(e));
client.on('error',e=>console.error('Discord error:',e));
client.login(process.env.DISCORD_TOKEN);

const PORT=process.env.PORT||3000;
http.createServer((req,res)=>{const ok=req.url==='/'||req.url==='/health';res.writeHead(ok?200:404,{'Content-Type':'text/plain'});res.end(ok?'Counting bot running!':'Not found');}).listen(PORT,()=>console.log(`HTTP on port ${PORT}`));
