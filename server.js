import express     from 'express';
import cors        from 'cors';
import rateLimit   from 'express-rate-limit';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const PORT       = process.env.PORT       || 3000;
const GROQ_KEY   = process.env.GROQ_KEY   || '';
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'change-me';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL      = 'llama-3.1-8b-instant';
const DB_PATH    = './licenses.json';

const PLANS = {
    pro:      { daily: 200,  monthly: 3000  },
    lifetime: { daily: 500,  monthly: 10000 },
    trial:    { daily: 20,   monthly: 100   },
};

// ── DB helpers ────────────────────────────────────────────────────────────────
const readDB  = () => existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH,'utf8')) : { licenses:{} };
const writeDB = d  => writeFileSync(DB_PATH, JSON.stringify(d,null,2));
const getL    = k  => readDB().licenses[k] || null;
const saveL   = (k,v) => { const db=readDB(); db.licenses[k]=v; writeDB(db); };
const today   = ()  => new Date().toISOString().slice(0,10);
const month   = ()  => new Date().toISOString().slice(0,7);

// ── Usage ─────────────────────────────────────────────────────────────────────
function checkUsage(lic) {
    const p = PLANS[lic.plan] || PLANS.trial;
    const d = lic.usage?.[today()] || 0;
    const m = lic.usage?.[month()] || 0;
    if (m >= p.monthly) return { ok:false, reason:`Monthly limit (${p.monthly}) reached` };
    if (d >= p.daily)   return { ok:false, reason:`Daily limit (${p.daily}) reached` };
    return { ok:true, d, m, p };
}

function trackUsage(lic) {
    if (!lic.usage) lic.usage = {};
    lic.usage[today()] = (lic.usage[today()] || 0) + 1;
    lic.usage[month()] = (lic.usage[month()] || 0) + 1;
    // prune old days
    const cut = new Date(); cut.setDate(cut.getDate()-35);
    Object.keys(lic.usage).filter(k=>k.length===10&&new Date(k)<cut).forEach(k=>delete lic.usage[k]);
    return lic;
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit:'50kb' }));
app.use(cors());
app.set('trust proxy', 1);
app.use(rateLimit({ windowMs:60000, max:120, message:{error:'Too many requests'} }));

// Health
app.get('/', (_,res) => res.json({ status:'ok', service:'AISA Proxy v1.0' }));

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post('/v1/chat', async (req,res) => {
    const { license_key, message, history=[], context='' } = req.body;
    if (!license_key || !message) return res.status(400).json({error:'license_key and message required'});

    const lic = getL(license_key);
    if (!lic)                   return res.status(401).json({error:'Invalid license key',    code:'INVALID_LICENSE'});
    if (lic.status!=='active')  return res.status(403).json({error:`License ${lic.status}`, code:'LICENSE_INACTIVE'});
    if (lic.expires_at && new Date(lic.expires_at)<new Date()) {
        lic.status='expired'; saveL(license_key,lic);
        return res.status(403).json({error:'License expired', code:'LICENSE_EXPIRED'});
    }

    const usage = checkUsage(lic);
    if (!usage.ok) return res.status(429).json({error:usage.reason, code:'LIMIT_REACHED'});

    // Build Groq messages
    const msgs = [];
    if (context) msgs.push({role:'system', content:context});
    for (const t of history.slice(-20))
        msgs.push({role: t.role==='assistant'?'assistant':'user', content:String(t.text).slice(0,2000)});
    msgs.push({role:'user', content:String(message).slice(0,2000)});

    try {
        const gr = await fetch(GROQ_URL, {
            method:'POST',
            headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
            body: JSON.stringify({model:MODEL, messages:msgs, max_tokens:800, temperature:0.7}),
        });
        const data = await gr.json();
        if (!gr.ok) return res.status(502).json({error: data?.error?.message||'Groq error'});

        const updated = trackUsage(lic);
        saveL(license_key, updated);

        return res.json({
            reply: data.choices?.[0]?.message?.content || '',
            usage: {
                daily_used:    updated.usage[today()],
                daily_limit:   PLANS[lic.plan]?.daily,
                monthly_used:  updated.usage[month()],
                monthly_limit: PLANS[lic.plan]?.monthly,
            }
        });
    } catch(e) {
        return res.status(500).json({error:'Server error'});
    }
});

// ── TEMP: Create first license without auth (remove after use) ───────────────
app.get('/setup', (req,res) => {
    const raw = `setup:siihab.com:${Date.now()}:${Math.random()}`;
    const key = 'AISA-' + createHash('sha256').update(raw).digest('hex').toUpperCase().slice(0,24);
    const lic = {
        key, plan:'lifetime', status:'active',
        site_url:'https://siihab.com',
        customer_email:'hassaanmohamed333@gmail.com',
        created_at: new Date().toISOString(),
        expires_at: null, usage:{}
    };
    saveL(key, lic);
    return res.json({ license_key: key, plan:'lifetime', status:'active' });
});

// ── Admin: create license ─────────────────────────────────────────────────────
app.post('/admin/license/create', (req,res) => {
    if (req.headers['x-admin-key']!==ADMIN_KEY) return res.status(401).json({error:'Unauthorized'});
    const { plan='pro', site_url, customer_email, expires_months } = req.body;
    if (!site_url||!customer_email) return res.status(400).json({error:'site_url and customer_email required'});

    const raw = `${customer_email}:${site_url}:${Date.now()}:${Math.random()}`;
    const key = 'AISA-' + createHash('sha256').update(raw).digest('hex').toUpperCase().slice(0,24);
    const expires_at = expires_months
        ? new Date(Date.now()+expires_months*30*86400000).toISOString() : null;

    const lic = { key, plan, status:'active', site_url, customer_email,
                  created_at:new Date().toISOString(), expires_at, usage:{} };
    saveL(key, lic);
    return res.json({ success:true, license_key:key, plan, expires_at });
});

// ── Admin: list ───────────────────────────────────────────────────────────────
app.get('/admin/licenses', (req,res) => {
    if (req.headers['x-admin-key']!==ADMIN_KEY) return res.status(401).json({error:'Unauthorized'});
    const list = Object.values(readDB().licenses).map(l=>({
        key:l.key, plan:l.plan, status:l.status,
        site:l.site_url, email:l.customer_email,
        today: l.usage?.[today()]||0,
        month: l.usage?.[month()]||0,
        expires:l.expires_at,
    }));
    return res.json({ total:list.length, licenses:list });
});

// ── Admin: revoke ─────────────────────────────────────────────────────────────
app.post('/admin/license/revoke', (req,res) => {
    if (req.headers['x-admin-key']!==ADMIN_KEY) return res.status(401).json({error:'Unauthorized'});
    const lic = getL(req.body.key);
    if (!lic) return res.status(404).json({error:'Not found'});
    lic.status='revoked'; saveL(req.body.key,lic);
    return res.json({success:true});
});

app.listen(PORT, ()=>console.log(`✅ AISA Proxy on port ${PORT}`));
