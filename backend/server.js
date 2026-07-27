const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const nodemailer = require('nodemailer');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { OpenAI } = require('openai');
const Stripe = require('stripe');
const webpush = require('web-push');
require('dotenv').config();

// ============ INITIALIZE ============
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ DATABASE SETUP ============
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  // USERS (extended)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT,
      bio TEXT,
      avatar TEXT,
      cover_photo TEXT,
      location TEXT,
      website TEXT,
      is_verified INTEGER DEFAULT 0,
      is_private INTEGER DEFAULT 0,
      two_factor_secret TEXT,
      two_factor_enabled INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      subscription_tier TEXT DEFAULT 'free',
      subscription_end_date DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // POSTS (extended for video)
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT,
      image TEXT,
      video TEXT,
      post_type TEXT DEFAULT 'text',
      likes_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      shares_count INTEGER DEFAULT 0,
      views_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Continue with existing tables...
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, user_id),
    FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, following_id),
    FOREIGN KEY (follower_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (following_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  // MESSAGES
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  // STORIES
  db.run(`CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    image TEXT,
    video TEXT,
    text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME DEFAULT (datetime('now', '+24 hours')),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS story_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL,
    viewer_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(story_id, viewer_id),
    FOREIGN KEY (story_id) REFERENCES stories (id) ON DELETE CASCADE,
    FOREIGN KEY (viewer_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  // NOTIFICATIONS
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    from_user_id INTEGER,
    type TEXT NOT NULL,
    content TEXT,
    link TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  // PUSH SUBSCRIPTIONS
  db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  // LIVE STREAMS
  db.run(`CREATE TABLE IF NOT EXISTS live_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT,
    description TEXT,
    stream_key TEXT UNIQUE,
    is_live INTEGER DEFAULT 0,
    viewer_count INTEGER DEFAULT 0,
    started_at DATETIME,
    ended_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  // PAYMENTS
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stripe_payment_intent_id TEXT UNIQUE,
    amount INTEGER NOT NULL,
    currency TEXT DEFAULT 'usd',
    status TEXT DEFAULT 'pending',
    subscription_tier TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`);

  console.log('✅ All tables initialized');
});

// ============ CLOUDINARY SETUP ============
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const cloudinaryStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'zen-social',
    allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'mp4', 'mov', 'avi'],
    resource_type: 'auto'
  }
});

const upload = multer({ 
  storage: cloudinaryStorage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB for videos
});

// ============ EMAIL TRANSPORTER ============
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ============ OPEN AI ============
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============ STRIPE ============
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ============ WEB PUSH ============
webpush.setVapidDetails(
  'mailto:' + process.env.FROM_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============ JWT HELPER ============
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ============ 1. TWO-FACTOR AUTHENTICATION ============

// Enable 2FA - Generate secret & QR
app.post('/api/auth/2fa/enable', verifyToken, (req, res) => {
  const secret = speakeasy.generateSecret({
    name: `Zen (${req.userId})`,
    length: 20
  });

  db.run(
    'UPDATE users SET two_factor_secret = ?, two_factor_enabled = 0 WHERE id = ?',
    [secret.base32, req.userId],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      
      QRCode.toDataURL(secret.otpauth_url, (err, qrCode) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ 
          secret: secret.base32,
          qrCode,
          message: 'Scan QR code with Google Authenticator or similar app'
        });
      });
    }
  );
});

// Verify 2FA token
app.post('/api/auth/2fa/verify', verifyToken, (req, res) => {
  const { token } = req.body;
  
  db.get('SELECT two_factor_secret FROM users WHERE id = ?', [req.userId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const verified = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: 'base32',
      token: token,
      window: 1
    });
    
    if (verified) {
      db.run('UPDATE users SET two_factor_enabled = 1 WHERE id = ?', [req.userId]);
      res.json({ verified: true, message: '2FA enabled successfully' });
    } else {
      res.status(400).json({ error: 'Invalid verification code' });
    }
  });
});

// Login with 2FA
app.post('/api/auth/login-2fa', (req, res) => {
  const { email, password, twoFactorToken } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    if (user.two_factor_enabled) {
      if (!twoFactorToken) {
        return res.status(401).json({ 
          error: '2FA required',
          requires2FA: true 
        });
      }
      
      const verified = speakeasy.totp.verify({
        secret: user.two_factor_secret,
        encoding: 'base32',
        token: twoFactorToken,
        window: 1
      });
      
      if (!verified) {
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }
    
    const token = generateToken(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        bio: user.bio,
        avatar: user.avatar,
        is_verified: user.is_verified,
        two_factor_enabled: user.two_factor_enabled
      }
    });
  });
});

// ============ 2. VIDEO POSTS (Cloudinary) ============

app.post('/api/posts/video', verifyToken, upload.single('video'), (req, res) => {
  const { content, title } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ error: 'Video file required' });
  }
  
  db.run(
    'INSERT INTO posts (user_id, content, video, post_type) VALUES (?, ?, ?, ?)',
    [req.userId, content || title || '', req.file.path, 'video'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get(
        `SELECT p.*, u.username, u.display_name, u.avatar 
         FROM posts p 
         JOIN users u ON p.user_id = u.id 
         WHERE p.id = ?`,
        [this.lastID],
        (err, post) => {
          if (err) return res.status(500).json({ error: err.message });
          res.status(201).json(post);
        }
      );
    }
  );
});

// Get video streaming URL
app.get('/api/posts/:id/video', (req, res) => {
  db.get('SELECT video FROM posts WHERE id = ?', [req.params.id], (err, post) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!post || !post.video) return res.status(404).json({ error: 'Video not found' });
    
    // Cloudinary video URL with streaming optimizations
    const videoUrl = cloudinary.url(post.video, {
      resource_type: 'video',
      format: 'mp4',
      quality: 'auto',
      fetch_format: 'auto'
    });
    
    res.json({ videoUrl });
  });
});

// ============ 3. LIVE STREAMING (Agora) ============

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// Generate Agora token
app.post('/api/live/generate-token', verifyToken, (req, res) => {
  const { channelName } = req.body;
  
  // Using Agora's RTC Token Builder
  const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
  
  const uid = req.userId;
  const role = RtcRole.PUBLISHER;
  const expireTime = 3600; // 1 hour
  
  const token = RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_APP_CERTIFICATE,
    channelName,
    uid,
    role,
    expireTime
  );
  
  res.json({ token, appId: AGORA_APP_ID, channelName });
});

// Start live stream
app.post('/api/live/start', verifyToken, (req, res) => {
  const { title, description, channelName } = req.body;
  const streamKey = `stream_${Date.now()}_${req.userId}`;
  
  db.run(
    'INSERT INTO live_streams (user_id, title, description, stream_key, is_live, started_at) VALUES (?, ?, ?, ?, 1, datetime("now"))',
    [req.userId, title, description, streamKey],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Notify followers
      notifyFollowers(req.userId, 'live_started', `${title} is now live!`);
      
      res.json({
        streamId: this.lastID,
        streamKey,
        channelName,
        rtmpUrl: `rtmp://a.rtmp.youtube.com/live2`,
        message: 'Stream started successfully'
      });
    }
  );
});

