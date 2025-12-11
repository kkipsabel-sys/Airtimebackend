const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || 'https://airtimefrontend.onrender.com',
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL Connection (Railway)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('Database connection error:', err.stack);
    } else {
        console.log('Connected to Railway PostgreSQL');
        release();
    }
});

// Admin password from environment
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '3462Abel@#';

// PayNecta Configuration
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
const PAYNECTA_BASE_URL = 'https://paynecta.co.ke/api/v1';

// Statum Configuration
const STATUM_CONSUMER_KEY = process.env.STATUM_CONSUMER_KEY;
const STATUM_CONSUMER_SECRET = process.env.STATUM_CONSUMER_SECRET;
const STATUM_BASE_URL = 'https://api.statum.co.ke/api/v2';

// Callback URL
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://callbackurl.onrender.com';

// ==================== HELPER FUNCTIONS ====================

async function getSystemSetting(key) {
    const result = await pool.query(
        'SELECT setting_value FROM system_settings WHERE setting_key = $1',
        [key]
    );
    return result.rows[0]?.setting_value || null;
}

async function updateSystemSetting(key, value) {
    await pool.query(
        'UPDATE system_settings SET setting_value = $1, updated_at = NOW() WHERE setting_key = $2',
        [value, key]
    );
}

function formatPhoneNumber(phone) {
    // Convert to 254 format
    phone = phone.replace(/\s+/g, '').replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) {
        phone = '254' + phone.substring(1);
    } else if (phone.startsWith('+254')) {
        phone = phone.substring(1);
    } else if (!phone.startsWith('254')) {
        phone = '254' + phone;
    }
    return phone;
}

// ==================== USER ROUTES ====================

// Register user (from Firebase auth)
app.post('/api/users/register', async (req, res) => {
    try {
        const { firebase_uid, username, email, phone } = req.body;
        
        // Check if username exists
        const usernameCheck = await pool.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
        );
        
        if (usernameCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Username already taken' });
        }
        
        // Check if email exists
        const emailCheck = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        
        if (emailCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Email already registered' });
        }
        
        // Create user
        const formattedPhone = formatPhoneNumber(phone);
        const result = await pool.query(
            `INSERT INTO users (firebase_uid, username, email, phone, balance, bonus_balance, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 0.00, 0.00, 'active', NOW(), NOW())
             RETURNING id, username, email, phone, balance, status, created_at`,
            [firebase_uid, username, email, formattedPhone]
        );
        
        // Create welcome notification
        await pool.query(
            `INSERT INTO admin_notifications (user_id, title, message, level, created_at)
             VALUES ($1, 'Welcome!', 'Welcome to Airtime Platform! Start by depositing to your account.', 'success', NOW())`,
            [result.rows[0].id]
        );
        
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

// Get user by Firebase UID
app.get('/api/users/firebase/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        const result = await pool.query(
            `SELECT id, username, email, phone, balance, bonus_balance, status, language, theme, last_login_at, created_at 
             FROM users WHERE firebase_uid = $1`,
            [uid]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        // Update last login
        await pool.query(
            'UPDATE users SET last_login_at = NOW() WHERE firebase_uid = $1',
            [uid]
        );
        
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, message: 'Failed to get user' });
    }
});

// Get user by username (for balance refresh)
app.get('/api/users/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const result = await pool.query(
            `SELECT id, username, email, phone, balance, bonus_balance, status, language, theme 
             FROM users WHERE username = $1`,
            [username]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, message: 'Failed to get user' });
    }
});

// Check if email has username
app.get('/api/users/check-email/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const result = await pool.query(
            'SELECT username FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.json({ success: false, exists: false });
        }
        
        res.json({ success: true, exists: true, username: result.rows[0].username });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Check failed' });
    }
});

// Update user settings
app.put('/api/users/:username/settings', async (req, res) => {
    try {
        const { username } = req.params;
        const { language, theme } = req.body;
        
        await pool.query(
            'UPDATE users SET language = COALESCE($1, language), theme = COALESCE($2, theme), updated_at = NOW() WHERE username = $3',
            [language, theme, username]
        );
        
        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update settings' });
    }
});

