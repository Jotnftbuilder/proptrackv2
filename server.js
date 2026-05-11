const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TRADOVATE_LIVE = 'https://live.tradovateapi.com/v1';
const TRADOVATE_DEMO = 'https://demo.tradovateapi.com/v1';
const METAAPI_URL = 'https://mt-client-api-v1.london.agiliumtrade.ai';
const COPYFACTORY_URL = 'https://copyfactory-api-v1.london.agiliumtrade.ai';

const tradovateTokens = {};
const metaApiAccounts = {};

// ===================== HEALTH =====================
app.get('/', (req, res) => {
  res.json({ status: 'PropTrack API running', version: '3.0.0',
    metaapi: !!process.env.METAAPI_TOKEN, brevo: !!process.env.BREVO_API_KEY });
});

// ===================== BREVO =====================
app.post('/api/brevo/subscribe', async (req, res) => {
  const { email, name, listId } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const r = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({ email, attributes: { FIRSTNAME: name || email.split('@')[0], SOURCE: 'app.proptrack.co' }, listIds: [listId || 5], updateEnabled: true })
    });
    const data = await r.json();
    console.log('Brevo:', email, r.status);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== TRADOVATE =====================
async function getTVToken(username, password, isLive) {
  const baseUrl = isLive ? TRADOVATE_LIVE : TRADOVATE_DEMO;
  const r = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: username, password, appId: 'PropTrack', appVersion: '1.0.0',
      cid: parseInt(process.env.TRADOVATE_CID) || 0, sec: process.env.TRADOVATE_SEC || '' })
  });
  const data = await r.json();
  if (data['p-ticket']) throw new Error('MFA_REQUIRED');
  if (data.errorText) throw new Error(data.errorText);
  if (!data.accessToken) throw new Error('Authentication failed');
  return { accessToken: data.accessToken, expirationTime: data.expirationTime, baseUrl, username, password, isLive };
}

