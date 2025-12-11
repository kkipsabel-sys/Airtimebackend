require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// PostgreSQL connection to Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err.stack);
  } else {
    console.log('Connected to Railway PostgreSQL database');
    release();
  }
});

// PayNecta Configuration
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
const PAYNECTA_BASE_URL = 'https://paynecta.co.ke/api/v1';

// Statum Configuration
const STATUM_CONSUMER_KEY = process.env.STATUM_CONSUMER_KEY;
const STATUM_CONSUMER_SECRET = process.env.STATUM_CONSUMER_SECRET;
const STATUM_BASE_URL = 'https://api.statum.co.ke/api/v2';

// Admin password - MUST be set in environment variables
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD not set. Admin dashboard will be inaccessible.');
}

// JWT Secret - MUST be set in environment variables
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set. Using temporary secret for development.');
}

// Callback URL
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://callbackurl.onrender.com';

// ============== HELPER FUNCTIONS ==============

// Calculate bonus for deposits
function calculateBonus(amount) {
  if (amount >= 50) {
    return 6;
  }
  return 0;
}

// Calculate airtime discount (user gets 90% of what they pay)
function calculateAirtimeAmount(amount) {
  return Math.floor(amount * 0.9);
}

// PayNecta STK Push
async function initiatePaynectaStkPush(phoneNumber, amount, reference) {
  try {
    const response = await axios.post(`${PAYNECTA_BASE_URL}/payments/initialize`, {
      phone_number: phoneNumber,
      amount: amount,
      reference: reference,
      callback_url: `${CALLBACK_URL}/api/paynecta/callback`
    }, {
      headers: {
        'X-API-Key': PAYNECTA_API_KEY,
        'X-User-Email': PAYNECTA_EMAIL,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('PayNecta STK Push Error:', error.response?.data || error.message);
    throw error;
  }
}

// Query PayNecta payment status
async function queryPaynectaPaymentStatus(reference) {
  try {
    const response = await axios.get(`${PAYNECTA_BASE_URL}/payments/query/${reference}`, {
      headers: {
        'X-API-Key': PAYNECTA_API_KEY,
        'X-User-Email': PAYNECTA_EMAIL
      }
    });
    return response.data;
  } catch (error) {
    console.error('PayNecta Query Error:', error.response?.data || error.message);
    throw error;
  }
}

// Statum Airtime Purchase
async function purchaseAirtime(phoneNumber, amount) {
  try {
    const auth = Buffer.from(`${STATUM_CONSUMER_KEY}:${STATUM_CONSUMER_SECRET}`).toString('base64');
    const response = await axios.post(`${STATUM_BASE_URL}/airtime`, {
      phone_number: phoneNumber,
      amount: amount.toString()
    }, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Statum Airtime Error:', error.response?.data || error.message);
    throw error;
  }
}

// Check Statum float balance - Note: Statum doesn't provide a public balance API
// Float status should be managed manually by admin
let statumFloatAvailable = true; // Default to available

async function checkStatumFloat() {
  // Return current float status (managed by admin)
  return { available: statumFloatAvailable, message: statumFloatAvailable ? 'Float available' : 'Float low - please try again later' };
}

// Admin can toggle float status
function setStatumFloatStatus(available) {
  statumFloatAvailable = available;
}

// ============== USER ROUTES ==============

// Register user
app.post('/api/users/register', async (req, res) => {
  try {
    const { username, email, phone_number, firebase_uid } = req.body;

    // Check if username already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Username already taken' });
    }

    // Check if email already exists
    const existingEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingEmail.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    // Insert new user
    const result = await pool.query(
      `INSERT INTO users (username, email, phone_number, firebase_uid, balance, created_at, is_active) 
       VALUES ($1, $2, $3, $4, 0, NOW(), true) RETURNING *`,
      [username, email, phone_number, firebase_uid]
    );

    // Create welcome notification
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, created_at, is_read) 
       VALUES ($1, $2, $3, $4, NOW(), false)`,
      [result.rows[0].id, 'Welcome to Airtime Solution Kenya! 🇰🇪', 'Thank you for joining us. Start by depositing funds to buy airtime.', 'welcome']
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get user by email
app.get('/api/users/email/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get user by username
app.get('/api/users/username/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get user balance
app.get('/api/users/:username/balance', async (req, res) => {
  try {
    const { username } = req.params;
    const result = await pool.query('SELECT balance, username FROM users WHERE username = $1', [username]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, balance: result.rows[0].balance, username: result.rows[0].username });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update user profile
app.put('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { phone_number, language } = req.body;

    const result = await pool.query(
      'UPDATE users SET phone_number = COALESCE($1, phone_number), language = COALESCE($2, language), updated_at = NOW() WHERE username = $3 RETURNING *',
      [phone_number, language, username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============== DEPOSIT ROUTES ==============

// Initiate deposit via PayNecta STK Push
app.post('/api/deposit/stk', async (req, res) => {
  try {
    const { username, phone_number, amount } = req.body;

    if (amount < 10) {
      return res.status(400).json({ success: false, message: 'Minimum deposit is KES 10' });
    }

    // Get user
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userResult.rows[0];
    const reference = `DEP-${uuidv4().substring(0, 8).toUpperCase()}`;
    const bonus = calculateBonus(amount);

    // Create pending transaction
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, phone_number, reference, status, bonus, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [user.id, 'deposit', amount, phone_number, reference, 'pending', bonus]
    );

    // Initiate STK Push
    const stkResponse = await initiatePaynectaStkPush(phone_number, amount, reference);

    res.json({ 
      success: true, 
      message: 'STK Push sent to your phone', 
      reference,
      bonus,
      paynecta_response: stkResponse 
    });
  } catch (error) {
    console.error('Deposit STK error:', error);
    res.status(500).json({ success: false, message: 'Failed to initiate deposit' });
  }
});

// PayNecta callback
app.post('/api/paynecta/callback', async (req, res) => {
  try {
    const { reference, status, mpesa_receipt, amount } = req.body;
    console.log('PayNecta Callback:', req.body);

    if (status === 'success' || status === 'completed') {
      // Get transaction
      const txResult = await pool.query('SELECT * FROM transactions WHERE reference = $1', [reference]);
      if (txResult.rows.length > 0) {
        const tx = txResult.rows[0];
        const bonus = tx.bonus || 0;
        const totalAmount = parseFloat(tx.amount) + bonus;

        // Update transaction status
        await pool.query(
          'UPDATE transactions SET status = $1, mpesa_receipt = $2, completed_at = NOW() WHERE reference = $3',
          ['completed', mpesa_receipt, reference]
        );

        // Update user balance
        await pool.query(
          'UPDATE users SET balance = balance + $1 WHERE id = $2',
          [totalAmount, tx.user_id]
        );

        // Create notification
        await pool.query(
          `INSERT INTO notifications (user_id, title, message, type, created_at, is_read) 
           VALUES ($1, $2, $3, $4, NOW(), false)`,
          [tx.user_id, 'Deposit Successful! 💰', `KES ${tx.amount} has been added to your account${bonus > 0 ? ` with +${bonus} bonus!` : ''}`, 'deposit']
        );
      }
    } else {
      // Update transaction as failed
      await pool.query(
        'UPDATE transactions SET status = $1, completed_at = NOW() WHERE reference = $2',
        ['failed', reference]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).json({ success: false });
  }
});

// Verify deposit by M-Pesa code
app.post('/api/deposit/verify', async (req, res) => {
  try {
    const { username, mpesa_code } = req.body;

    // Get user
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userResult.rows[0];

    // Check if already processed
    const existingTx = await pool.query(
      'SELECT * FROM transactions WHERE mpesa_receipt = $1 AND status = $2',
      [mpesa_code, 'completed']
    );

    if (existingTx.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'This M-Pesa code has already been used' });
    }

    // Check pending transactions
    const pendingTx = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
      [user.id, 'pending']
    );

    if (pendingTx.rows.length > 0) {
      const tx = pendingTx.rows[0];
      const bonus = tx.bonus || 0;
      const totalAmount = parseFloat(tx.amount) + bonus;

      // Update transaction
      await pool.query(
        'UPDATE transactions SET status = $1, mpesa_receipt = $2, completed_at = NOW() WHERE id = $3',
        ['completed', mpesa_code, tx.id]
      );

      // Update balance
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [totalAmount, user.id]
      );

      return res.json({ 
        success: true, 
        message: `Deposit verified! KES ${tx.amount} + ${bonus} bonus added to your account.` 
      });
    }

    res.status(404).json({ success: false, message: 'No pending deposit found' });
  } catch (error) {
    console.error('Verify deposit error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// Query deposit status
app.get('/api/deposit/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const result = await pool.query('SELECT * FROM transactions WHERE reference = $1', [reference]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    res.json({ success: true, transaction: result.rows[0] });
  } catch (error) {
    console.error('Query status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============== AIRTIME ROUTES ==============

// Check Statum float
app.get('/api/airtime/float', async (req, res) => {
  try {
    const floatData = await checkStatumFloat();
    res.json({ success: true, float: floatData });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to check float' });
  }
});

// Buy airtime using balance
app.post('/api/airtime/buy', async (req, res) => {
  try {
    const { username, phone_number, amount } = req.body;

    if (amount < 5) {
      return res.status(400).json({ success: false, message: 'Minimum airtime purchase is KES 5' });
    }

    // Get user
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userResult.rows[0];

    // Check balance
    if (parseFloat(user.balance) < amount) {
      // Store pending purchase request
      await pool.query(
        `INSERT INTO pending_purchases (user_id, phone_number, amount, type, created_at) 
         VALUES ($1, $2, $3, $4, NOW())`,
        [user.id, phone_number, amount, 'airtime']
      );

      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient balance',
        balance: user.balance,
        required: amount,
        shortfall: amount - parseFloat(user.balance)
      });
    }

    // Calculate actual airtime to send (user gets 90%)
    const airtimeAmount = calculateAirtimeAmount(amount);
    const reference = `AIR-${uuidv4().substring(0, 8).toUpperCase()}`;

    // Deduct from balance
    await pool.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2',
      [amount, user.id]
    );

    // Create transaction
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, phone_number, reference, status, airtime_sent, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [user.id, 'airtime', amount, phone_number, reference, 'processing', airtimeAmount]
    );

    // Send airtime via Statum
    try {
      const airtimeResponse = await purchaseAirtime(phone_number, airtimeAmount);
      
      // Update transaction
      await pool.query(
        'UPDATE transactions SET status = $1, statum_request_id = $2, completed_at = NOW() WHERE reference = $3',
        ['completed', airtimeResponse.request_id, reference]
      );

      // Create notification
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type, created_at, is_read) 
         VALUES ($1, $2, $3, $4, NOW(), false)`,
        [user.id, 'Airtime Sent! 📱', `KES ${airtimeAmount} airtime sent to ${phone_number}`, 'airtime']
      );

      res.json({ 
        success: true, 
        message: `KES ${airtimeAmount} airtime sent to ${phone_number}`,
        reference,
        airtime_sent: airtimeAmount
      });
    } catch (airtimeError) {
      // Refund on failure
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [amount, user.id]
      );
      await pool.query(
        'UPDATE transactions SET status = $1 WHERE reference = $2',
        ['failed', reference]
      );

      res.status(500).json({ success: false, message: 'Airtime purchase failed. Amount refunded.' });
    }
  } catch (error) {
    console.error('Buy airtime error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Direct airtime purchase (with STK push)
app.post('/api/airtime/direct', async (req, res) => {
  try {
    const { phone_to_receive, phone_to_pay, amount } = req.body;

    if (amount < 5) {
      return res.status(400).json({ success: false, message: 'Minimum airtime purchase is KES 5' });
    }

    const reference = `DAIR-${uuidv4().substring(0, 8).toUpperCase()}`;
    const airtimeAmount = calculateAirtimeAmount(amount);

    // Create transaction
    await pool.query(
      `INSERT INTO transactions (type, amount, phone_number, reference, status, airtime_sent, recipient_phone, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      ['direct_airtime', amount, phone_to_pay, reference, 'pending', airtimeAmount, phone_to_receive]
    );

    // Initiate STK Push
    const stkResponse = await initiatePaynectaStkPush(phone_to_pay, amount, reference);

    res.json({ 
      success: true, 
      message: 'STK Push sent. Complete payment to receive airtime.',
      reference,
      airtime_to_receive: airtimeAmount
    });
  } catch (error) {
    console.error('Direct airtime error:', error);
    res.status(500).json({ success: false, message: 'Failed to initiate purchase' });
  }
});

// ============== AIRTIME TO CASH ROUTES ==============

// Initiate airtime to cash conversion
app.post('/api/airtime-to-cash/initiate', async (req, res) => {
  try {
    const { username, amount, phone_number } = req.body;

    // Get user
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userResult.rows[0];
    const cashback = Math.floor(amount * 0.8); // 80% cashback
    const reference = `A2C-${uuidv4().substring(0, 8).toUpperCase()}`;

    // Create pending conversion
    await pool.query(
      `INSERT INTO airtime_conversions (user_id, amount, cashback_amount, phone_number, reference, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [user.id, amount, cashback, phone_number, reference, 'pending']
    );

    res.json({ 
      success: true, 
      message: 'Airtime conversion initiated',
      reference,
      amount,
      cashback,
      dial_code: `*140*${amount}*0718369524#`,
      whatsapp_number: '+254718369524'
    });
  } catch (error) {
    console.error('Airtime to cash error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Verify airtime conversion
app.post('/api/airtime-to-cash/verify', async (req, res) => {
  try {
    const { reference, verification_code, phone_number } = req.body;

    // Update conversion status
    await pool.query(
      'UPDATE airtime_conversions SET status = $1, verification_code = $2, verified_at = NOW() WHERE reference = $3',
      ['pending_verification', verification_code, reference]
    );

    res.json({ 
      success: true, 
      message: 'Verification submitted. You will receive your cashback within 24 hours.',
      whatsapp_link: `https://wa.me/254718369524?text=Verification%20for%20${reference}:%20${verification_code}%20from%20${phone_number}`
    });
  } catch (error) {
    console.error('Verify conversion error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ============== TRANSACTION ROUTES ==============

// Get user transactions
app.get('/api/transactions/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userId = userResult.rows[0].id;
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json({ success: true, transactions: result.rows });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Download transactions as PDF
app.get('/api/transactions/:username/pdf', async (req, res) => {
  try {
    const { username } = req.params;
    
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userResult.rows[0];
    const txResult = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
      [user.id]
    );

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=transactions-${username}.pdf`);
    doc.pipe(res);

    // Header
    doc.fontSize(20).text('Airtime Solution Kenya 🇰🇪', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Transaction History for ${username}`, { align: 'center' });
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    // Table headers
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Date', 50, doc.y, { continued: true, width: 100 });
    doc.text('Type', 150, doc.y, { continued: true, width: 80 });
    doc.text('Amount', 230, doc.y, { continued: true, width: 60 });
    doc.text('Phone', 290, doc.y, { continued: true, width: 100 });
    doc.text('Status', 390, doc.y, { continued: true, width: 80 });
    doc.text('Reference', 470, doc.y);
    doc.moveDown();

    doc.font('Helvetica');
    txResult.rows.forEach(tx => {
      const date = new Date(tx.created_at).toLocaleDateString();
      doc.text(date, 50, doc.y, { continued: true, width: 100 });
      doc.text(tx.type, 150, doc.y, { continued: true, width: 80 });
      doc.text(`KES ${tx.amount}`, 230, doc.y, { continued: true, width: 60 });
      doc.text(tx.phone_number || '-', 290, doc.y, { continued: true, width: 100 });
      doc.text(tx.status, 390, doc.y, { continued: true, width: 80 });
      doc.text(tx.reference || '-', 470, doc.y);
      doc.moveDown(0.5);
    });

    doc.end();
  } catch (error) {
    console.error('Generate PDF error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
});

// ============== NOTIFICATION ROUTES ==============

// Get user notifications
app.get('/api/notifications/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userId = userResult.rows[0].id;
    const result = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId]
    );

    res.json({ success: true, notifications: result.rows });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Mark notification as read
app.put('/api/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE notifications SET is_read = true WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ success: false });
  }
});

// ============== ADMIN ROUTES ==============

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

// Admin middleware
const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Get all users (admin)
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Admin get users error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update user status (admin)
app.put('/api/admin/users/:id/status', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [is_active, id]);
    res.json({ success: true, message: `User ${is_active ? 'activated' : 'deactivated'}` });
  } catch (error) {
    console.error('Admin update status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update user balance (admin)
app.put('/api/admin/users/:id/balance', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { balance } = req.body;

    await pool.query('UPDATE users SET balance = $1 WHERE id = $2', [balance, id]);
    res.json({ success: true, message: 'Balance updated' });
  } catch (error) {
    console.error('Admin update balance error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all transactions (admin)
app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, u.username, u.email 
      FROM transactions t 
      LEFT JOIN users u ON t.user_id = u.id 
      ORDER BY t.created_at DESC
    `);
    res.json({ success: true, transactions: result.rows });
  } catch (error) {
    console.error('Admin get transactions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get dashboard stats (admin)
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await pool.query('SELECT COUNT(*) as count FROM users');
    const activeUsers = await pool.query('SELECT COUNT(*) as count FROM users WHERE is_active = true');
    const totalDeposits = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'deposit' AND status = 'completed'");
    const totalAirtime = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'airtime' AND status = 'completed'");
    const todayTransactions = await pool.query("SELECT COUNT(*) as count FROM transactions WHERE DATE(created_at) = CURRENT_DATE");

    res.json({
      success: true,
      stats: {
        total_users: parseInt(totalUsers.rows[0].count),
        active_users: parseInt(activeUsers.rows[0].count),
        total_deposits: parseFloat(totalDeposits.rows[0].total),
        total_airtime: parseFloat(totalAirtime.rows[0].total),
        today_transactions: parseInt(todayTransactions.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Send notification to user (admin)
app.post('/api/admin/notifications', adminAuth, async (req, res) => {
  try {
    const { user_id, title, message } = req.body;

    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, created_at, is_read) 
       VALUES ($1, $2, $3, $4, NOW(), false)`,
      [user_id, title, message, 'admin']
    );

    res.json({ success: true, message: 'Notification sent' });
  } catch (error) {
    console.error('Admin notification error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Send notification to all users (admin)
app.post('/api/admin/notifications/broadcast', adminAuth, async (req, res) => {
  try {
    const { title, message } = req.body;

    const users = await pool.query('SELECT id FROM users');
    for (const user of users.rows) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type, created_at, is_read) 
         VALUES ($1, $2, $3, $4, NOW(), false)`,
        [user.id, title, message, 'admin']
      );
    }

    res.json({ success: true, message: `Notification sent to ${users.rows.length} users` });
  } catch (error) {
    console.error('Admin broadcast error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get airtime conversions (admin)
app.get('/api/admin/conversions', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ac.*, u.username, u.email 
      FROM airtime_conversions ac 
      LEFT JOIN users u ON ac.user_id = u.id 
      ORDER BY ac.created_at DESC
    `);
    res.json({ success: true, conversions: result.rows });
  } catch (error) {
    console.error('Admin get conversions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update conversion status (admin)
app.put('/api/admin/conversions/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await pool.query('UPDATE airtime_conversions SET status = $1, completed_at = NOW() WHERE id = $2', [status, id]);
    res.json({ success: true, message: 'Conversion updated' });
  } catch (error) {
    console.error('Admin update conversion error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============== STATUM CALLBACK ==============

app.post('/api/statum/callback', async (req, res) => {
  try {
    console.log('Statum Callback:', req.body);
    const { request_id, result_code, result_desc } = req.body;

    if (result_code === '200') {
      await pool.query(
        'UPDATE transactions SET status = $1 WHERE statum_request_id = $2',
        ['completed', request_id]
      );
    } else {
      await pool.query(
        'UPDATE transactions SET status = $1 WHERE statum_request_id = $2',
        ['failed', request_id]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Statum callback error:', error);
    res.status(500).json({ success: false });
  }
});

// ============== HEALTH CHECK ==============

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Airtime Solution Kenya API is running 🇰🇪' });
});

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🇰🇪 Airtime Solution Kenya server running on port ${PORT}`);
});
