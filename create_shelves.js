const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mainline.proxy.rlwy.net',
    port: Number(process.env.DB_PORT || 16263),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME || 'railway',
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    multipleStatements: true
  });


  try {
    await pool.query(`
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
    `);

    console.log('shelves and shelf_books tables created or already exist.');
    process.exit(0);
  } catch (err) {
    console.error('Error creating tables:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
