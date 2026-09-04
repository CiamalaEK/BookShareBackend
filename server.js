const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { pool, initializeDatabase, isDbReady } = require('./src/db');
const { demoUsers, demoBooks, demoRequests, demoNotifications } = require('./src/data');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'bookshare-secret-key';
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1000)}${ext}`);
  }
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadDir));

const generateToken = (user) => jwt.sign(
  {
    id: user.id,
    email: user.email,
    libraryMembershipNumber: user.libraryMembershipNumber || user.library_membership_number || null,
    phoneNumber: user.phoneNumber || user.phone_number || null
  },
  JWT_SECRET,
  { expiresIn: '7d' }
);

const normalizeUserRecord = (user = {}) => ({
  ...user,
  id: Number(user.id),
  libraryMembershipNumber: user.libraryMembershipNumber ?? user.library_membership_number ?? null,
  phoneNumber: user.phoneNumber ?? user.phone_number ?? null,
  role: user.role || 'member'
});

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

const requireDatabase = (res) => {
  if (!isDbReady()) {
    return res.status(503).json({ message: 'Database is not available. Please configure MySQL and restart the app.' });
  }
  return null;
};

const readUsers = async () => {
  if (!isDbReady()) {
    return demoUsers.map((user) => ({ ...user, password_hash: undefined }));
  }

  const [rows] = await pool.query('SELECT * FROM users');
  return rows.map((user) => ({ ...user, password_hash: undefined }));
};

const readBooks = async () => {
  if (!isDbReady()) {
    return demoBooks;
  }

  const [rows] = await pool.query(`
    SELECT b.*, u.name AS owner_name
    FROM books b
    JOIN users u ON u.id = b.owner_id
  `);
  return rows;
};

const readRequests = async () => {
  if (!isDbReady()) {
    return demoRequests;
  }

  const [rows] = await pool.query(`
    SELECT r.*, b.title AS book_title, u1.name AS requester_name, u2.name AS owner_name
    FROM requests r
    JOIN books b ON b.id = r.book_id
    JOIN users u1 ON u1.id = r.requester_id
    JOIN users u2 ON u2.id = r.owner_id
  `);
  return rows;
};

const readNotifications = async () => {
  if (!isDbReady()) {
    return demoNotifications;
  }

  const [rows] = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
  return rows;
};

const readHolds = async () => {
  if (!isDbReady()) {
    return [];
  }

  const [rows] = await pool.query(`
    SELECT h.*, b.title AS book_title, u.name AS user_name
    FROM holds h
    JOIN books b ON b.id = h.book_id
    JOIN users u ON u.id = h.user_id
    ORDER BY h.created_at ASC
  `);
  return rows;
};

const reindexHoldQueue = async (bookId) => {
  const [rows] = await pool.query(
    'SELECT id FROM holds WHERE book_id = ? AND status = "queued" ORDER BY created_at ASC, id ASC',
    [bookId]
  );

  for (let index = 0; index < rows.length; index += 1) {
    await pool.query('UPDATE holds SET queue_position = ? WHERE id = ?', [index + 1, rows[index].id]);
  }
};

const buildDueDateAlerts = async (userId) => {
  const [rows] = await pool.query(`
    SELECT r.*, b.title AS book_title, u1.name AS requester_name, u2.name AS owner_name
    FROM requests r
    JOIN books b ON b.id = r.book_id
    JOIN users u1 ON u1.id = r.requester_id
    JOIN users u2 ON u2.id = r.owner_id
    WHERE r.status = 'approved'
      AND r.due_date IS NOT NULL
      AND (r.requester_id = ? OR r.owner_id = ?)
  `, [userId, userId]);

  const alerts = [];
  const today = new Date();

  rows.forEach((request) => {
    const dueDate = new Date(request.due_date);
    const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

    if (diffDays <= 2 && diffDays >= -7) {
      alerts.push({
        id: `alert-${request.id}`,
        userId,
        message: diffDays < 0
          ? `${request.book_title} is overdue by ${Math.abs(diffDays)} day(s).`
          : `${request.book_title} is due in ${diffDays} day(s).`,
        type: diffDays < 0 ? 'overdue' : 'reminder',
        is_read: false,
        created_at: new Date().toISOString()
      });
    }
  });

  return alerts;
};

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: isDbReady() ? 'mysql' : 'not-ready' });
});

app.post('/api/register', async (req, res) => {
  const { name, email, password, city, libraryMembershipNumber, membershipNumber, phoneNumber, phone } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  if (!isDbReady()) {
    return requireDatabase(res);
  }

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(409).json({ message: 'User already exists' });
    }

    const membershipValue = (libraryMembershipNumber || membershipNumber || `LIB-${Date.now().toString().slice(-6)}`).trim();
    const phoneValue = (phoneNumber || phone || '').trim();
    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, city, library_membership_number, phone_number, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, email, passwordHash, city || '', membershipValue, phoneValue, 'member']
    );

    const user = {
      id: result.insertId,
      name,
      email,
      city: city || '',
      libraryMembershipNumber: membershipValue,
      phoneNumber: phoneValue,
      role: 'member'
    };
    res.status(201).json({ message: 'User created successfully', token: generateToken(user), user });
  } catch (error) {
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

app.get('/api/me', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, city, library_membership_number, phone_number, role FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(normalizeUserRecord(rows[0]));
  } catch (error) {
    res.status(500).json({ message: 'Profile load failed', error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  if (!isDbReady()) {
    return requireDatabase(res);
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const safeUser = normalizeUserRecord(user);
    res.json({ token: generateToken(safeUser), user: safeUser });
  } catch (error) {
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

app.get('/api/users', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const users = await readUsers();
  res.json(users.map(normalizeUserRecord));
});

app.get('/api/books', async (req, res) => {
  const books = await readBooks();
  res.json(books);
});

app.get('/api/books/:id', async (req, res) => {
  const books = await readBooks();
  const book = books.find((item) => Number(item.id) === Number(req.params.id));

  if (!book) {
    return res.status(404).json({ message: 'Book not found' });
  }

  res.json(book);
});

app.get('/api/requests', async (req, res) => {
  const requests = await readRequests();
  res.json(requests);
});

app.get('/api/notifications', authenticate, async (req, res) => {
  const notifications = await readNotifications();
  // filter to the authenticated user if possible
  if (Array.isArray(notifications) && notifications.length && notifications[0].userId !== undefined) {
    const filtered = notifications.filter((n) => Number(n.userId ?? n.user_id) === Number(req.user.id));
    return res.json(filtered);
  }
  res.json(notifications);
});

app.get('/api/holds', authenticate, async (req, res) => {
  const holds = await readHolds();
  res.json(holds);
});

app.get('/api/admin/summary', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  try {
    const [booksRows] = await pool.query('SELECT COUNT(*) AS total FROM books');
    const [membersRows] = await pool.query('SELECT COUNT(*) AS total FROM users');
    const [pendingRows] = await pool.query('SELECT COUNT(*) AS total FROM requests WHERE status IN ("pending", "approved", "borrowed", "return_pending")');
    const [overdueRows] = await pool.query('SELECT COUNT(*) AS total FROM requests WHERE status IN ("approved", "borrowed") AND due_date IS NOT NULL AND due_date < NOW()');
    const [holdRows] = await pool.query('SELECT COUNT(*) AS total FROM holds WHERE status = "queued"');

    const requestSummary = {
      totalBooks: Number(booksRows[0].total || 0),
      totalMembers: Number(membersRows[0].total || 0),
      activeLoans: Number(pendingRows[0].total || 0),
      overdueBooks: Number(overdueRows[0].total || 0),
      queuedHolds: Number(holdRows[0].total || 0)
    };

    res.json(requestSummary);
  } catch (error) {
    res.status(500).json({ message: 'Dashboard summary unavailable', error: error.message });
  }
});

app.post('/api/holds', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const { bookId, userId } = req.body;
  const safeBookId = Number(bookId);
  const safeUserId = Number(userId || req.user.id);

  if (!safeBookId) {
    return res.status(400).json({ message: 'Book ID is required.' });
  }

  try {
    const [bookRows] = await pool.query('SELECT * FROM books WHERE id = ?', [safeBookId]);
    const book = bookRows[0];

    if (!book) {
      return res.status(404).json({ message: 'Book not found.' });
    }

    const [existing] = await pool.query(
      'SELECT * FROM holds WHERE book_id = ? AND user_id = ? AND status IN ("queued", "fulfilled")',
      [safeBookId, safeUserId]
    );

    if (existing.length) {
      return res.status(409).json({ message: 'You already have a hold for this title.', hold: existing[0] });
    }

    const [rows] = await pool.query(
      'SELECT * FROM holds WHERE book_id = ? AND status = "queued" ORDER BY created_at ASC, id ASC',
      [safeBookId]
    );
    const queuePosition = rows.length + 1;

    const [result] = await pool.query(
      'INSERT INTO holds (book_id, user_id, status, queue_position) VALUES (?, ?, "queued", ?)',
      [safeBookId, safeUserId, queuePosition]
    );

    const [holdRows] = await pool.query('SELECT * FROM holds WHERE id = ?', [result.insertId]);
    res.status(201).json(holdRows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Hold queue update failed.', error: error.message });
  }
});

app.post('/api/holds/:id/fulfill', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  try {
    const [rows] = await pool.query('SELECT * FROM holds WHERE id = ?', [req.params.id]);
    const hold = rows[0];

    if (!hold) {
      return res.status(404).json({ message: 'Hold not found.' });
    }

    await pool.query(
      'UPDATE holds SET status = "fulfilled", fulfilled_at = NOW(), queue_position = 0 WHERE id = ?',
      [hold.id]
    );

    await reindexHoldQueue(hold.book_id);

    res.json({ message: 'Hold fulfilled successfully.', holdId: hold.id });
  } catch (error) {
    res.status(500).json({ message: 'Hold fulfillment failed.', error: error.message });
  }
});

app.get('/api/alerts', authenticate, async (req, res) => {
  try {
    const baseAlerts = await readNotifications();
    const dynamicAlerts = isDbReady() ? await buildDueDateAlerts(req.user.id) : [];
    const filteredBase = Array.isArray(baseAlerts) ? baseAlerts.filter((item) => Number(item.userId ?? item.user_id) === Number(req.user.id)) : [];
    res.json([...filteredBase, ...dynamicAlerts]);
  } catch (error) {
    res.status(500).json({ message: 'Alerts generation failed', error: error.message });
  }
});

// Admin data export: returns all core datasets for admin users
app.get('/api/admin/data', authenticate, async (req, res) => {
  if (!isDbReady()) return requireDatabase(res);

  try {
    // Verify role from database
    const [urows] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    const role = urows[0]?.role || 'member';
    if (role !== 'admin') return res.status(403).json({ message: 'Forbidden: admin only' });

    const [users] = await pool.query('SELECT id, name, email, city, library_membership_number, phone_number, role, created_at FROM users ORDER BY id ASC');
    const [books] = await pool.query('SELECT b.*, u.name AS owner_name FROM books b JOIN users u ON u.id = b.owner_id ORDER BY b.id ASC');
    const [requests] = await pool.query('SELECT r.*, b.title AS book_title, u1.name AS requester_name, u2.name AS owner_name FROM requests r JOIN books b ON b.id = r.book_id JOIN users u1 ON u1.id = r.requester_id JOIN users u2 ON u2.id = r.owner_id ORDER BY r.id ASC');
    const [holds] = await pool.query('SELECT h.*, b.title AS book_title, u.name AS user_name FROM holds h JOIN books b ON b.id = h.book_id JOIN users u ON u.id = h.user_id ORDER BY h.id ASC');
    const [shelves] = await pool.query('SELECT * FROM shelves ORDER BY id ASC');
    // attach shelf books
    for (const shelf of shelves) {
      const [sbooks] = await pool.query('SELECT b.* FROM books b JOIN shelf_books sb ON sb.book_id = b.id WHERE sb.shelf_id = ?', [shelf.id]);
      shelf.books = sbooks;
    }
    const [notifications] = await pool.query('SELECT * FROM notifications ORDER BY id DESC');
    const [wishlist_items] = await pool.query('SELECT * FROM wishlist_items ORDER BY user_id ASC');

    res.json({ users, books, requests, holds, shelves, notifications, wishlist_items });
  } catch (error) {
    res.status(500).json({ message: 'Admin export failed', error: error.message });
  }
});

// Shelves endpoints: create, list, get, and add/remove books
app.get('/api/shelves', authenticate, async (req, res) => {
  if (!isDbReady()) {
    // DB not available — return empty shelves list to avoid 503 for read-only calls
    return res.json([]);
  }

  try {
    const userId = Number(req.user.id);
    const [shelves] = await pool.query('SELECT * FROM shelves WHERE user_id = ? ORDER BY created_at DESC', [userId]);

    const result = [];
    for (const shelf of shelves) {
      const [books] = await pool.query(
        `SELECT b.* FROM books b JOIN shelf_books sb ON sb.book_id = b.id WHERE sb.shelf_id = ?`,
        [shelf.id]
      );
      result.push({ ...shelf, books });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Unable to load shelves', error: error.message });
  }
});

app.get('/api/shelves/:id', authenticate, async (req, res) => {
  if (!isDbReady()) {
    // DB not available — return not found (no shelves in demo mode)
    return res.status(404).json({ message: 'Shelf not found' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM shelves WHERE id = ?', [req.params.id]);
    const shelf = rows[0];
    if (!shelf) return res.status(404).json({ message: 'Shelf not found' });
    if (Number(shelf.user_id) !== Number(req.user.id)) return res.status(403).json({ message: 'Forbidden' });

    const [books] = await pool.query('SELECT b.* FROM books b JOIN shelf_books sb ON sb.book_id = b.id WHERE sb.shelf_id = ?', [shelf.id]);
    res.json({ ...shelf, books });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load shelf', error: error.message });
  }
});

app.post('/api/shelves', authenticate, async (req, res) => {
  console.log('Creating shelf with request body:', req.body);
  if (!isDbReady()) return requireDatabase(res);

  const { name, description, bookIds } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: 'Shelf name is required' });

  try {
    const [result] = await pool.query('INSERT INTO shelves (user_id, name, description) VALUES (?, ?, ?)', [req.user.id, name.trim(), description || null]);
    const shelfId = result.insertId;

    if (Array.isArray(bookIds) && bookIds.length) {
      const values = bookIds.map((bid) => [shelfId, Number(bid)]);
      await pool.query('INSERT IGNORE INTO shelf_books (shelf_id, book_id) VALUES ?', [values]);
    }

    const [rows] = await pool.query('SELECT * FROM shelves WHERE id = ?', [shelfId]);
    const shelf = rows[0];
    const [books] = await pool.query('SELECT b.* FROM books b JOIN shelf_books sb ON sb.book_id = b.id WHERE sb.shelf_id = ?', [shelfId]);
    res.status(201).json({ ...shelf, books });
  } catch (error) {
    res.status(500).json({ message: 'Unable to create shelf', error: error.message });
  }
});

app.post('/api/shelves/:id/books', authenticate, async (req, res) => {
  if (!isDbReady()) return requireDatabase(res);

  const shelfId = Number(req.params.id);
  const { bookId, add } = req.body;

  if (!shelfId || !bookId) return res.status(400).json({ message: 'Shelf ID and book ID required' });

  try {
    const [rows] = await pool.query('SELECT * FROM shelves WHERE id = ?', [shelfId]);
    const shelf = rows[0];
    if (!shelf) return res.status(404).json({ message: 'Shelf not found' });
    if (Number(shelf.user_id) !== Number(req.user.id)) return res.status(403).json({ message: 'Forbidden' });

    if (add) {
      await pool.query('INSERT IGNORE INTO shelf_books (shelf_id, book_id) VALUES (?, ?)', [shelfId, Number(bookId)]);
    } else {
      await pool.query('DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?', [shelfId, Number(bookId)]);
    }

    const [books] = await pool.query('SELECT b.* FROM books b JOIN shelf_books sb ON sb.book_id = b.id WHERE sb.shelf_id = ?', [shelfId]);
    res.json({ ...shelf, books });
  } catch (error) {
    res.status(500).json({ message: 'Unable to update shelf books', error: error.message });
  }
});

// Server-side advanced search endpoint
app.get('/api/search', async (req, res) => {
  if (!isDbReady()) {
    // return demo filtered results when DB not ready
    const demo = demoBooks || [];
    // very small server-side-like filtering for demo mode
    const q = (req.query.q || '').toLowerCase();
    const filtered = demo.filter((b) => {
      if (!q) return true;
      return (`${b.title} ${b.author} ${b.isbn || ''} ${b.category || ''}`).toLowerCase().includes(q);
    });
    res.setHeader('X-Total-Count', String(filtered.length));
    return res.json(filtered);
  }

  try {
    const {
      q = '', title = '', author = '', isbn = '', category = '', publisher = '', language = '', genre = '', tags = '', member = '', availability = '', filter = '', limit = 50, offset = 0
    } = req.query;

    const where = [];
    const params = [];

    if (q) {
      where.push('(b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.category LIKE ? OR u.name LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    if (title) { where.push('b.title LIKE ?'); params.push(`%${title}%`); }
    if (author) { where.push('b.author LIKE ?'); params.push(`%${author}%`); }
    if (isbn) { where.push('b.isbn LIKE ?'); params.push(`%${isbn}%`); }
    if (category) { where.push('b.category LIKE ?'); params.push(`%${category}%`); }
    if (publisher) { where.push('b.publisher LIKE ?'); params.push(`%${publisher}%`); }
    if (language) { where.push('b.language LIKE ?'); params.push(`%${language}%`); }
    if (genre) { where.push('(b.genre LIKE ? OR b.category LIKE ?)'); params.push(`%${genre}%`, `%${genre}%`); }
    if (tags) { where.push('b.tags LIKE ?'); params.push(`%${tags}%`); }
    if (member) { where.push('u.name LIKE ?'); params.push(`%${member}%`); }
    if (availability) {
      if (availability === 'available') where.push("b.status = 'available'");
      if (availability === 'issued') where.push("b.status <> 'available'");
    }

    // base select with popularity subqueries
    let sql = `SELECT b.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM requests r WHERE r.book_id = b.id) AS request_count,
      (SELECT COUNT(*) FROM holds h WHERE h.book_id = b.id) AS hold_count
      FROM books b
      JOIN users u ON u.id = b.owner_id`;

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;

    // sorting
    if (filter === 'most_borrowed') {
      sql += ' ORDER BY request_count DESC';
    } else if (filter === 'most_popular') {
      sql += ' ORDER BY (request_count + hold_count) DESC';
    } else if (filter === 'recent') {
      sql += ' ORDER BY b.created_at DESC';
    } else if (filter === 'new') {
      // keep default ordering but limit will naturally show new ones
      sql += ' ORDER BY b.created_at DESC';
    } else {
      sql += ' ORDER BY b.title ASC';
    }

    // prepare count query (same WHERE but without subselects/ordering/limit)
    const paramsForCount = params.slice();

    sql += ' LIMIT ? OFFSET ?';
    params.push(Number(limit) || 50, Number(offset) || 0);

    const [rows] = await pool.query(sql, params);

    // build count SQL
    let countSql = `SELECT COUNT(*) AS total FROM books b JOIN users u ON u.id = b.owner_id`;
    if (where.length) countSql += ` WHERE ${where.join(' AND ')}`;
    const [countRows] = await pool.query(countSql, paramsForCount);
    const total = Number((countRows[0] && countRows[0].total) || 0);
    res.setHeader('X-Total-Count', String(total));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Search failed', error: error.message });
  }
});

// Wishlist endpoints: list and add/remove items
app.get('/api/wishlist', authenticate, async (req, res) => {
  if (!isDbReady()) return res.json([]);
  try {
    const userId = Number(req.user.id);
    const [rows] = await pool.query(
      `SELECT b.* FROM books b JOIN wishlist_items w ON w.book_id = b.id WHERE w.user_id = ? ORDER BY b.title ASC`,
      [userId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Unable to load wishlist', error: error.message });
  }
});

app.post('/api/wishlist', authenticate, async (req, res) => {
  if (!isDbReady()) return requireDatabase(res);
  const { bookId, add } = req.body;
  const userId = Number(req.user.id);
  if (!bookId) return res.status(400).json({ message: 'Book ID required' });

  try {
    const [bookRows] = await pool.query('SELECT id FROM books WHERE id = ?', [Number(bookId)]);
    if (!bookRows.length) return res.status(404).json({ message: 'Book not found' });

    if (add) {
      await pool.query('INSERT IGNORE INTO wishlist_items (user_id, book_id) VALUES (?, ?)', [userId, Number(bookId)]);
    } else {
      await pool.query('DELETE FROM wishlist_items WHERE user_id = ? AND book_id = ?', [userId, Number(bookId)]);
    }

    const [rows] = await pool.query('SELECT b.* FROM books b JOIN wishlist_items w ON w.book_id = b.id WHERE w.user_id = ?', [userId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Unable to update wishlist', error: error.message });
  }
});

app.post('/api/books', authenticate, upload.single('image'), async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const {
    title,
    author,
    isbn,
    category,
    language,
    condition,
    sharingType,
    ownerId,
    location,
    imageUrl,
    lendingDurationDays
  } = req.body;

  const uploadedImage = req.file ? `/uploads/${req.file.filename}` : imageUrl || '';

  if (!title || !author || !ownerId) {
    return res.status(400).json({ message: 'Book title, author and owner are required.' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO books (title, author, isbn, category, language, condition_name, sharing_type, status, owner_id, location, image_url, lending_duration_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        title,
        author,
        isbn || '',
        category || 'General',
        language || 'English',
        condition || 'Good',
        sharingType || 'lend',
        'available',
        ownerId,
        location || '',
        uploadedImage || '',
        Number(lendingDurationDays || 0)
      ]
    );

    const [rows] = await pool.query('SELECT * FROM books WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Book creation failed', error: error.message });
  }
});

app.post('/api/requests', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const { bookId, requesterId, ownerId, requestType } = req.body;

  if (!bookId) {
    return res.status(400).json({ message: 'Book ID is required.' });
  }

  try {
    const [bookRows] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);
    const book = bookRows[0];

    if (!book) {
      return res.status(404).json({ message: 'Book not found.' });
    }

    const safeRequesterId = Number(requesterId || req.user.id);
    const safeOwnerId = Number(ownerId || book.owner_id);

    if (!safeRequesterId || !safeOwnerId) {
      return res.status(400).json({ message: 'Missing request information.' });
    }

    const [memberRows] = await pool.query('SELECT id, role FROM users WHERE id = ?', [safeRequesterId]);
    const requesterRole = memberRows[0]?.role || 'member';

    if (requesterRole !== 'admin' && Number(safeRequesterId) === Number(safeOwnerId)) {
      return res.status(400).json({ message: 'You cannot request your own book.' });
    }

    if (Number(safeRequesterId) === Number(safeOwnerId)) {
      return res.status(400).json({ message: 'You cannot request your own book.' });
    }

    const [existing] = await pool.query(
      'SELECT id FROM requests WHERE book_id = ? AND requester_id = ? AND status IN ("pending", "approved")',
      [bookId, safeRequesterId]
    );

    if (existing.length) {
      return res.status(409).json({ message: 'You already have an active request for this book.' });
    }

    const [result] = await pool.query(
      'INSERT INTO requests (book_id, requester_id, owner_id, request_type, status) VALUES (?, ?, ?, ?, ?)',
      [bookId, safeRequesterId, safeOwnerId, requestType || 'lend', 'pending']
    );

    const [existingHold] = await pool.query(
      'SELECT * FROM holds WHERE book_id = ? AND user_id = ? AND status IN ("queued", "fulfilled")',
      [bookId, safeRequesterId]
    );

    if (!existingHold.length) {
      const [queuedRows] = await pool.query(
        'SELECT * FROM holds WHERE book_id = ? AND status = "queued" ORDER BY created_at ASC, id ASC',
        [bookId]
      );
      const queuePosition = queuedRows.length + 1;

      await pool.query(
        'INSERT INTO holds (book_id, user_id, status, queue_position) VALUES (?, ?, "queued", ?)',
        [bookId, safeRequesterId, queuePosition]
      );
    }

    const [rows] = await pool.query('SELECT * FROM requests WHERE id = ?', [result.insertId]);
    const [holdRows] = await pool.query(
      'SELECT * FROM holds WHERE book_id = ? AND user_id = ? AND status = "queued" ORDER BY created_at ASC, id ASC LIMIT 1',
      [bookId, safeRequesterId]
    );

    res.status(201).json({
      ...rows[0],
      queue_position: holdRows[0]?.queue_position || 1
    });
  } catch (error) {
    res.status(500).json({ message: 'Request creation failed', error: error.message });
  }
});

app.post('/api/books/import', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const payload = Array.isArray(req.body) ? req.body : req.body?.books || [];

  if (!payload.length) {
    return res.status(400).json({ message: 'At least one Book Buddy record is required for import.' });
  }

  try {
    const imported = [];

    for (const item of payload) {
      const title = item.title || item.book_title || item.Title;
      const author = item.author || item.author_name || item.Author || 'Unknown author';

      if (!title || !author) {
        continue;
      }

      const [result] = await pool.query(
        `INSERT INTO books (title, author, isbn, category, language, condition_name, sharing_type, status, owner_id, location, image_url, lending_duration_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          title,
          author,
          item.isbn || item.ISBN || '',
          item.category || item.genre || 'General',
          item.language || 'English',
          item.condition || item.condition_name || 'Good',
          item.sharing_type || item.sharingType || 'lend',
          item.status || 'available',
          Number(item.owner_id || item.ownerId || req.user.id),
          item.location || item.city || '',
          item.image_url || item.imageUrl || '',
          Number(item.lending_duration_days || item.lendingDurationDays || 14)
        ]
      );

      const [rows] = await pool.query('SELECT * FROM books WHERE id = ?', [result.insertId]);
      imported.push(rows[0]);
    }

    res.status(201).json({ imported: imported.length, books: imported });
  } catch (error) {
    res.status(500).json({ message: 'Book Buddy import failed.', error: error.message });
  }
});

