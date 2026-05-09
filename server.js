const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TRADOVATE_LIVE = 'https://live.tradovateapi.com/v1';
const TRADOVATE_DEMO = 'https://demo.tradovateapi.com/v1';

const tokenStore = {};

// =====================
// TRADOVATE AUTH
// Try with partner CID/SEC first, fall back to basic auth
// =====================
async function getTradovateToken(username, password, isLive = false) {
  const baseUrl = isLive ? TRADOVATE_LIVE : TRADOVATE_DEMO;
  const cid = parseInt(process.env.TRADOVATE_CID) || 0;
  const sec = process.env.TRADOVATE_SEC || '';

  const body = {
    name: username,
    password: password,
    appId: 'PropTrack',
    appVersion: '1.0.0',
    cid: cid,
    sec: sec
  };

  const response = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data['p-ticket']) throw new Error('MFA_REQUIRED');
  if (data.errorText) throw new Error(data.errorText);
  if (!data.accessToken) throw new Error('Authentication failed — check your Tradovate username and password');

  return {
    accessToken: data.accessToken,
    expirationTime: data.expirationTime,
    userId: data.userId,
    baseUrl,
    username,
    password,
    isLive
  };
}

// =====================
// GET ACCOUNT DATA
// =====================
async function refreshIfNeeded(userId) {
  const tokenData = tokenStore[userId];
  if (!tokenData) throw new Error('Not connected');
  const expiresAt = new Date(tokenData.expirationTime).getTime();
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    const newToken = await getTradovateToken(tokenData.username, tokenData.password, tokenData.isLive);
    tokenStore[userId] = { ...tokenData, ...newToken };
  }
  return tokenStore[userId];
}

async function apiGet(token, baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${path}`);
  return res.json();
}

async function apiPost(token, baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${path}`);
  return res.json();
}

// =====================
// ROUTES
// =====================
app.get('/', (req, res) => {
  res.json({ status: 'PropTrack API running', version: '2.0.0' });
});

// Connect Tradovate account
app.post('/api/tradovate/connect', async (req, res) => {
  const { username, password, isLive = false, userId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const tokenData = await getTradovateToken(username, password, isLive);
    tokenStore[userId] = tokenData;

    // Fetch accounts
    const accounts = await apiGet(tokenData.accessToken, tokenData.baseUrl, '/account/list');

    res.json({
      success: true,
      accounts: (accounts || []).map(acc => ({
        id: acc.id,
        name: acc.name,
        nickname: acc.nickname || acc.name,
        active: acc.active,
        archived: acc.archived
      }))
    });
  } catch (err) {
    if (err.message === 'MFA_REQUIRED') return res.status(200).json({ mfaRequired: true });
    console.error('Connect error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

// Get live account data
app.get('/api/tradovate/account/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const { userId } = req.query;

  try {
    const { accessToken, baseUrl } = await refreshIfNeeded(userId);
    const accId = parseInt(accountId);

    const [balance, positions, fills] = await Promise.all([
      apiPost(accessToken, baseUrl, '/cashbalance/getcashbalancesnapshot', { accountId: accId }),
      apiGet(accessToken, baseUrl, `/position/list?accountId=${accId}`),
      apiGet(accessToken, baseUrl, `/fill/list?accountId=${accId}`)
    ]);

    // Today's P&L from fills
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayFills = (fills || []).filter(f => new Date(f.timestamp) >= today);
    const dailyPnl = todayFills.reduce((s, f) => s + (f.realisedPnl || 0), 0);

    res.json({
      accountId: accId,
      balance: balance.totalCashValue || 0,
      openPnl: balance.openPositionPnl || 0,
      closedPnl: balance.closedPositionPnl || 0,
      totalPnl: (balance.openPositionPnl || 0) + (balance.closedPositionPnl || 0),
      dailyPnl,
      initialBalance: balance.initialCashValue || balance.totalCashValue || 0,
      positions: (positions || []).map(p => ({
        contractId: p.contractId,
        netPos: p.netPos,
        netPrice: p.netPrice,
        openPnl: p.openPnl || 0
      })),
      todayTrades: todayFills.length,
      totalFills: (fills || []).length,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    console.error('Account data error:', err.message);
    res.status(err.message === 'Not connected' ? 401 : 500).json({ error: err.message });
  }
});

// Get trade history
app.get('/api/tradovate/trades/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const { userId, days = 30 } = req.query;

  try {
    const { accessToken, baseUrl } = await refreshIfNeeded(userId);
    const fills = await apiGet(accessToken, baseUrl, `/fill/list?accountId=${parseInt(accountId)}`);
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - parseInt(days));

    const trades = (fills || [])
      .filter(f => new Date(f.timestamp) >= cutoff)
      .map(f => ({
        id: f.id,
        timestamp: f.timestamp,
        contractId: f.contractId,
        action: f.action,
        qty: f.qty,
        price: f.price,
        realisedPnl: f.realisedPnl || 0,
        commission: f.commission || 0
      }))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect
app.post('/api/tradovate/disconnect', (req, res) => {
  delete tokenStore[req.body.userId];
  res.json({ success: true });
});

// Check connection status
app.get('/api/status/:userId', (req, res) => {
  const connected = !!tokenStore[req.params.userId];
  res.json({ connected });
});


// =====================
// BREVO EMAIL SUBSCRIPTION
// =====================
app.post('/api/brevo/subscribe', async (req, res) => {
  const { email, name, listId } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        email,
        attributes: { FIRSTNAME: name || email.split('@')[0], SOURCE: 'app.proptrack.co' },
        listIds: [listId || 5],
        updateEnabled: true
      })
    });

    const data = await response.json();
    console.log('Brevo subscribe:', email, response.status);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Brevo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`PropTrack API v2 running on port ${PORT}`));
