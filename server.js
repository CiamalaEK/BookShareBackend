const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { pool, initializeDatabase, isDbReady } = require('./src/db');

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
  const [rows] = await pool.query('SELECT * FROM users');
  return rows.map((user) => ({ ...user, password_hash: undefined }));
};

const readBooks = async () => {
  const [rows] = await pool.query(`
    SELECT b.*, u.name AS owner_name
    FROM books b
    JOIN users u ON u.id = b.owner_id
  `);
  return rows;
};

const readRequests = async () => {
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
  const [rows] = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
  return rows;
};

const readHolds = async () => {
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
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const books = await readBooks();
  res.json(books);
});

app.get('/api/books/:id', async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const books = await readBooks();
  const book = books.find((item) => item.id === Number(req.params.id));

  if (!book) {
    return res.status(404).json({ message: 'Book not found' });
  }

  res.json(book);
});

app.get('/api/requests', async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const requests = await readRequests();
  res.json(requests);
});

app.get('/api/notifications', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  const notifications = await readNotifications();
  res.json(notifications);
});

app.get('/api/holds', authenticate, async (req, res) => {
  if (!isDbReady()) {
    return requireDatabase(res);
  }

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
  if (!isDbReady()) {
    return requireDatabase(res);
  }

  try {
    const baseAlerts = await readNotifications();
    const dynamicAlerts = await buildDueDateAlerts(req.user.id);
    const filteredBase = baseAlerts.filter((item) => Number(item.user_id) === Number(req.user.id));
    res.json([...filteredBase, ...dynamicAlerts]);
  } catch (error) {
    res.status(500).json({ message: 'Alerts generation failed', error: error.message });
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
