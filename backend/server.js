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
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Create uploads folder
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Database setup
const db = new sqlite3.Database('./database.sqlite');

// Initialize database tables
db.serialize(() => {
  // Users table
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Posts table
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Comments table
  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Likes table
  db.run(`
    CREATE TABLE IF NOT EXISTS likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Follows table
  db.run(`
    CREATE TABLE IF NOT EXISTS follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_id, following_id),
      FOREIGN KEY (follower_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (following_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Messages table (for chat)
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Stories table
  db.run(`
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      image TEXT,
      video TEXT,
      text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT (datetime('now', '+24 hours')),
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Story views
  db.run(`
    CREATE TABLE IF NOT EXISTS story_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id INTEGER NOT NULL,
      viewer_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(story_id, viewer_id),
      FOREIGN KEY (story_id) REFERENCES stories (id) ON DELETE CASCADE,
      FOREIGN KEY (viewer_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  console.log('✅ Database initialized');
});

// JWT Helper
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ==================== AUTH ROUTES ====================

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password, display_name } = req.body;
  
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(
      'INSERT INTO users (username, email, password, display_name) VALUES (?, ?, ?, ?)',
      [username, email, hashedPassword, display_name || username],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Username or email already exists' });
          }
          return res.status(500).json({ error: err.message });
        }
        
        const token = generateToken(this.lastID);
        res.status(201).json({
          token,
          user: {
            id: this.lastID,
            username,
            email,
            display_name: display_name || username
          }
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
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
        is_verified: user.is_verified
      }
    });
  });
});

// Get current user
app.get('/api/auth/me', verifyToken, (req, res) => {
  db.get(
    'SELECT id, username, email, display_name, bio, avatar, cover_photo, location, website, is_verified, is_private, created_at FROM users WHERE id = ?',
    [req.userId],
    (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    }
  );
});

// ==================== USER ROUTES ====================

// Get user by ID
app.get('/api/users/:id', (req, res) => {
  db.get(
    'SELECT id, username, display_name, bio, avatar, cover_photo, location, website, is_verified, is_private, created_at FROM users WHERE id = ?',
    [req.params.id],
    (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      // Get follow counts
      db.get('SELECT COUNT(*) as followers FROM follows WHERE following_id = ?', [user.id], (err, followData) => {
        db.get('SELECT COUNT(*) as following FROM follows WHERE follower_id = ?', [user.id], (err, followingData) => {
          res.json({
            ...user,
            followers: followData?.followers || 0,
            following: followingData?.following || 0
          });
        });
      });
    }
  );
});

// Update user profile
app.put('/api/users/update', verifyToken, (req, res) => {
  const { display_name, bio, location, website, is_private } = req.body;
  
  db.run(
    'UPDATE users SET display_name = ?, bio = ?, location = ?, website = ?, is_private = ? WHERE id = ?',
    [display_name, bio, location, website, is_private || 0, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Profile updated successfully' });
    }
  );
});

// Upload avatar
app.post('/api/users/avatar', verifyToken, upload.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const avatarUrl = `/uploads/${req.file.filename}`;
  db.run(
    'UPDATE users SET avatar = ? WHERE id = ?',
    [avatarUrl, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ avatar: avatarUrl });
    }
  );
});

// ==================== POST ROUTES ====================