// End live stream
app.post('/api/live/end/:streamId', verifyToken, (req, res) => {
  db.run(
    'UPDATE live_streams SET is_live = 0, ended_at = datetime("now") WHERE id = ? AND user_id = ?',
    [req.params.streamId, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Stream ended' });
    }
  );
});

// Get live streams
app.get('/api/live/streams', (req, res) => {
  db.all(
    `SELECT ls.*, u.username, u.display_name, u.avatar, u.is_verified
     FROM live_streams ls
     JOIN users u ON ls.user_id = u.id
     WHERE ls.is_live = 1
     ORDER BY ls.started_at DESC`,
    (err, streams) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(streams);
    }
  );
});

// ============ 4. AI FEATURES ============

// AI Caption Generator
app.post('/api/ai/caption', verifyToken, async (req, res) => {
  const { prompt, mood, style } = req.body;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "You are a creative social media caption writer. Generate engaging, thoughtful captions for Zen social media. Keep it under 200 characters."
        },
        {
          role: "user",
          content: `Generate a ${mood || 'calm'} ${style || 'inspirational'} caption about: ${prompt || 'mindfulness'}`
        }
      ],
      max_tokens: 100,
      n: 3
    });
    
    const captions = completion.choices.map(c => c.message.content.trim());
    res.json({ captions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Hashtag Generator
app.post('/api/ai/hashtags', verifyToken, async (req, res) => {
  const { topic, count } = req.body;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "Generate relevant hashtags for social media posts. Return only the hashtags as a comma-separated list."
        },
        {
          role: "user",
          content: `Generate ${count || 10} popular hashtags about: ${topic || 'self care'}`
        }
      ],
      max_tokens: 150
    });
    
    const hashtags = completion.choices[0].message.content
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.startsWith('#'));
    
    res.json({ hashtags });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Image Enhancement
