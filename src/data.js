const demoUsers = [
  {
    id: 1,
    name: 'Rahul Sharma',
    email: 'rahul@example.com',
    city: 'Bengaluru',
    password: 'password123'
  },
  {
    id: 2,
    name: 'Neha Patel',
    email: 'neha@example.com',
    city: 'Pune',
    password: 'password123'
  },
  {
    id: 3,
    name: 'Aarav Mehta',
    email: 'aarav@example.com',
    city: 'Delhi',
    password: 'password123'
  }
];

const demoBooks = [
  {
    id: 1,
    title: 'The Midnight Library',
    author: 'Matt Haig',
    isbn: '978-0-525-55932-2',
    category: 'Fiction',
    language: 'English',
    condition: 'Good',
    ownerId: 1,
    ownerName: 'Rahul Sharma',
    status: 'available',
    sharingType: 'lend',
    lendingDurationDays: 14,
    location: 'Bengaluru',
    imageUrl: 'https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=800&q=80'
  },
  {
    id: 2,
    title: 'Atomic Habits',
    author: 'James Clear',
    isbn: '978-0-073-52120-1',
    category: 'Self Help',
    language: 'English',
    condition: 'Like New',
    ownerId: 2,
    ownerName: 'Neha Patel',
    status: 'available',
    sharingType: 'giveaway',
    lendingDurationDays: 0,
    location: 'Pune',
    imageUrl: 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?auto=format&fit=crop&w=800&q=80'
  },
  {
    id: 3,
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    isbn: '978-1-853-26452-1',
    category: 'Classic',
    language: 'English',
    condition: 'Fair',
    ownerId: 3,
    ownerName: 'Aarav Mehta',
    status: 'borrowed',
    sharingType: 'lend',
    lendingDurationDays: 21,
    location: 'Delhi',
    imageUrl: 'https://images.unsplash.com/photo-1516979187457-637abb4f9353?auto=format&fit=crop&w=800&q=80'
  },
  {
    id: 4,
    title: 'Clean Code',
    author: 'Robert C. Martin',
    isbn: '978-0-13-235088-4',
    category: 'Technology',
    language: 'English',
    condition: 'Excellent',
    ownerId: 1,
    ownerName: 'Rahul Sharma',
    status: 'request_pending',
    sharingType: 'lend',
    lendingDurationDays: 30,
    location: 'Bengaluru',
    imageUrl: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?auto=format&fit=crop&w=800&q=80'
  }
];

const demoRequests = [
  {
    id: 1,
    bookId: 4,
    bookTitle: 'Clean Code',
    requesterId: 2,
    requesterName: 'Neha Patel',
    ownerId: 1,
    ownerName: 'Rahul Sharma',
    status: 'pending',
    requestType: 'lend'
  },
  {
    id: 2,
    bookId: 3,
    bookTitle: 'Pride and Prejudice',
    requesterId: 1,
    requesterName: 'Rahul Sharma',
    ownerId: 3,
    ownerName: 'Aarav Mehta',
    status: 'approved',
    requestType: 'lend'
  }
];

const demoNotifications = [
  {
    id: 1,
    userId: 1,
    message: 'Neha requested to borrow Clean Code',
    read: false,
    type: 'request'
  },
  {
    id: 2,
    userId: 1,
    message: 'Your return reminder for The Midnight Library is due soon',
    read: false,
    type: 'reminder'
  }
];

module.exports = { demoUsers, demoBooks, demoRequests, demoNotifications };
