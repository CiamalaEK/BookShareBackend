CREATE DATABASE IF NOT EXISTS bookshare;
USE bookshare;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  city VARCHAR(100),
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
  location VARCHAR(120),
  image_url VARCHAR(255),
  lending_duration_days INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  book_id INT NOT NULL,
  requester_id INT NOT NULL,
  owner_id INT NOT NULL,
  status ENUM('pending', 'approved', 'rejected', 'borrowed', 'returned') DEFAULT 'pending',
  request_type ENUM('giveaway', 'lend') NOT NULL,
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