app.patch('/api/requests/:id', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const { status, dueDate, deliveryDate, receiptDate, loanDurationDays } = req.body;

  if (!status) {
    return res.status(400).json({ message: 'Status is required.' });
  }

  try {
    const updateParts = ['status = ?'];
    const updateValues = [status];

    if (dueDate) {
      updateParts.push('due_date = ?');
      updateValues.push(dueDate);
    }

    if (deliveryDate) {
      updateParts.push('delivery_date = ?');
      updateValues.push(deliveryDate);
    }

    if (receiptDate) {
      updateParts.push('receipt_date = ?');
      updateValues.push(receiptDate);
    }

    if (loanDurationDays) {
      updateParts.push('loan_duration_days = ?');
      updateValues.push(loanDurationDays);
    }

    updateValues.push(req.params.id);

    const [result] = await pool.query(
      `UPDATE requests SET ${updateParts.join(', ')} WHERE id = ?`,
      updateValues
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Request not found' });
    }

    const [rows] = await pool.query('SELECT * FROM requests WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Request update failed', error: error.message });
  }
});

app.post('/api/requests/:id/return', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const { userId } = req.body;

  try {
    const [rows] = await pool.query('SELECT * FROM requests WHERE id = ?', [req.params.id]);
    const request = rows[0];

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    const [bookRows] = await pool.query('SELECT * FROM books WHERE id = ?', [request.book_id]);
    const book = bookRows[0];

    await pool.query(
      'UPDATE books SET status = ?, borrowed_by = NULL, borrowed_at = NULL, due_date = NULL, returned_at = NOW() WHERE id = ?',
      ['available', request.book_id]
    );

    await pool.query(
      'UPDATE requests SET status = ?, returned_at = NOW() WHERE id = ?',
      ['returned', req.params.id]
    );

    const [queuedHolds] = await pool.query(
      'SELECT * FROM holds WHERE book_id = ? AND status = "queued" ORDER BY queue_position ASC, created_at ASC LIMIT 1',
      [request.book_id]
    );

    if (queuedHolds.length) {
      const nextHold = queuedHolds[0];
      await pool.query(
        'UPDATE holds SET status = "fulfilled", fulfilled_at = NOW(), queue_position = 0 WHERE id = ?',
        [nextHold.id]
      );
      await reindexHoldQueue(request.book_id);
      await pool.query(
        'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
        [nextHold.user_id, `You are next in line for ${book.title}. Please arrange pickup.`, 'hold']
      );
    }

    await pool.query(
      'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
      [userId || request.owner_id, `Book return confirmed for ${book.title}`, 'return']
    );

    res.json({ message: 'Book returned successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Return processing failed', error: error.message });
  }
});

app.post('/api/notifications', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const { userId, message, type } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ message: 'User ID and message are required.' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
      [userId, message, type || 'info']
    );

    const [rows] = await pool.query('SELECT * FROM notifications WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Notification creation failed', error: error.message });
  }
});

(async () => {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`BookShare API running on http://localhost:${PORT}`);
  });
})();
