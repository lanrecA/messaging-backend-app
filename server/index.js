const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: 'http://localhost:3000', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = 'your-secret-key-change-this-in-production';

// =======================
// SIGN UP
// =======================
app.post('/api/signup', async (req, res) => {
    const { firstName, lastName, contact, password } = req.body;

    if (!firstName || !lastName || !contact || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run(
            `INSERT INTO users (first_name, last_name, contact_identifier, password_hash)
       VALUES (?, ?, ?, ?)`,
            [firstName, lastName, contact, hashedPassword],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(409).json({ error: 'Email or mobile number already registered' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }

                res.status(201).json({
                    message: 'User registered successfully',
                    userId: this.lastID
                });
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =======================
// SIGN IN
// =======================
app.post('/api/login', (req, res) => {
    const { contact, password } = req.body;

    if (!contact || !password) {
        return res.status(400).json({ error: 'Contact and password required' });
    }

    db.get(
        `SELECT * FROM users WHERE contact_identifier = ?`,
        [contact],
        async (err, user) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (!user) return res.status(401).json({ error: 'Invalid credentials' });

            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) return res.status(401).json({ error: 'Invalid credentials' });

            const token = jwt.sign(
                { userId: user.id, username: `${user.first_name} ${user.last_name}`, contact: user.contact_identifier },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            res.json({ token, user: { id: user.id, firstName: user.first_name, lastName: user.last_name, contact: user.contact_identifier } });
        }
    );
});

// =======================
// SEARCH USERS (by mobile or email)
// =======================
app.get('/api/search-users', (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'Search query required' });

    db.all(
        `SELECT id, first_name, last_name, contact_identifier 
     FROM users 
     WHERE contact_identifier LIKE ? 
     LIMIT 10`,
        [`%${query}%`],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(rows);
        }
    );
});

// =======================
// ADD CONTACT
// =======================
app.post('/api/contacts', (req, res) => {
    const { userId, contactUserId } = req.body;

    if (!userId || !contactUserId) {
        return res.status(400).json({ error: 'userId and contactUserId required' });
    }

    db.run(
        `INSERT OR IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)`,
        [userId, contactUserId],
        function (err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ message: 'Contact added', contactId: contactUserId });
        }
    );
});

// =======================
// GET USER'S CONTACTS
// =======================
app.get('/api/contacts/:userId', (req, res) => {
    const { userId } = req.params;

    db.all(
        `SELECT u.id, u.first_name, u.last_name, u.contact_identifier,
            c.added_at
     FROM contacts c
     JOIN users u ON c.contact_user_id = u.id
     WHERE c.user_id = ?`,
        [userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(rows);
        }
    );
});

// Socket.IO remains the same (or adapt to private messaging as before)
// ...

// io.on('connection', (socket) => {
//     console.log(`User connected: ${socket.id}`);
//
//     // Set username (from frontend after login)
//     socket.on('set username', (username) => {
//         if (!username) return socket.emit('error', 'Username required');
//         users.set(socket.id, { username, online: true });
//         io.emit('user list', Array.from(users.values()).map(u => u.username));
//         socket.broadcast.emit('notification', `${username} joined`);
//     });
//
//     // Broadcast message
//     socket.on('chat message', (msg) => {
//         const user = users.get(socket.id);
//         if (!user) return socket.emit('error', 'Not authenticated');
//         const messageData = {
//             username: user.username,
//             text: msg,
//             timestamp: new Date().toISOString(),
//         };
//         console.log(JSON.stringify(messageData));
//         io.emit('chat message', messageData); // Global broadcast; use socket.to(room) for private
//     });
//
//     // Handle disconnect
//     socket.on('disconnect', () => {
//         const user = users.get(socket.id);
//         if (user) {
//             io.emit('notification', `${user.username} left`);
//             users.delete(socket.id);
//             io.emit('user list', Array.from(users.values()).map(u => u.username));
//         }
//         console.log(`User disconnected: ${socket.id}`);
//     });
//
//     // Error handling
//     socket.on('error', (err) => console.error(`Socket error: ${err}`));
// });

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));