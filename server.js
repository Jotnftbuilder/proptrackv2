const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// MetaApi uses TWO different base URLs:
// 1. Provisioning API - for creating/managing accounts
const METAAPI_PROVISIONING = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
// 2. Client API - for reading account data (balance, trades etc)
const METAAPI_CLIENT = 'https://mt-client-api-v1.london.agiliumtrade.ai';
// CopyFactory
const COPYFACTORY_URL = 'https://copyfactory-api-v1.london.agiliumtrade.ai';

const tradovateTokens = {};

const getToken = () => process.env.METAAPI_TOKEN;

// ===================== HEALTH =====================
app.get('/', (req, res) => {
  res.json({
    status: 'PropTrack API running', version: '3.1.0',
    metaapi: !!getToken(), brevo: !!process.env.BREVO_API_KEY
  });
});

// ===================== BREVO =====================
app.post('/api/brevo/subscribe', async (req, res) => {
  const { email, name, listId } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const r = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        email, attributes: { FIRSTNAME: name || email.split('@')[0], SOURCE: 'app.proptrack.co' },
        listIds: [listId || 5], updateEnabled: true
      })
    });
    const data = await r.json();
    res.json({ success: true, status: r.status, data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== TRADOVATE =====================
async function getTVToken(username, password, isLive) {
  const base = isLive ? 'https://live.tradovateapi.com/v1' : 'https://demo.tradovateapi.com/v1';
  const r = await fetch(`${base}/auth/accesstokenrequest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: username, password, appId: 'PropTrack', appVersion: '1.0.0',
      cid: parseInt(process.env.TRADOVATE_CID) || 0, sec: process.env.TRADOVATE_SEC || '' })
  });
  const data = await r.json();
  if (data['p-ticket']) throw new Error('MFA_REQUIRED');
  if (data.errorText) throw new Error(data.errorText);
  if (!data.accessToken) throw new Error('Authentication failed');
  return { accessToken: data.accessToken, base, username, password, isLive };
}

app.post('/api/tradovate/connect', async (req, res) => {
  const { username, password, isLive = false, userId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
  try {
    const token = await getTVToken(username, password, isLive);
    tradovateTokens[userId] = token;
    const accs = await fetch(`${token.base}/account/list`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` }
    }).then(r => r.json());
    res.json({ success: true, accounts: (accs||[]).map(a => ({ id: a.id, name: a.name, nickname: a.nickname || a.name })) });
  } catch (err) {
    if (err.message === 'MFA_REQUIRED') return res.json({ mfaRequired: true });
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/tradovate/account/:accountId', async (req, res) => {
  const token = tradovateTokens[req.query.userId];
  if (!token) return res.status(401).json({ error: 'Not connected' });
  try {
    const accId = parseInt(req.params.accountId);
    const [balance, fills] = await Promise.all([
      fetch(`${token.base}/cashbalance/getcashbalancesnapshot`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accId })
      }).then(r => r.json()),
      fetch(`${token.base}/fill/list?accountId=${accId}`, {
        headers: { 'Authorization': `Bearer ${token.accessToken}` }
      }).then(r => r.json())
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

// ===================== METAAPI MT4/MT5 =====================
app.post('/api/mt5/connect', async (req, res) => {
  const { login, password, server, platform = 'mt5', userId, firm } = req.body;
  if (!login || !password || !server) return res.status(400).json({ error: 'Login, password and server required' });
  const token = getToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured' });

  try {
    // Create account using correct provisioning API URL
    const createR = await fetch(`${METAAPI_PROVISIONING}/users/current/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({
        login: String(login),
        password: password,
        name: `PropTrack-${String(login)}`,
        server: server,
        platform: platform,
        magic: 0,
        application: 'MetaApi',
        type: 'cloud',
        region: 'london'
      })
    });

    const createData = await createR.json();
    console.log('MetaApi create account response:', createR.status, JSON.stringify(createData).substring(0, 200));

    if (!createR.ok) {
      throw new Error(createData.message || createData.error || `Failed to create account: ${createR.status}`);
    }

    const accountId = createData.id;

    // Deploy the account
    await fetch(`${METAAPI_PROVISIONING}/users/current/accounts/${accountId}/deploy`, {
      method: 'POST', headers: { 'auth-token': token }
    });

    // Wait for connection
    await new Promise(r => setTimeout(r, 8000));

    // Get account info using client API
    const infoR = await fetch(
      `${METAAPI_CLIENT}/users/current/accounts/${accountId}/account-information`,
      { headers: { 'auth-token': token } }
    );
    const info = infoR.ok ? await infoR.json() : {};
    console.log('Account info:', infoR.status, JSON.stringify(info).substring(0, 100));

    res.json({
      success: true, accountId, login, server, platform, firm,
      balance: info.balance || 0, equity: info.equity || 0,
      currency: info.currency || 'USD', broker: info.broker || server,
      name: info.name || `Account ${login}`
    });

  } catch (err) {
    console.error('MT5 connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mt5/account/:id', async (req, res) => {
  const token = getToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured' });
  try {
    const [infoR, posR] = await Promise.all([
      fetch(`${METAAPI_CLIENT}/users/current/accounts/${req.params.id}/account-information`, { headers: { 'auth-token': token } }),
      fetch(`${METAAPI_CLIENT}/users/current/accounts/${req.params.id}/positions`, { headers: { 'auth-token': token } })
    ]);
    const info = infoR.ok ? await infoR.json() : {};
    const positions = posR.ok ? await posR.json() : [];
    res.json({
      balance: info.balance||0, equity: info.equity||0,
      openPnl: (positions||[]).reduce((s,p)=>s+(p.unrealizedProfit||0),0),
      currency: info.currency||'USD', leverage: info.leverage||0,
      positions: (positions||[]).map(p=>({ symbol: p.symbol, type: p.type, volume: p.volume, profit: p.unrealizedProfit||0 })),
      lastUpdated: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mt5/trades/:id', async (req, res) => {
  const token = getToken();
  if (!token) return res.status(500).json({ error: 'MetaApi not configured' });
  try {
    const days = req.query.days || 30;
    const since = new Date(Date.now()-days*86400000).toISOString();
    const now = new Date().toISOString();
    const r = await fetch(
      `${METAAPI_CLIENT}/users/current/accounts/${req.params.id}/history-deals/time/${since}/${now}`,
      { headers: { 'auth-token': token } }
    );
    const deals = r.ok ? await r.json() : [];
    const trades = (deals||[])
      .filter(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT')
      .map(d => ({ id: d.id, time: d.time, symbol: d.symbol,
        type: d.type==='DEAL_TYPE_BUY'?'Buy':'Sell', volume: d.volume, price: d.price, profit: d.profit||0 }))
      .sort((a,b) => new Date(b.time)-new Date(a.time));
    res.json({ trades });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== COPYFACTORY =====================
app.post('/api/copyfactory/setup-master', async (req, res) => {
  const { metaApiAccountId, strategyId } = req.body;
  const token = getToken();
  try {
    const r = await fetch(`${COPYFACTORY_URL}/users/current/configuration/strategies/${strategyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({ name: strategyId, accountId: metaApiAccountId, maxTradeRisk: 0.1 })
    });
    res.json({ success: r.ok, strategyId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/copyfactory/subscribe-slave', async (req, res) => {
  const { slaveMetaApiAccountId, strategyId, ratio = 1.0 } = req.body;
  const token = getToken();
  try {
    const r = await fetch(`${COPYFACTORY_URL}/users/current/configuration/subscribers/${slaveMetaApiAccountId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({ subscriptions: [{ strategyId, multiplier: ratio }] })
    });
    res.json({ success: r.ok });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/copyfactory/unsubscribe', async (req, res) => {
  const { slaveMetaApiAccountId } = req.body;
  const token = getToken();
  try {
    await fetch(`${COPYFACTORY_URL}/users/current/configuration/subscribers/${slaveMetaApiAccountId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'auth-token': token },
      body: JSON.stringify({ subscriptions: [] })
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mt5/disconnect', async (req, res) => {
  const token = getToken();
  try {
    await fetch(`${METAAPI_PROVISIONING}/users/current/accounts/${req.body.metaApiAccountId}/undeploy`, {
      method: 'POST', headers: { 'auth-token': token }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`PropTrack API v3.1 on port ${PORT}`);
  console.log(`MetaApi: ${!!getToken()} | Brevo: ${!!process.env.BREVO_API_KEY}`);
});
