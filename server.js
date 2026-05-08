const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Tradovate API endpoints
const TRADOVATE_LIVE = 'https://live.tradovateapi.com/v1';
const TRADOVATE_DEMO = 'https://demo.tradovateapi.com/v1';

// In-memory token store (use Redis in production)
const tokenStore = {};

// =====================
// TRADOVATE AUTH
// =====================
async function getTradovateToken(username, password, isLive = false) {
  const baseUrl = isLive ? TRADOVATE_LIVE : TRADOVATE_DEMO;
  
  const response = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: username,
      password: password,
      appId: 'PropTrack',
      appVersion: '1.0.0',
      cid: process.env.TRADOVATE_CID || 0,
      sec: process.env.TRADOVATE_SEC || ''
    })
  });

  if (!response.ok) {
    throw new Error(`Tradovate auth failed: ${response.status}`);
  }

  const data = await response.json();
  
  if (data['p-ticket']) {
    throw new Error('MFA_REQUIRED');
  }
  
  if (!data.accessToken) {
    throw new Error(data.errorText || 'Authentication failed');
  }

  return {
    accessToken: data.accessToken,
    expirationTime: data.expirationTime,
    userId: data.userId,
    userStatus: data.userStatus,
    baseUrl
  };
}

// =====================
// GET ACCOUNTS
// =====================
async function getTradovateAccounts(accessToken, baseUrl) {
  const response = await fetch(`${baseUrl}/account/list`, {
    headers: { 
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) throw new Error('Failed to fetch accounts');
  return await response.json();
}

// =====================
// GET CASH BALANCE
// =====================
async function getCashBalance(accessToken, baseUrl, accountId) {
  const response = await fetch(`${baseUrl}/cashbalance/getcashbalancesnapshot`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ accountId })
  });

  if (!response.ok) throw new Error('Failed to fetch cash balance');
  return await response.json();
}

// =====================
// GET POSITIONS
// =====================
async function getPositions(accessToken, baseUrl, accountId) {
  const response = await fetch(`${baseUrl}/position/list?accountId=${accountId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) throw new Error('Failed to fetch positions');
  return await response.json();
}

// =====================
// GET TRADES (fills)
// =====================
async function getTrades(accessToken, baseUrl, accountId) {
  const response = await fetch(`${baseUrl}/fill/list?accountId=${accountId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) throw new Error('Failed to fetch trades');
  return await response.json();
}

// =====================
// ROUTES
// =====================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'PropTrack API running', version: '1.0.0' });
});

// Connect Tradovate account
app.post('/api/tradovate/connect', async (req, res) => {
  const { username, password, isLive = false, userId } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const tokenData = await getTradovateToken(username, password, isLive);
    
    // Store token for this user
    tokenStore[userId] = {
      ...tokenData,
      username,
      isLive,
      connectedAt: Date.now()
    };

    // Fetch initial account data
    const accounts = await getTradovateAccounts(tokenData.accessToken, tokenData.baseUrl);
    
    res.json({
      success: true,
      accounts: accounts.map(acc => ({
        id: acc.id,
        name: acc.name,
        nickname: acc.nickname,
        active: acc.active
      }))
    });

  } catch (err) {
    if (err.message === 'MFA_REQUIRED') {
      return res.status(200).json({ mfaRequired: true });
    }
    console.error('Tradovate connect error:', err);
    res.status(401).json({ error: err.message || 'Connection failed' });
  }
});

// Get account data (balance, P&L, drawdown)
app.get('/api/tradovate/account/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const { userId } = req.query;

  const tokenData = tokenStore[userId];
  if (!tokenData) {
    return res.status(401).json({ error: 'Not connected — please reconnect your Tradovate account' });
  }

  try {
    // Refresh token if close to expiry
    const expiresAt = new Date(tokenData.expirationTime).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1000) {
      const newToken = await getTradovateToken(tokenData.username, tokenData.password, tokenData.isLive);
      tokenStore[userId] = { ...tokenData, ...newToken };
    }

    const { accessToken, baseUrl } = tokenStore[userId];
    const accId = parseInt(accountId);

    // Fetch all data in parallel
    const [balance, positions, trades] = await Promise.all([
      getCashBalance(accessToken, baseUrl, accId),
      getPositions(accessToken, baseUrl, accId),
      getTrades(accessToken, baseUrl, accId)
    ]);

    // Calculate daily P&L from today's fills
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTrades = (trades || []).filter(t => {
      const tradeDate = new Date(t.timestamp);
      return tradeDate >= today;
    });

    const dailyPnl = todayTrades.reduce((sum, t) => sum + (t.realisedPnl || 0), 0);

    // Build response
    const accountData = {
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
      todayTrades: todayTrades.length,
      totalTrades: (trades || []).length,
      lastUpdated: new Date().toISOString()
    };

    res.json(accountData);

  } catch (err) {
    console.error('Account data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get trade history
app.get('/api/tradovate/trades/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const { userId, days = 30 } = req.query;

  const tokenData = tokenStore[userId];
  if (!tokenData) {
    return res.status(401).json({ error: 'Not connected' });
  }

  try {
    const { accessToken, baseUrl } = tokenData;
    const trades = await getTrades(accessToken, baseUrl, parseInt(accountId));

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days));

    const filtered = (trades || [])
      .filter(t => new Date(t.timestamp) >= cutoff)
      .map(t => ({
        id: t.id,
        timestamp: t.timestamp,
        contractId: t.contractId,
        action: t.action,
        qty: t.qty,
        price: t.price,
        realisedPnl: t.realisedPnl || 0,
        commission: t.commission || 0
      }))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ trades: filtered });

  } catch (err) {
    console.error('Trades error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect account
app.post('/api/tradovate/disconnect', (req, res) => {
  const { userId } = req.body;
  delete tokenStore[userId];
  res.json({ success: true });
});

// =====================
// MT5 PLACEHOLDER
// =====================
app.post('/api/mt5/connect', async (req, res) => {
  // MT5 doesn't have a direct REST API
  // This would use a bridge like MT5 Web API or a custom EA
  res.json({ 
    message: 'MT5 integration coming soon',
    supportedFirms: ['FTMO', 'MyFundedFX', 'E8 Funding', 'The Funded Trader', 'Pips Alpha Capital']
  });
});

app.listen(PORT, () => {
  console.log(`PropTrack API server running on port ${PORT}`);
});