// Get user notifications
app.get('/api/users/:username/notifications', async (req, res) => {
    try {
        const { username } = req.params;
        
        const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // Get user notifications and global notifications
        const result = await pool.query(
            `SELECT * FROM admin_notifications 
             WHERE user_id = $1 OR is_global = true 
             ORDER BY created_at DESC LIMIT 50`,
            [userId]
        );
        
        res.json({ success: true, notifications: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get notifications' });
    }
});

// Mark notification as read
app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('UPDATE admin_notifications SET is_read = true WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to mark as read' });
    }
});

// ==================== PAYNECTA PAYMENT ROUTES ====================

// Initialize STK Push deposit
app.post('/api/payments/deposit', async (req, res) => {
    try {
        const { username, phone, amount } = req.body;
        
        if (amount < 10) {
            return res.status(400).json({ success: false, message: 'Minimum deposit is KES 10' });
        }
        
        const formattedPhone = formatPhoneNumber(phone);
        
        // Get user
        const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // Create pending transaction
        const txResult = await pool.query(
            `INSERT INTO transactions (user_id, type, amount, status, provider, phone_number, description, created_at)
             VALUES ($1, 'deposit', $2, 'pending', 'paynecta', $3, 'M-Pesa STK Push Deposit', NOW())
             RETURNING id`,
            [userId, amount, formattedPhone]
        );
        
        const transactionId = txResult.rows[0].id;
        
        // Call PayNecta API for STK Push
        const response = await fetch(`${PAYNECTA_BASE_URL}/payments/initialize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': PAYNECTA_API_KEY,
                'X-User-Email': PAYNECTA_EMAIL
            },
            body: JSON.stringify({
                phone: formattedPhone,
                amount: parseFloat(amount),
                reference: `DEP-${transactionId}`,
                callback_url: `${CALLBACK_URL}/api/callbacks/paynecta`
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Update transaction with provider reference
            await pool.query(
                'UPDATE transactions SET provider_reference = $1, metadata = $2 WHERE id = $3',
                [data.data?.checkout_request_id || data.reference, JSON.stringify(data), transactionId]
            );
            
            res.json({ 
                success: true, 
                message: 'STK Push sent to your phone', 
                transactionId,
                reference: data.data?.checkout_request_id 
            });
        } else {
            // Update transaction as failed
            await pool.query(
                'UPDATE transactions SET status = $1, metadata = $2 WHERE id = $3',
                ['failed', JSON.stringify(data), transactionId]
            );
            
            res.status(400).json({ success: false, message: data.message || 'Payment initialization failed' });
        }
    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ success: false, message: 'Deposit failed' });
    }
});

// Query payment status
app.get('/api/payments/status/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
        
        const response = await fetch(`${PAYNECTA_BASE_URL}/payments/query/${reference}`, {
            method: 'GET',
            headers: {
                'X-API-Key': PAYNECTA_API_KEY,
                'X-User-Email': PAYNECTA_EMAIL
            }
        });
        
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Status check failed' });
    }
});

// PayNecta callback
app.post('/api/callbacks/paynecta', async (req, res) => {
    try {
        console.log('PayNecta Callback:', JSON.stringify(req.body));
        
        const { reference, status, mpesa_code, amount } = req.body;
        
        // Find transaction by reference
        const txResult = await pool.query(
            `SELECT t.*, u.id as user_id, u.username 
             FROM transactions t 
             JOIN users u ON t.user_id = u.id 
             WHERE t.provider_reference = $1 OR t.id::text LIKE $2`,
            [reference, `%${reference.replace('DEP-', '')}%`]
        );
        
        if (txResult.rows.length === 0) {
            return res.json({ success: false, message: 'Transaction not found' });
        }
        
        const tx = txResult.rows[0];
        
        if (status === 'success' || status === 'completed') {
            // Calculate bonus (if deposit >= 50, add 6)
            const depositAmount = parseFloat(amount || tx.amount);
            const bonusThreshold = parseFloat(await getSystemSetting('deposit_bonus_threshold') || '50');
            const bonusAmount = parseFloat(await getSystemSetting('deposit_bonus_amount') || '6');
            const bonus = depositAmount >= bonusThreshold ? bonusAmount : 0;
            
            // Update transaction
            await pool.query(
                `UPDATE transactions SET status = 'success', mpesa_code = $1, bonus = $2, 
                 metadata = metadata || $3::jsonb WHERE id = $4`,
                [mpesa_code, bonus, JSON.stringify(req.body), tx.id]
            );
            
            // Update user balance
            const totalCredit = depositAmount + bonus;
            await pool.query(
                'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
                [totalCredit, tx.user_id]
            );
            
            // Check for pending purchases
            const pendingResult = await pool.query(
                `SELECT * FROM pending_purchases WHERE user_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
                [tx.user_id]
            );
            
            if (pendingResult.rows.length > 0) {
                const pending = pendingResult.rows[0];
                // Auto-complete pending purchase
                await processPendingPurchase(tx.user_id, pending.id);
            }
            
            // Create success notification
            await pool.query(
                `INSERT INTO admin_notifications (user_id, title, message, level, created_at)
                 VALUES ($1, 'Deposit Successful', $2, 'success', NOW())`,
                [tx.user_id, `KES ${depositAmount}${bonus > 0 ? ' + ' + bonus + ' bonus' : ''} credited to your account!`]
            );
        } else {
            // Update as failed
            await pool.query(
                `UPDATE transactions SET status = 'failed', metadata = metadata || $1::jsonb WHERE id = $2`,
                [JSON.stringify(req.body), tx.id]
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Callback error:', error);
        res.status(500).json({ success: false, message: 'Callback processing failed' });
    }
});

// ==================== STATUM AIRTIME ROUTES ====================

// Check Statum float balance
app.get('/api/airtime/float-status', async (req, res) => {
    try {
        const minFloat = parseFloat(await getSystemSetting('statum_float_minimum') || '100');
        // In production, you would call Statum API to check actual balance
        // For now, we'll return a status based on settings
        res.json({ 
            success: true, 
            sufficient: true, // This would be checked against actual Statum balance
            minimumRequired: minFloat 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to check float status' });
    }
});

// Buy airtime using balance
app.post('/api/airtime/buy', async (req, res) => {
    try {
        const { username, target_phone, amount } = req.body;
        
        if (amount < 5) {
            return res.status(400).json({ success: false, message: 'Minimum airtime is KES 5' });
        }
        
        const formattedPhone = formatPhoneNumber(target_phone);
        
        // Get user and check balance
        const userResult = await pool.query(
            'SELECT id, balance FROM users WHERE username = $1 AND status = $2',
            [username, 'active']
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found or suspended' });
        }
        
        const user = userResult.rows[0];
        const discountRate = parseFloat(await getSystemSetting('airtime_discount_rate') || '10');
        const airtimeValue = amount * (1 - discountRate / 100); // User gets 90% value
        
        if (user.balance < amount) {
            // Store as pending purchase
            await pool.query(
                `INSERT INTO pending_purchases (user_id, target_phone, amount, payment_method, status, created_at)
                 VALUES ($1, $2, $3, 'balance', 'pending', NOW())`,
                [user.id, formattedPhone, amount]
            );
            
            return res.status(400).json({ 
                success: false, 
                message: 'Insufficient balance', 
                required: amount,
                available: user.balance,
                shortfall: amount - user.balance
            });
        }
        
        // Create transaction
        const txResult = await pool.query(
            `INSERT INTO transactions (user_id, type, amount, status, provider, target_phone, description, created_at)
             VALUES ($1, 'airtime_purchase', $2, 'pending', 'statum', $3, 'Airtime Purchase', NOW())
             RETURNING id`,
            [user.id, amount, formattedPhone]
        );
        
        const transactionId = txResult.rows[0].id;
        
        // Call Statum API
        const auth = Buffer.from(`${STATUM_CONSUMER_KEY}:${STATUM_CONSUMER_SECRET}`).toString('base64');
        
        const response = await fetch(`${STATUM_BASE_URL}/airtime`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone_number: formattedPhone,
                amount: Math.floor(airtimeValue).toString()
            })
        });
        
        const data = await response.json();
        
        if (data.status_code === 200) {
            // Deduct balance
            await pool.query(
                'UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
                [amount, user.id]
            );
            
            // Update transaction
            await pool.query(
                `UPDATE transactions SET status = 'success', provider_reference = $1, 
                 fee = $2, metadata = $3 WHERE id = $4`,
                [data.request_id, amount - airtimeValue, JSON.stringify(data), transactionId]
            );
            
            res.json({ 
                success: true, 
                message: `KES ${Math.floor(airtimeValue)} airtime sent to ${formattedPhone}`,
                transactionId,
                airtimeValue: Math.floor(airtimeValue)
            });
        } else {
            // Update transaction as failed
            await pool.query(
                `UPDATE transactions SET status = 'failed', metadata = $1 WHERE id = $2`,
                [JSON.stringify(data), transactionId]
            );
            
            res.status(400).json({ success: false, message: data.description || 'Airtime purchase failed' });
        }
    } catch (error) {
        console.error('Airtime error:', error);
        res.status(500).json({ success: false, message: 'Airtime purchase failed' });
    }
});