app.post('/api/tradovate/connect', async (req, res) => {
  const { username, password, isLive = false, userId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
  try {
    const token = await getTVToken(username, password, isLive);
    tradovateTokens[userId] = token;
    const accs = await fetch(`${token.baseUrl}/account/list`, { headers: { 'Authorization': `Bearer ${token.accessToken}` } }).then(r => r.json());
    res.json({ success: true, accounts: (accs||[]).map(a => ({ id: a.id, name: a.name, nickname: a.nickname || a.name })) });
  } catch (err) {
    if (err.message === 'MFA_REQUIRED') return res.json({ mfaRequired: true });
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/tradovate/account/:accountId', async (req, res) => {
  const { userId } = req.query;
  const token = tradovateTokens[userId];
  if (!token) return res.status(401).json({ error: 'Not connected' });
  try {
    const accId = parseInt(req.params.accountId);
    const [balance, fills] = await Promise.all([
      fetch(`${token.baseUrl}/cashbalance/getcashbalancesnapshot`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accId })
      }).then(r => r.json()),
      fetch(`${token.baseUrl}/fill/list?accountId=${accId}`, { headers: { 'Authorization': `Bearer ${token.accessToken}` } }).then(r => r.json())
    ]);
    const today = new Date(); today.setHours(0,0,0,0);
    const todayFills = (fills||[]).filter(f => new Date(f.timestamp) >= today);
    res.json({
      accountId: accId, balance: balance.totalCashValue || 0,
      openPnl: balance.openPositionPnl || 0, closedPnl: balance.closedPositionPnl || 0,
      totalPnl: (balance.openPositionPnl||0)+(balance.closedPositionPnl||0),
      dailyPnl: todayFills.reduce((s,f)=>s+(f.realisedPnl||0),0),
      todayTrades: todayFills.length, lastUpdated: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tradovate/disconnect', (req, res) => {
  delete tradovateTokens[req.body.userId];
  res.json({ success: true });
});

// ===================== METAAPI MT4/MT5 =====================
const getMAToken = () => process.env.METAAPI_TOKEN;

app.post('/api/mt5/connect', async (req, res) => {
  const { login, password, server, platform = 'mt5', userId, firm } = req.body;
  if (!login || !password || !server) return res.status(400).json({ error: 'Login, password and server required' });
  const token = getMAToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured — add METAAPI_TOKEN to Render environment variables' });

  try {
    // Create MetaApi account
    const createR = await fetch(`${METAAPI_URL}/users/current/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({
        login: String(login), password, server, platform,
        name: `PropTrack-${userId}-${login}`,
        application: 'MetaApi', magic: 0, type: 'cloud'
      })
    });
    const createData = await createR.json();
    if (!createR.ok) throw new Error(createData.message || 'Failed to connect');

    const accountId = createData.id;

    // Deploy account
    await fetch(`${METAAPI_URL}/users/current/accounts/${accountId}/deploy`, {
      method: 'POST', headers: { 'auth-token': token }
    });

    metaApiAccounts[`${userId}_${login}`] = { accountId, login, server, platform, firm, userId };

    // Wait for connection then get info
    await new Promise(r => setTimeout(r, 5000));
    const infoR = await fetch(`${METAAPI_URL}/users/current/accounts/${accountId}/account-information`, {
      headers: { 'auth-token': token }
    });
    const info = infoR.ok ? await infoR.json() : {};

    res.json({ success: true, accountId, login, server, platform, firm,
      balance: info.balance || 0, equity: info.equity || 0,
      currency: info.currency || 'USD', broker: info.broker || server,
      name: info.name || `Account ${login}` });

  } catch (err) {
    console.error('MT5 connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mt5/account/:metaApiAccountId', async (req, res) => {
  const token = getMAToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured' });
  try {
    const id = req.params.metaApiAccountId;
    const [infoR, posR] = await Promise.all([
      fetch(`${METAAPI_URL}/users/current/accounts/${id}/account-information`, { headers: { 'auth-token': token } }),
      fetch(`${METAAPI_URL}/users/current/accounts/${id}/positions`, { headers: { 'auth-token': token } })
    ]);
    const info = infoR.ok ? await infoR.json() : {};
    const positions = posR.ok ? await posR.json() : [];
    const openPnl = (positions||[]).reduce((s,p) => s+(p.unrealizedProfit||0), 0);
    res.json({ balance: info.balance||0, equity: info.equity||0, margin: info.margin||0,
      freeMargin: info.freeMargin||0, openPnl, currency: info.currency||'USD',
      leverage: info.leverage||0, positions: (positions||[]).map(p=>({
        symbol: p.symbol, type: p.type, volume: p.volume,
        openPrice: p.openPrice, profit: p.unrealizedProfit||0
      })), lastUpdated: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mt5/trades/:metaApiAccountId', async (req, res) => {
  const token = getMAToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured' });
  try {
    const { days = 30 } = req.query;
    const since = new Date(Date.now()-days*86400000).toISOString();
    const now = new Date().toISOString();
    const r = await fetch(`${METAAPI_URL}/users/current/accounts/${req.params.metaApiAccountId}/history-deals/time/${since}/${now}`,
      { headers: { 'auth-token': token } });
    const deals = r.ok ? await r.json() : [];
    const trades = (deals||[])
      .filter(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT')
      .map(d => ({ id: d.id, time: d.time, symbol: d.symbol,
        type: d.type==='DEAL_TYPE_BUY'?'Buy':'Sell',
        volume: d.volume, price: d.price, profit: d.profit||0 }))
      .sort((a,b) => new Date(b.time)-new Date(a.time));
    res.json({ trades });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== COPYFACTORY - TRADE COPYING =====================
app.post('/api/copyfactory/setup-master', async (req, res) => {
  const { metaApiAccountId, strategyId, userId } = req.body;
  const token = getMAToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured' });
  try {
    const r = await fetch(`${COPYFACTORY_URL}/users/current/configuration/strategies/${strategyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({ name: strategyId, description: `PropTrack strategy ${userId}`,
        accountId: metaApiAccountId, maxTradeRisk: 0.1 })
    });
    const data = r.ok ? await r.json() : {};
    res.json({ success: true, strategyId, data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/copyfactory/subscribe-slave', async (req, res) => {
  const { slaveMetaApiAccountId, strategyId, ratio = 1.0, maxDailyRisk = 0.05 } = req.body;
  const token = getMAToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured' });
  try {
    const r = await fetch(`${COPYFACTORY_URL}/users/current/configuration/subscribers/${slaveMetaApiAccountId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({ subscriptions: [{
        strategyId, multiplier: ratio, skipPendingOrders: false,
        riskLimits: [{ type: 'day', applyTo: 'balance', maxRisk: maxDailyRisk }]
      }]})
    });
    const data = r.ok ? await r.json() : {};
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/copyfactory/unsubscribe', async (req, res) => {
  const { slaveMetaApiAccountId } = req.body;
  const token = getMAToken();
  try {
    await fetch(`${COPYFACTORY_URL}/users/current/configuration/subscribers/${slaveMetaApiAccountId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({ subscriptions: [] })
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mt5/disconnect', async (req, res) => {
  const { metaApiAccountId } = req.body;
  const token = getMAToken();
  try {
    await fetch(`${METAAPI_URL}/users/current/accounts/${metaApiAccountId}/undeploy`, {
      method: 'POST', headers: { 'auth-token': token }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`PropTrack API v3 on port ${PORT}`);
  console.log(`MetaApi: ${!!getMAToken()} | Brevo: ${!!process.env.BREVO_API_KEY}`);
});