// Create post
app.post('/api/posts', verifyToken, upload.single('image'), (req, res) => {
  const { content, post_type } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  
  db.run(
    'INSERT INTO posts (user_id, content, image, post_type) VALUES (?, ?, ?, ?)',
    [req.userId, content, image, post_type || 'text'],
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

// Get feed (posts from people you follow)
app.get('/api/posts/feed', verifyToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;
  
  db.all(
    `SELECT p.*, u.username, u.display_name, u.avatar, u.is_verified,
            CASE WHEN l.user_id IS NOT NULL THEN 1 ELSE 0 END as is_liked
     FROM posts p
     JOIN users u ON p.user_id = u.id
     LEFT JOIN follows f ON f.following_id = p.user_id AND f.follower_id = ?
     LEFT JOIN likes l ON l.post_id = p.id AND l.user_id = ?
     WHERE f.following_id IS NOT NULL OR p.user_id = ?
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [req.userId, req.userId, req.userId, limit, offset],
    (err, posts) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Get comment counts and recent comments for each post
      const postPromises = posts.map((post) => {
        return new Promise((resolve) => {
          db.get('SELECT COUNT(*) as count FROM comments WHERE post_id = ?', [post.id], (err, commentCount) => {
            db.all(
              'SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON c.user_id = u.id WHERE c.post_id = ? ORDER BY c.created_at DESC LIMIT 3',
              [post.id],
              (err, comments) => {
                resolve({
                  ...post,
                  comments_count: commentCount?.count || 0,
                  recent_comments: comments || []
                });
              }
            );
          });
        });
      });
      
      Promise.all(postPromises).then(results => {
        res.json(results);
      });
    }
  );
});

// Get single post
app.get('/api/posts/:id', (req, res) => {
  db.get(
    `SELECT p.*, u.username, u.display_name, u.avatar, u.is_verified
     FROM posts p
     JOIN users u ON p.user_id = u.id
     WHERE p.id = ?`,
    [req.params.id],
    (err, post) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!post) return res.status(404).json({ error: 'Post not found' });
      
      db.all(
        'SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON c.user_id = u.id WHERE c.post_id = ? ORDER BY c.created_at DESC',
        [post.id],
        (err, comments) => {
          db.get('SELECT COUNT(*) as likes FROM likes WHERE post_id = ?', [post.id], (err, likes) => {
            res.json({ ...post, comments: comments || [], likes: likes?.likes || 0 });
          });
        }
      );
    }
  );
});

// Delete post
app.delete('/api/posts/:id', verifyToken, (req, res) => {
  db.run(
    'DELETE FROM posts WHERE id = ? AND user_id = ?',
    [req.params.id, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Post not found or unauthorized' });
      }
      res.json({ message: 'Post deleted successfully' });
    }
  );
});

// ==================== LIKE ROUTES ====================

// Toggle like
app.post('/api/posts/:id/like', verifyToken, (req, res) => {
  const postId = req.params.id;
  
  db.get('SELECT * FROM likes WHERE post_id = ? AND user_id = ?', [postId, req.userId], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (existing) {
      // Unlike
      db.run('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, req.userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE posts SET likes_count = likes_count - 1 WHERE id = ?', [postId]);
        res.json({ liked: false, message: 'Unliked' });
      });
    } else {
      // Like
      db.run('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [postId, req.userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?', [postId]);
        res.json({ liked: true, message: 'Liked' });
      });
    }
  });
});

// ==================== COMMENT ROUTES ====================

// Add comment
app.post('/api/posts/:id/comments', verifyToken, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Comment content required' });
  
  db.run(
    'INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)',
    [req.params.id, req.userId, content],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      db.run('UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?', [req.params.id]);
      
      db.get(
        'SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?',
        [this.lastID],
        (err, comment) => {
          if (err) return res.status(500).json({ error: err.message });
          res.status(201).json(comment);
        }
      );
    }
  );
});

// Delete comment
app.delete('/api/comments/:id', verifyToken, (req, res) => {
  db.get('SELECT post_id FROM comments WHERE id = ? AND user_id = ?', [req.params.id, req.userId], (err, comment) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!comment) return res.status(404).json({ error: 'Comment not found or unauthorized' });
    
    db.run('DELETE FROM comments WHERE id = ?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run('UPDATE posts SET comments_count = comments_count - 1 WHERE id = ?', [comment.post_id]);
      res.json({ message: 'Comment deleted' });
    });
  });
});

// ==================== FOLLOW ROUTES ====================

// Follow user
app.post('/api/users/:id/follow', verifyToken, (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.userId) {
    return res.status(400).json({ error: 'Cannot follow yourself' });
  }
  
  db.run(
    'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)',
    [req.userId, userId],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Already following' });
        }
        return res.status(500).json({ error: err.message });
      }
      res.json({ following: true, message: 'Followed successfully' });
    }
  );
});

// Unfollow user
app.delete('/api/users/:id/follow', verifyToken, (req, res) => {
  db.run(
    'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
    [req.userId, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ following: false, message: 'Unfollowed successfully' });
    }
  );
});

// Check if following
app.get('/api/users/:id/follow/check', verifyToken, (req, res) => {
  db.get(
    'SELECT * FROM follows WHERE follower_id = ? AND following_id = ?',
    [req.userId, req.params.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ following: !!result });
    }
  );
});

// ==================== STORY ROUTES ====================

// Create story
app.post('/api/stories', verifyToken, upload.single('image'), (req, res) => {
  const { text } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  
  db.run(
    'INSERT INTO stories (user_id, image, text) VALUES (?, ?, ?)',
    [req.userId, image, text],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get(
        `SELECT s.*, u.username, u.display_name, u.avatar 
         FROM stories s 
         JOIN users u ON s.user_id = u.id 
         WHERE s.id = ?`,
        [this.lastID],
        (err, story) => {
          if (err) return res.status(500).json({ error: err.message });
          res.status(201).json(story);
        }
      );
    }
  );
});

// Get stories (from followed users)
app.get('/api/stories/feed', verifyToken, (req, res) => {
  db.all(
    `SELECT s.*, u.username, u.display_name, u.avatar, u.is_verified,
            CASE WHEN sv.viewer_id IS NOT NULL THEN 1 ELSE 0 END as is_viewed
     FROM stories s
     JOIN users u ON s.user_id = u.id
     LEFT JOIN follows f ON f.following_id = s.user_id AND f.follower_id = ?
     LEFT JOIN story_views sv ON sv.story_id = s.id AND sv.viewer_id = ?
     WHERE (f.following_id IS NOT NULL OR s.user_id = ?)
       AND datetime(s.expires_at) > datetime('now')
     ORDER BY s.created_at DESC`,
    [req.userId, req.userId, req.userId],
    (err, stories) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Group stories by user
      const grouped = {};
      stories.forEach(story => {
        if (!grouped[story.user_id]) {
          grouped[story.user_id] = {
            user: {
              id: story.user_id,
              username: story.username,
              display_name: story.display_name,
              avatar: story.avatar,
              is_verified: story.is_verified
            },
            stories: []
          };
        }
        grouped[story.user_id].stories.push(story);
      });
      
      res.json(Object.values(grouped));
    }
  );
});

// View story
app.post('/api/stories/:id/view', verifyToken, (req, res) => {
  db.run(
    'INSERT OR IGNORE INTO story_views (story_id, viewer_id) VALUES (?, ?)',
    [req.params.id, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Story viewed' });
    }
  );
});

// ==================== MESSAGE ROUTES ====================

// Send message
app.post('/api/messages', verifyToken, (req, res) => {
  const { receiver_id, content } = req.body;
  if (!receiver_id || !content) {
    return res.status(400).json({ error: 'Receiver and content required' });
  }
  
  db.run(
    'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
    [req.userId, receiver_id, content],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get(
        `SELECT m.*, u1.username as sender_username, u1.display_name as sender_name,
                u2.username as receiver_username, u2.display_name as receiver_name
         FROM messages m
         JOIN users u1 ON m.sender_id = u1.id
         JOIN users u2 ON m.receiver_id = u2.id
         WHERE m.id = ?`,
        [this.lastID],
        (err, message) => {
          if (err) return res.status(500).json({ error: err.message });
          
          // Emit via socket
          io.to(`user_${receiver_id}`).emit('new_message', message);
          
          res.status(201).json(message);
        }
      );
    }
  );
});

// Get messages between users
app.get('/api/messages/:userId', verifyToken, (req, res) => {
  const userId = parseInt(req.params.userId);
  
  db.all(
    `SELECT * FROM messages 
     WHERE (sender_id = ? AND receiver_id = ?) 
        OR (sender_id = ? AND receiver_id = ?)
     ORDER BY created_at ASC`,
    [req.userId, userId, userId, req.userId],
    (err, messages) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Mark messages as read
      db.run(
        'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?',
        [userId, req.userId]
      );
      
      res.json(messages);
    }
  );
});

// Get chat list
app.get('/api/messages/chats', verifyToken, (req, res) => {
  db.all(
    `SELECT DISTINCT 
       CASE 
         WHEN m.sender_id = ? THEN m.receiver_id
         ELSE m.sender_id
       END as user_id,
       u.username, u.display_name, u.avatar, u.is_verified,
       (SELECT content FROM messages WHERE id = m.id) as last_message,
       (SELECT created_at FROM messages WHERE id = m.id) as last_message_time
     FROM messages m
     JOIN users u ON (u.id = m.sender_id OR u.id = m.receiver_id)
     WHERE (m.sender_id = ? OR m.receiver_id = ?)
       AND u.id != ?
     ORDER BY last_message_time DESC`,
    [req.userId, req.userId, req.userId, req.userId],
    (err, chats) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Get unread counts
      const chatPromises = chats.map((chat) => {
        return new Promise((resolve) => {
          db.get(
            'SELECT COUNT(*) as unread FROM messages WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
            [chat.user_id, req.userId],
            (err, result) => {
              resolve({ ...chat, unread: result?.unread || 0 });
            }
          );
        });
      });
      
      Promise.all(chatPromises).then(results => {
        res.json(results);
      });
    }
  );
});

// ==================== SEARCH ====================

app.get('/api/search', (req, res) => {
  const query = req.query.q || '';
  if (!query || query.length < 2) {
    return res.json({ users: [], posts: [] });
  }
  
  const searchTerm = `%${query}%`;
  
  // Search users
  db.all(
    `SELECT id, username, display_name, avatar, is_verified 
     FROM users 
     WHERE username LIKE ? OR display_name LIKE ?
     LIMIT 10`,
    [searchTerm, searchTerm],
    (err, users) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Search posts
      db.all(
        `SELECT p.*, u.username, u.display_name, u.avatar
         FROM posts p
         JOIN users u ON p.user_id = u.id
         WHERE p.content LIKE ?
         ORDER BY p.created_at DESC
         LIMIT 10`,
        [searchTerm],
        (err, posts) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ users, posts });
        }
      );
    }
  );
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  socket.on('authenticate', (userId) => {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} authenticated`);
  });
  
  socket.on('typing', (data) => {
    const { receiver_id, is_typing } = data;
    io.to(`user_${receiver_id}`).emit('typing', {
      sender_id: socket.userId || 0,
      is_typing
    });
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Zen Social API running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server ready`);
});