app.post('/api/ai/enhance-image', verifyToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Image required' });
  }
  
  try {
    // Use Cloudinary AI enhancement
    const enhancedUrl = cloudinary.url(req.file.path, {
      effect: 'improve',
      quality: 'auto',
      fetch_format: 'auto'
    });
    
    res.json({ enhancedUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Auto-Translate
app.post('/api/ai/translate', verifyToken, async (req, res) => {
  const { text, targetLanguage } = req.body;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Translate the following text to ${targetLanguage || 'Spanish'}. Return only the translation.`
        },
        {
          role: "user",
          content: text
        }
      ],
      max_tokens: 200
    });
    
    res.json({ 
      original: text,
      translated: completion.choices[0].message.content,
      language: targetLanguage
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Content Moderation
app.post('/api/ai/moderation', verifyToken, async (req, res) => {
  const { content } = req.body;
  
  try {
    const response = await openai.moderations.create({
      input: content
    });
    
    const result = response.results[0];
    res.json({
      flagged: result.flagged,
      categories: result.categories,
      category_scores: result.category_scores
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ 5. PUSH NOTIFICATIONS ============

// Save push subscription
app.post('/api/push/subscribe', verifyToken, (req, res) => {
  const { endpoint, p256dh, auth } = req.body;
  
  db.run(
    'INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
    [req.userId, endpoint, p256dh, auth],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Subscribed to push notifications' });
    }
  );
});

// Send push notification
async function sendPushNotification(userId, title, body, data = {}) {
  db.all(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    [userId],
    async (err, subscriptions) => {
      if (err || !subscriptions.length) return;
      
      for (const sub of subscriptions) {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth
              }
            },
            JSON.stringify({
              title,
              body,
              icon: '/zen-icon.png',
              badge: '/badge.png',
              data: {
                url: data.url || '/',
                ...data
              }
            })
          );
        } catch (error) {
          console.error('Push notification error:', error);
          // Remove invalid subscription
          if (error.statusCode === 410) {
            db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
          }
        }
      }
    }
  );
}

// ============ 6. PAYMENTS (Stripe) ============

// Create payment intent
app.post('/api/payments/create-intent', verifyToken, async (req, res) => {
  const { amount, currency, subscription_tier } = req.body;
  
  try {
    // Get or create customer
    db.get('SELECT stripe_customer_id FROM users WHERE id = ?', [req.userId], async (err, user) => {
      let customerId = user?.stripe_customer_id;
      
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: req.body.email || undefined,
          metadata: { userId: req.userId }
        });
        customerId = customer.id;
        db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, req.userId]);
      }
      
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount * 100, // Convert to cents
        currency: currency || 'usd',
        customer: customerId,
        metadata: {
          userId: req.userId,
          subscription_tier: subscription_tier || 'premium'
        }
      });
      
      // Save to database
      db.run(
        'INSERT INTO payments (user_id, stripe_payment_intent_id, amount, currency, subscription_tier) VALUES (?, ?, ?, ?, ?)',
        [req.userId, paymentIntent.id, amount, currency || 'usd', subscription_tier || 'premium']
      );
      
      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook to handle payment confirmation
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      db.run(
        'UPDATE payments SET status = "succeeded" WHERE stripe_payment_intent_id = ?',
        [paymentIntent.id],
        function(err) {
          if (!err) {
            // Update user subscription
            db.get('SELECT user_id, subscription_tier FROM payments WHERE stripe_payment_intent_id = ?', 
              [paymentIntent.id], (err, payment) => {
                if (!err && payment) {
                  const tier = payment.subscription_tier || 'premium';
                  const endDate = new Date();
                  endDate.setDate(endDate.getDate() + 30); // 30 days subscription
                  
                  db.run(
                    'UPDATE users SET subscription_tier = ?, subscription_end_date = ? WHERE id = ?',
                    [tier, endDate.toISOString(), payment.user_id]
                  );
                }
              }
            );
          }
        }
      );
      break;
  }
  
  res.json({ received: true });
});

// Get subscription status
app.get('/api/payments/subscription', verifyToken, (req, res) => {
  db.get(
    'SELECT subscription_tier, subscription_end_date FROM users WHERE id = ?',
    [req.userId],
    (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        tier: user?.subscription_tier || 'free',
        endDate: user?.subscription_end_date
      });
    }
  );
});

// ============ 7. NOTIFICATIONS (Enhanced) ============

// Create notification
function createNotification(userId, fromUserId, type, content, link) {
  db.run(
    'INSERT INTO notifications (user_id, from_user_id, type, content, link) VALUES (?, ?, ?, ?, ?)',
    [userId, fromUserId, type, content, link],
    function(err) {
      if (!err) {
        // Emit real-time notification
        io.to(`user_${userId}`).emit('notification', {
          id: this.lastID,
          type,
          content,
          link,
          from_user_id: fromUserId,
          created_at: new Date().toISOString(),
          is_read: 0
        });
        
        // Send push notification if user has subscriptions
        db.get('SELECT display_name FROM users WHERE id = ?', [fromUserId], (err, user) => {
          if (!err && user) {
            sendPushNotification(
              userId,
              `${user.display_name || 'Someone'} ${type}`,
              content,
              { url: link }
            );
          }
        });
      }
    }
  );
}

// Notify followers
function notifyFollowers(userId, type, content) {
  db.all('SELECT follower_id FROM follows WHERE following_id = ?', [userId], (err, followers) => {
    if (err || !followers.length) return;
    
    db.get('SELECT display_name FROM users WHERE id = ?', [userId], (err, user) => {
      if (err) return;
      
      followers.forEach(f => {
        createNotification(
          f.follower_id,
          userId,
          type,
          `${user.display_name} ${content}`,
          `/profile/${userId}`
        );
      });
    });
  });
}

// Get notifications
app.get('/api/notifications', verifyToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;
  
  db.all(
    `SELECT n.*, u.display_name, u.username, u.avatar 
     FROM notifications n
     LEFT JOIN users u ON n.from_user_id = u.id
     WHERE n.user_id = ?
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [req.userId, limit, offset],
    (err, notifications) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Mark as read
      db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.userId]);
      
      res.json(notifications);
    }
  );
});