// Direct airtime purchase (STK Push + Airtime)
app.post('/api/airtime/direct', async (req, res) => {
    try {
        const { pay_phone, receive_phone, amount } = req.body;
        
        if (amount < 5) {
            return res.status(400).json({ success: false, message: 'Minimum airtime is KES 5' });
        }
        
        const formattedPayPhone = formatPhoneNumber(pay_phone);
        const formattedReceivePhone = formatPhoneNumber(receive_phone);
        
        // Create pending transaction
        const txResult = await pool.query(
            `INSERT INTO transactions (user_id, type, amount, status, provider, phone_number, target_phone, description, created_at)
             VALUES (NULL, 'direct_purchase', $1, 'pending', 'paynecta', $2, $3, 'Direct Airtime Purchase', NOW())
             RETURNING id`,
            [amount, formattedPayPhone, formattedReceivePhone]
        );
        
        const transactionId = txResult.rows[0].id;
        
        // Call PayNecta for STK Push
        const response = await fetch(`${PAYNECTA_BASE_URL}/payments/initialize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': PAYNECTA_API_KEY,
                'X-User-Email': PAYNECTA_EMAIL
            },
            body: JSON.stringify({
                phone: formattedPayPhone,
                amount: parseFloat(amount),
                reference: `DIRECT-${transactionId}`,
                callback_url: `${CALLBACK_URL}/api/callbacks/direct-airtime`
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            await pool.query(
                'UPDATE transactions SET provider_reference = $1 WHERE id = $2',
                [data.data?.checkout_request_id, transactionId]
            );
            
            res.json({ 
                success: true, 
                message: 'STK Push sent. Airtime will be sent after payment.',
                transactionId 
            });
        } else {
            await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['failed', transactionId]);
            res.status(400).json({ success: false, message: data.message || 'Payment failed' });
        }
    } catch (error) {
        console.error('Direct airtime error:', error);
        res.status(500).json({ success: false, message: 'Direct purchase failed' });
    }
});

// Callback for direct airtime
app.post('/api/callbacks/direct-airtime', async (req, res) => {
    try {
        console.log('Direct Airtime Callback:', JSON.stringify(req.body));
        
        const { reference, status, mpesa_code } = req.body;
        
        const txResult = await pool.query(
            `SELECT * FROM transactions WHERE provider_reference = $1 OR id::text LIKE $2`,
            [reference, `%${reference.replace('DIRECT-', '')}%`]
        );
        
        if (txResult.rows.length === 0) {
            return res.json({ success: false });
        }
        
        const tx = txResult.rows[0];
        
        if (status === 'success' || status === 'completed') {
            // Send airtime via Statum
            const discountRate = parseFloat(await getSystemSetting('airtime_discount_rate') || '10');
            const airtimeValue = tx.amount * (1 - discountRate / 100);
            
            const auth = Buffer.from(`${STATUM_CONSUMER_KEY}:${STATUM_CONSUMER_SECRET}`).toString('base64');
            
            const airtimeResponse = await fetch(`${STATUM_BASE_URL}/airtime`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    phone_number: tx.target_phone,
                    amount: Math.floor(airtimeValue).toString()
                })
            });
            
            const airtimeData = await airtimeResponse.json();
            
            if (airtimeData.status_code === 200) {
                await pool.query(
                    `UPDATE transactions SET status = 'success', mpesa_code = $1, 
                     metadata = $2 WHERE id = $3`,
                    [mpesa_code, JSON.stringify({ payment: req.body, airtime: airtimeData }), tx.id]
                );
            } else {
                // Payment succeeded but airtime failed - need manual intervention
                await pool.query(
                    `UPDATE transactions SET status = 'failed', mpesa_code = $1,
                     metadata = $2, description = $3 WHERE id = $4`,
                    [mpesa_code, JSON.stringify({ payment: req.body, airtime: airtimeData }), 
                     'Payment received but airtime delivery failed', tx.id]
                );
            }
        } else {
            await pool.query(
                `UPDATE transactions SET status = 'failed', metadata = $1 WHERE id = $2`,
                [JSON.stringify(req.body), tx.id]
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Direct callback error:', error);
        res.status(500).json({ success: false });
    }
});

// Statum callback
app.post('/api/callbacks/statum', async (req, res) => {
    try {
        console.log('Statum Callback:', JSON.stringify(req.body));
        const { request_id, result_code, result_desc } = req.body;
        
        // Update transaction by request_id
        await pool.query(
            `UPDATE transactions SET metadata = metadata || $1::jsonb WHERE provider_reference = $2`,
            [JSON.stringify({ statum_callback: req.body }), request_id]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Statum callback error:', error);
        res.json({ success: false });
    }
});

// Process pending purchase helper
async function processPendingPurchase(userId, pendingId) {
    try {
        const pendingResult = await pool.query('SELECT * FROM pending_purchases WHERE id = $1', [pendingId]);
        if (pendingResult.rows.length === 0) return;
        
        const pending = pendingResult.rows[0];
        
        // Check balance again
        const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
        const balance = parseFloat(userResult.rows[0].balance);
        
        if (balance >= pending.amount) {
            // Process the purchase
            const discountRate = parseFloat(await getSystemSetting('airtime_discount_rate') || '10');
            const airtimeValue = pending.amount * (1 - discountRate / 100);
            
            const auth = Buffer.from(`${STATUM_CONSUMER_KEY}:${STATUM_CONSUMER_SECRET}`).toString('base64');
            
            const response = await fetch(`${STATUM_BASE_URL}/airtime`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    phone_number: pending.target_phone,
                    amount: Math.floor(airtimeValue).toString()
                })
            });
            
            const data = await response.json();
            
            if (data.status_code === 200) {
                // Deduct balance
                await pool.query(
                    'UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
                    [pending.amount, userId]
                );
                
                // Create transaction
                await pool.query(
                    `INSERT INTO transactions (user_id, type, amount, status, provider, provider_reference, target_phone, description, created_at)
                     VALUES ($1, 'airtime_purchase', $2, 'success', 'statum', $3, $4, 'Auto-completed pending purchase', NOW())`,
                    [userId, pending.amount, data.request_id, pending.target_phone]
                );
                
                // Update pending as completed
                await pool.query(
                    `UPDATE pending_purchases SET status = 'completed', updated_at = NOW() WHERE id = $1`,
                    [pendingId]
                );
                
                // Notify user
                await pool.query(
                    `INSERT INTO admin_notifications (user_id, title, message, level, created_at)
                     VALUES ($1, 'Pending Purchase Completed', $2, 'success', NOW())`,
                    [userId, `KES ${Math.floor(airtimeValue)} airtime sent to ${pending.target_phone}`]
                );
            }
        }
    } catch (error) {
        console.error('Process pending error:', error);
    }
}

// ==================== DEPOSIT VERIFICATION ====================

app.post('/api/verify-deposit', async (req, res) => {
    try {
        const { username, mpesa_code, phone } = req.body;
        
        const formattedPhone = formatPhoneNumber(phone);
        
        // Get user
        const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // Check if M-Pesa code already used
        const existingCheck = await pool.query(
            'SELECT * FROM deposit_verifications WHERE mpesa_code = $1',
            [mpesa_code.toUpperCase()]
        );
        
        if (existingCheck.rows.length > 0) {
            const existing = existingCheck.rows[0];
            if (existing.status === 'verified') {
                return res.status(400).json({ success: false, message: 'This M-Pesa code has already been verified and credited' });
            }
            return res.status(400).json({ success: false, message: 'This M-Pesa code is already being processed' });
        }
        
        // Check if already in transactions
        const txCheck = await pool.query(
            "SELECT * FROM transactions WHERE mpesa_code = $1 AND status = 'success'",
            [mpesa_code.toUpperCase()]
        );
        
        if (txCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'This payment has already been received in your account' });
        }
        
        // Create verification request
        await pool.query(
            `INSERT INTO deposit_verifications (user_id, mpesa_code, phone_number, status, created_at)
             VALUES ($1, $2, $3, 'pending', NOW())`,
            [userId, mpesa_code.toUpperCase(), formattedPhone]
        );
        
        // Query PayNecta for the payment (if available)
        // For now, create a pending transaction for admin to verify
        await pool.query(
            `INSERT INTO transactions (user_id, type, amount, status, provider, mpesa_code, phone_number, description, created_at)
             VALUES ($1, 'deposit', 0, 'pending', 'manual', $2, $3, 'Manual deposit verification', NOW())`,
            [userId, mpesa_code.toUpperCase(), formattedPhone]
        );
        
        res.json({ 
            success: true, 
            message: 'Verification request submitted. You will be credited once verified by admin.' 
        });
    } catch (error) {
        console.error('Verify deposit error:', error);
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// ==================== AIRTIME TO CASH ====================

app.post('/api/airtime-to-cash/request', async (req, res) => {
    try {
        const { username, phone, amount } = req.body;
        
        // Check if feature is enabled
        const enabled = await getSystemSetting('airtime_to_cash_enabled');
        if (enabled !== 'true') {
            return res.status(400).json({ success: false, message: 'This feature is coming soon!' });
        }
        
        const formattedPhone = formatPhoneNumber(phone);
        const rate = parseFloat(await getSystemSetting('airtime_to_cash_rate') || '80');
        const cashAmount = amount * (rate / 100);
        
        const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const result = await pool.query(
            `INSERT INTO airtime_to_cash_requests (user_id, phone_number, airtime_amount, cash_amount, cashback_rate, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
             RETURNING id`,
            [userResult.rows[0].id, formattedPhone, amount, cashAmount, rate]
        );
        
        // Return instructions
        res.json({
            success: true,
            requestId: result.rows[0].id,
            instructions: {
                dialCode: `*140*${amount}*0718369524#`,
                receiveNumber: '0718369524',
                cashAmount: cashAmount
            },
            message: `Dial *140*${amount}*0718369524# to send airtime. You will receive KES ${cashAmount} after verification.`
        });
    } catch (error) {
        console.error('A2C request error:', error);
        res.status(500).json({ success: false, message: 'Request failed' });
    }
});

