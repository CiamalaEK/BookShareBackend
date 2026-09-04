const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mainline.proxy.rlwy.net',
  port: Number(process.env.DB_PORT || 16263),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? 'ghGDyDIVYNRoEuLMVhuZtrwvkdqgYvKw',
  database: process.env.DB_NAME || 'railway',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true
});

let dbReady = false;

async function  ensureSchemaColumns() {
  const [userColumns] = await pool.query('SHOW COLUMNS FROM users');
  const userFields = userColumns.map((column) => column.Field);

  if (!userFields.includes('library_membership_number')) {
    await pool.query('ALTER TABLE users ADD COLUMN library_membership_number VARCHAR(60) NULL AFTER city');
  }

  if (!userFields.includes('phone_number')) {
    await pool.query('ALTER TABLE users ADD COLUMN phone_number VARCHAR(40) NULL AFTER library_membership_number');
  }

  if (!userFields.includes('role')) {
    await pool.query('ALTER TABLE users ADD COLUMN role VARCHAR(40) DEFAULT "member" AFTER phone_number');
  }

  const [requestColumns] = await pool.query('SHOW COLUMNS FROM requests');
  const requestFields = requestColumns.map((column) => column.Field);

  if (!requestFields.includes('delivery_date')) {
    await pool.query('ALTER TABLE requests ADD COLUMN delivery_date DATETIME NULL AFTER due_date');
  }

  if (!requestFields.includes('receipt_date')) {
    await pool.query('ALTER TABLE requests ADD COLUMN receipt_date DATETIME NULL AFTER delivery_date');
  }

  if (!requestFields.includes('loan_duration_days')) {
    await pool.query('ALTER TABLE requests ADD COLUMN loan_duration_days INT DEFAULT 14 AFTER receipt_date');
  }

  const [holdTable] = await pool.query('SHOW TABLES LIKE ?', ['holds']);
  if (!holdTable.length) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS holds (
        id INT AUTO_INCREMENT PRIMARY KEY,
        book_id INT NOT NULL,
        user_id INT NOT NULL,
        status ENUM('queued', 'fulfilled', 'cancelled') DEFAULT 'queued',
        queue_position INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fulfilled_at DATETIME NULL,
        FOREIGN KEY (book_id) REFERENCES books(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
  }
}

async function seedDatabase() {
  try {
    const [userCount] = await pool.query('SELECT COUNT(*) AS total FROM users');
    if (Number(userCount[0].total) > 0) {
      return;
    }

    const passwordHash = await bcrypt.hash('password123', 10);
    const seedUsers = [
      ['Rahul Sharma', 'rahul@example.com', passwordHash, 'Bengaluru'],
      ['Neha Patel', 'neha@example.com', passwordHash, 'Pune'],
      ['Aarav Mehta', 'aarav@example.com', passwordHash, 'Delhi'],
      ['Admin User', 'admin@bookshare.com', passwordHash, 'Mumbai']
    ];

    const [userResults] = await pool.query(
      'INSERT INTO users (name, email, password_hash, city) VALUES ?', [seedUsers]
    );

    // Ensure the seeded admin user has role 'admin'
    await pool.query("UPDATE users SET role = 'admin' WHERE email = 'admin@bookshare.com'");

    const userIds = Array.from({ length: userResults.affectedRows }, (_, index) => index + 1);
    const bookRows = [
      ['The Midnight Library', 'Matt Haig', '978-0-525-55932-2', 'Fiction', 'English', 'Good', 'lend', 'available', userIds[0], 'Bengaluru', 'https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=800&q=80', 14],
      ['Atomic Habits', 'James Clear', '978-0-073-52120-1', 'Self Help', 'English', 'Like New', 'giveaway', 'available', userIds[1], 'Pune', 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?auto=format&fit=crop&w=800&q=80', 0],
      ['Pride and Prejudice', 'Jane Austen', '978-1-853-26452-1', 'Classic', 'English', 'Fair', 'lend', 'borrowed', userIds[2], 'Delhi', 'https://images.unsplash.com/photo-1516979187457-637abb4f9353?auto=format&fit=crop&w=800&q=80', 21],
      ['Clean Code', 'Robert C. Martin', '978-0-13-235088-4', 'Technology', 'English', 'Excellent', 'lend', 'request_pending', userIds[0], 'Bengaluru', 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?auto=format&fit=crop&w=800&q=80', 30]
    ];

    await pool.query(
      `INSERT INTO books (title, author, isbn, category, language, condition_name, sharing_type, status, owner_id, location, image_url, lending_duration_days)
       VALUES ?`, [bookRows]
    );

    await pool.query(
      `INSERT INTO requests (book_id, requester_id, owner_id, status, request_type, due_date)
       VALUES (4, 2, 1, 'pending', 'lend', DATE_ADD(NOW(), INTERVAL 14 DAY))`
    );

    await pool.query(
      `INSERT INTO notifications (user_id, message, type, is_read)
       VALUES
       (1, 'Neha requested to borrow Clean Code', 'request', false),
       (1, 'Your return reminder for The Midnight Library is due soon', 'reminder', false)`
    );

    await pool.query(
      `INSERT INTO shelves (user_id, name, description)
       VALUES
       (1, 'My Book Recommendations of the Month', 'Monthly picks'),
       (1, 'Books You Can Read in One Sitting', 'Short reads'),
       (1, 'Long Books to Get Lost In', 'Long form fiction')`
    );

    await pool.query(
      `INSERT IGNORE INTO shelf_books (shelf_id, book_id) VALUES
       (1, 1), (1, 3), (2, 2), (3, 4)`
    );
    await pool.query(
      `INSERT IGNORE INTO wishlist_items (user_id, book_id) VALUES
       (1, 2), (1, 4)`
    );
  } catch (error) {
    console.warn('Seed data insertion skipped:', error.message);
  }
}

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        city VARCHAR(100),
        library_membership_number VARCHAR(60) NULL,
        phone_number VARCHAR(40) NULL,
        role VARCHAR(40) DEFAULT 'member',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS books (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(180) NOT NULL,
        author VARCHAR(180) NOT NULL,
        isbn VARCHAR(80),
        category VARCHAR(80),
        language VARCHAR(80),
        condition_name VARCHAR(40),
        sharing_type ENUM('giveaway', 'lend') NOT NULL,
        status ENUM('available', 'request_pending', 'approved', 'borrowed', 'return_pending', 'returned', 'given_away') DEFAULT 'available',
        owner_id INT NOT NULL,
        borrowed_by INT NULL,
        borrowed_at DATETIME NULL,
        due_date DATETIME NULL,
        returned_at DATETIME NULL,
        location VARCHAR(120),
        image_url VARCHAR(255),
        lending_duration_days INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id),
        FOREIGN KEY (borrowed_by) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        book_id INT NOT NULL,
        requester_id INT NOT NULL,
        owner_id INT NOT NULL,
        status ENUM('pending', 'approved', 'rejected', 'borrowed', 'return_pending', 'returned') DEFAULT 'pending',
        request_type ENUM('giveaway', 'lend') NOT NULL,
        due_date DATETIME NULL,
        delivery_date DATETIME NULL,
        receipt_date DATETIME NULL,
        loan_duration_days INT DEFAULT 14,
        returned_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id),
        FOREIGN KEY (requester_id) REFERENCES users(id),
        FOREIGN KEY (owner_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        message VARCHAR(255) NOT NULL,
        type VARCHAR(50),
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS holds (
        id INT AUTO_INCREMENT PRIMARY KEY,
        book_id INT NOT NULL,
        user_id INT NOT NULL,
        status ENUM('queued', 'fulfilled', 'cancelled') DEFAULT 'queued',
        queue_position INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fulfilled_at DATETIME NULL,
        FOREIGN KEY (book_id) REFERENCES books(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS shelves (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(180) NOT NULL,
        description VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS shelf_books (
        shelf_id INT NOT NULL,
        book_id INT NOT NULL,
        PRIMARY KEY (shelf_id, book_id),
        FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS wishlist_items (
        user_id INT NOT NULL,
        book_id INT NOT NULL,
        PRIMARY KEY (user_id, book_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );
    `);
      console.log('Database schema ensured successfully.');
    await ensureSchemaColumns();
    await seedDatabase();
 console.log('12321 Database schema ensured successfully.');
    dbReady = true;
    console.log('MySQL database initialized successfully.');
    return true;
  } catch (error) {
    console.warn('MySQL not available. Falling back to demo data mode.');
    console.warn(error.message);
    dbReady = false;
    return false;
  }
}

module.exports = { pool, initializeDatabase, isDbReady: () => dbReady };