// ============ 8. ENHANCED POST FEATURES ============

// View count for posts
app.post('/api/posts/:id/view', (req, res) => {
  db.run('UPDATE posts SET views_count = views_count + 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Repost/Share
app.post('/api/posts/:id/repost', verifyToken, (req, res) => {
  const { content } = req.body;
  
  db.get('SELECT user_id, content, image, video FROM posts WHERE id = ?', [req.params.id], (err, original) => {
    if (err || !original) return res.status(404).json({ error: 'Post not found' });
    
    const repostContent = `Reposted: ${original.content.substring(0, 100)}${original.content.length > 100 ? '...' : ''}`;
    
    db.run(
      'INSERT INTO posts (user_id, content, post_type) VALUES (?, ?, ?)',
      [req.userId, content || repostContent, 'repost'],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        db.run('UPDATE posts SET shares_count = shares_count + 1 WHERE id = ?', [req.params.id]);
        
        // Notify original poster
        if (original.user_id !== req.userId) {
          db.get('SELECT display_name FROM users WHERE id = ?', [req.userId], (err, user) => {
            if (!err) {
              createNotification(
                original.user_id,
                req.userId,
                'repost',
                `${user.display_name} reposted your post`,
                `/post/${req.params.id}`
              );
            }
          });
        }
        
        res.status(201).json({ message: 'Post reposted' });
      }
    );
  });
});

// ============ 9. SOCKET.IO (Real-time) ============

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  socket.on('authenticate', (userId) => {
    socket.join(`user_${userId}`);
    socket.userId = userId;
    console.log(`User ${userId} authenticated`);
  });
  
  socket.on('message', (data) => {
    const { receiver_id, content } = data;
    
    db.run(
      'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
      [socket.userId, receiver_id, content],
      function(err) {
        if (!err) {
          db.get(
            `SELECT m.*, u1.username as sender_username, u1.display_name as sender_name,
                    u2.username as receiver_username, u2.display_name as receiver_name
             FROM messages m
             JOIN users u1 ON m.sender_id = u1.id
             JOIN users u2 ON m.receiver_id = u2.id
             WHERE m.id = ?`,
            [this.lastID],
            (err, message) => {
              if (!err) {
                io.to(`user_${receiver_id}`).emit('new_message', message);
                io.to(`user_${socket.userId}`).emit('new_message', message);
                
                // Create notification
                db.get('SELECT display_name FROM users WHERE id = ?', [socket.userId], (err, user) => {
                  if (!err) {
                    createNotification(
                      receiver_id,
                      socket.userId,
                      'message',
                      `${user.display_name} sent you a message`,
                      `/messages/${socket.userId}`
                    );
                  }
                });
              }
            }
          );
        }
      }
    );
  });
  
  socket.on('typing', (data) => {
    const { receiver_id, is_typing } = data;
    io.to(`user_${receiver_id}`).emit('typing', {
      sender_id: socket.userId,
      is_typing
    });
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Zen Social API running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server ready`);
  console.log(`🎥 Live streaming ready`);
  console.log(`🤖 AI features ready`);
  console.log(`💳 Payments ready`);
  console.log(`🔔 Push notifications ready`);
});