app.post('/api/airtime-to-cash/verify', async (req, res) => {
    try {
        const { requestId, verificationCode, phone } = req.body;
        
        // Update request with verification code
        await pool.query(
            `UPDATE airtime_to_cash_requests SET sambaza_code = $1, status = 'verified', updated_at = NOW() WHERE id = $2`,
            [verificationCode, requestId]
        );
        
        // Send to WhatsApp (placeholder - would integrate with WhatsApp API)
        // For now, just mark as pending admin verification
        
        res.json({ 
            success: true, 
            message: 'Verification submitted. You will receive your cash once confirmed.' 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// ==================== TRANSACTIONS ====================

app.get('/api/transactions/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { limit = 50, offset = 0, type } = req.query;
        
        const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        let query = `SELECT * FROM transactions WHERE user_id = $1`;
        const params = [userResult.rows[0].id];
        
        if (type) {
            query += ` AND type = $${params.length + 1}`;
            params.push(type);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), parseInt(offset));
        
        const result = await pool.query(query, params);
        
        res.json({ success: true, transactions: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get transactions' });
    }
});

// Generate PDF receipt
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
        
        // Create PDF
        const doc = new PDFDocument({ margin: 50 });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=transactions_${username}.pdf`);
        
        doc.pipe(res);
        
        // Header
        doc.fontSize(20).text('Airtime Platform', { align: 'center' });
        doc.fontSize(14).text('Transaction History', { align: 'center' });
        doc.moveDown();
        
        doc.fontSize(12).text(`Username: ${username}`);
        doc.text(`Email: ${user.email}`);
        doc.text(`Current Balance: KES ${user.balance}`);
        doc.text(`Generated: ${new Date().toLocaleString()}`);
        doc.moveDown();
        
        // Transactions
        doc.fontSize(10);
        
        txResult.rows.forEach((tx, index) => {
            if (doc.y > 700) {
                doc.addPage();
            }
            
            doc.text(`${index + 1}. ${tx.type.toUpperCase()} - KES ${tx.amount}`, { continued: true });
            doc.text(` [${tx.status.toUpperCase()}]`, { align: 'right' });
            doc.text(`   Date: ${new Date(tx.created_at).toLocaleString()}`);
            if (tx.mpesa_code) doc.text(`   M-Pesa: ${tx.mpesa_code}`);
            if (tx.target_phone) doc.text(`   To: ${tx.target_phone}`);
            doc.moveDown(0.5);
        });
        
        doc.end();
    } catch (error) {
        console.error('PDF error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate PDF' });
    }
});

// ==================== PAYHERO LINK BUILDER ====================

app.get('/api/payhero/link', (req, res) => {
    try {
        const { phone, amount, username } = req.query;
        
        const baseUrl = 'https://short.payhero.co.ke/s/oEvAxA8Xx6cDoBLxntShmF';
        const params = new URLSearchParams({
            phone_number: formatPhoneNumber(phone),
            customer_name: username || 'Customer',
            amount: amount,
            reference: '#airtime deposit'
        });
        
        res.json({ 
            success: true, 
            url: `${baseUrl}?${params.toString()}`,
            // Alternative format if needed
            directUrl: baseUrl
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to generate link' });
    }
});

// ==================== ADMIN ROUTES ====================

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: Buffer.from(password + Date.now()).toString('base64') });
    } else {
        res.status(401).json({ success: false, message: 'Invalid password' });
    }
});

// Admin middleware
function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Admin authentication required' });
    }
    // Simple validation - in production, use proper JWT
    next();
}

// Get all users
app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, phone, balance, bonus_balance, status, last_login_at, created_at FROM users ORDER BY created_at DESC'
        );
        res.json({ success: true, users: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get users' });
    }
});

// Update user status
app.put('/api/admin/users/:id/status', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        await pool.query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
        res.json({ success: true, message: `User ${status === 'active' ? 'activated' : 'suspended'}` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update user' });
    }
});

// Update user balance (adjustment)
app.put('/api/admin/users/:id/balance', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, reason } = req.body;
        
        await pool.query(
            'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
            [amount, id]
        );
        
        // Log adjustment
        await pool.query(
            `INSERT INTO transactions (user_id, type, amount, status, provider, description, created_at)
             VALUES ($1, 'adjustment', $2, 'success', 'manual', $3, NOW())`,
            [id, amount, reason || 'Admin balance adjustment']
        );
        
        res.json({ success: true, message: 'Balance updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update balance' });
    }
});

// Get all transactions
app.get('/api/admin/transactions', adminAuth, async (req, res) => {
    try {
        const { limit = 100, status, type } = req.query;
        
        let query = `SELECT t.*, u.username, u.email, u.phone as user_phone 
                     FROM transactions t 
                     LEFT JOIN users u ON t.user_id = u.id`;
        const conditions = [];
        const params = [];
        
        if (status) {
            params.push(status);
            conditions.push(`t.status = $${params.length}`);
        }
        if (type) {
            params.push(type);
            conditions.push(`t.type = $${params.length}`);
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        params.push(parseInt(limit));
        query += ` ORDER BY t.created_at DESC LIMIT $${params.length}`;
        
        const result = await pool.query(query, params);
        res.json({ success: true, transactions: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get transactions' });
    }
});

// Verify manual deposit
app.put('/api/admin/verify-deposit/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, approve } = req.body;
        
        const txResult = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
        if (txResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }
        
        const tx = txResult.rows[0];
        
        if (approve) {
            // Calculate bonus
            const bonusThreshold = parseFloat(await getSystemSetting('deposit_bonus_threshold') || '50');
            const bonusAmount = parseFloat(await getSystemSetting('deposit_bonus_amount') || '6');
            const bonus = amount >= bonusThreshold ? bonusAmount : 0;
            
            // Update transaction
            await pool.query(
                `UPDATE transactions SET amount = $1, bonus = $2, status = 'success' WHERE id = $3`,
                [amount, bonus, id]
            );
            
            // Credit user
            await pool.query(
                'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
                [amount + bonus, tx.user_id]
            );
            
            // Update verification
            await pool.query(
                `UPDATE deposit_verifications SET amount = $1, status = 'verified', verified_at = NOW() WHERE mpesa_code = $2`,
                [amount, tx.mpesa_code]
            );
            
            // Notify user
            await pool.query(
                `INSERT INTO admin_notifications (user_id, title, message, level, created_at)
                 VALUES ($1, 'Deposit Verified', $2, 'success', NOW())`,
                [tx.user_id, `KES ${amount}${bonus > 0 ? ' + ' + bonus + ' bonus' : ''} has been credited to your account!`]
            );
            
            res.json({ success: true, message: 'Deposit verified and credited' });
        } else {
            await pool.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [id]);
            await pool.query(
                `UPDATE deposit_verifications SET status = 'failed' WHERE mpesa_code = $1`,
                [tx.mpesa_code]
            );
            
            res.json({ success: true, message: 'Deposit rejected' });
        }
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// Get system settings
app.get('/api/admin/settings', adminAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM system_settings ORDER BY setting_key');
        res.json({ success: true, settings: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get settings' });
    }
});

// Update system setting
app.put('/api/admin/settings/:key', adminAuth, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        
        await updateSystemSetting(key, value);
        res.json({ success: true, message: 'Setting updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update setting' });
    }
});

// Send notification to user or all users
app.post('/api/admin/notifications', adminAuth, async (req, res) => {
    try {
        const { userId, title, message, level = 'info', isGlobal = false } = req.body;
        
        await pool.query(
            `INSERT INTO admin_notifications (user_id, title, message, level, is_global, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [isGlobal ? null : userId, title, message, level, isGlobal]
        );
        
        res.json({ success: true, message: 'Notification sent' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to send notification' });
    }
});

// Get pending verifications
app.get('/api/admin/pending-verifications', adminAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT dv.*, u.username, u.email 
             FROM deposit_verifications dv 
             JOIN users u ON dv.user_id = u.id 
             WHERE dv.status = 'pending' 
             ORDER BY dv.created_at DESC`
        );
        res.json({ success: true, verifications: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get verifications' });
    }
});

// Get airtime to cash requests
app.get('/api/admin/airtime-to-cash', adminAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT a.*, u.username, u.email, u.phone as user_phone 
             FROM airtime_to_cash_requests a 
             JOIN users u ON a.user_id = u.id 
             ORDER BY a.created_at DESC`
        );
        res.json({ success: true, requests: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get requests' });
    }
});

// Complete airtime to cash
app.put('/api/admin/airtime-to-cash/:id/complete', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        const reqResult = await pool.query('SELECT * FROM airtime_to_cash_requests WHERE id = $1', [id]);
        if (reqResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }
        
        const request = reqResult.rows[0];
        
        await pool.query(
            `UPDATE airtime_to_cash_requests SET status = 'completed', updated_at = NOW() WHERE id = $1`,
            [id]
        );
        
        // Create transaction record
        await pool.query(
            `INSERT INTO transactions (user_id, type, amount, status, provider, phone_number, description, created_at)
             VALUES ($1, 'airtime_to_cash', $2, 'success', 'manual', $3, 'Airtime to Cash conversion', NOW())`,
            [request.user_id, request.cash_amount, request.phone_number]
        );
        
        // Notify user
        await pool.query(
            `INSERT INTO admin_notifications (user_id, title, message, level, created_at)
             VALUES ($1, 'Cash Sent!', $2, 'success', NOW())`,
            [request.user_id, `KES ${request.cash_amount} has been sent to your M-Pesa!`]
        );
        
        res.json({ success: true, message: 'Request completed' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to complete request' });
    }
});

// Dashboard stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const [users, deposits, airtime, balance] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query("SELECT SUM(amount) FROM transactions WHERE type = 'deposit' AND status = 'success'"),
            pool.query("SELECT SUM(amount) FROM transactions WHERE type = 'airtime_purchase' AND status = 'success'"),
            pool.query('SELECT SUM(balance) FROM users')
        ]);
        
        res.json({
            success: true,
            stats: {
                totalUsers: parseInt(users.rows[0].count),
                totalDeposits: parseFloat(deposits.rows[0].sum || 0),
                totalAirtime: parseFloat(airtime.rows[0].sum || 0),
                totalBalance: parseFloat(balance.rows[0].sum || 0)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get stats' });
    }
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ success: false, status: 'unhealthy' });
    }
});

// Wake up endpoint
app.get('/api/wakeup', (req, res) => {
    res.json({ success: true, message: 'Server is awake', timestamp: new Date().toISOString() });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
