import express, { Express, Request, Response } from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './database';
import dotenv from 'dotenv';
import {ui_base_url} from "./constant";

dotenv.config();

const app: Express = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: `${ui_base_url}`,
        methods: ['GET', 'POST'],
    },
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

interface Message {
    username: string;
    text: string;
    timestamp: string;
}

interface SearchUser {
    id: number;
    first_name: string;
    last_name: string;
    contact_identifier: string;
}

interface AddContactRequestBody {
    userId: number;
    contactUserId: number;
}

interface ContactResponse {
    id: number;
    first_name: string;
    last_name: string;
    contact_identifier: string;
    added_at: string;
}


app.post('/api/contacts', (req: Request<{}, {}, AddContactRequestBody>, res: Response) => {
    const { userId, contactUserId } = req.body;

    if (!userId || !contactUserId || typeof userId !== 'number' || typeof contactUserId !== 'number') {
        return res.status(400).json({
            error: 'Both userId and contactUserId are required and must be numbers'
        });
    }

    if (userId === contactUserId) {
        return res.status(400).json({ error: 'Cannot add yourself as a contact' });
    }

    db.run(
        `INSERT OR IGNORE INTO contacts (user_id, contact_user_id) 
     VALUES (?, ?)`,
        [userId, contactUserId],
        function (this: any, err: Error | null) {
            if (err) {
                console.error('Error adding contact:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            res.status(201).json({
                message: 'Contact added successfully',
                contactId: contactUserId
            });
        }
    );
});

// =======================
// SIGN UP
// =======================
app.post('/api/signup', async (req: Request, res: Response) => {
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
            function (this: any, err: Error | null) {
                if (err) {
                    if ((err as any).message?.includes('UNIQUE')) {
                        return res.status(409).json({ error: 'Email or mobile number already registered' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }

                res.status(201).json({
                    message: 'User registered successfully',
                    userId: this.lastID,
                });
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/contacts/:userId', (req: Request<{ userId: string }>, res: Response) => {
    const { userId } = req.params;

    const userIdNum = parseInt(userId, 10);
    if (isNaN(userIdNum)) {
        return res.status(400).json({ error: 'userId must be a valid number' });
    }

    db.all(
        `SELECT 
       u.id, 
       u.first_name, 
       u.last_name, 
       u.contact_identifier,
       c.added_at
     FROM contacts c
     JOIN users u ON c.contact_user_id = u.id
     WHERE c.user_id = ?`,
        [userIdNum],
        (err: Error | null, rows: ContactResponse[]) => {
            if (err) {
                console.error('Error fetching contacts:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            res.json(rows);
        }
    );
});

// =======================
// SIGN IN
// =======================
app.post('/api/login', (req: Request, res: Response) => {
    const { contact, password } = req.body;

    if (!contact || !password) {
        return res.status(400).json({ error: 'Contact and password required' });
    }

    db.get(
        `SELECT * FROM users WHERE contact_identifier = ?`,
        [contact],
        async (err: Error | null, user: any) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (!user) return res.status(401).json({ error: 'Invalid credentials' });

            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) return res.status(401).json({ error: 'Invalid credentials' });

            const token = jwt.sign(
                { userId: user.id, username: `${user.first_name} ${user.last_name}`, contact: user.contact_identifier },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            res.json({
                token,
                user: {
                    id: user.id,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    contact: user.contact_identifier,
                },
            });
        }
    );
});

// =======================
// GET ALL USERS (example protected route)
// =======================
app.get('/api/users', (req: Request, res: Response) => {
    db.all(
        `SELECT id, first_name, last_name, contact_identifier, created_at FROM users ORDER BY created_at DESC`,
        [],
        (err: Error | null, rows: any[]) => {
            if (err) {
                console.error('Error fetching users:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows);
        }
    );
});

// =======================
// Socket.IO with TypeScript
// =======================
interface UserSocket {
    username: string;
    socketId: string;
}

const userSockets: Map<string, string> = new Map(); // username → socket.id

app.get('/api/search-users', (req: Request, res: Response) => {
    const { query } = req.query;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Search query is required and must be a non-empty string' });
    }

    const searchTerm = `%${query.trim()}%`;

    db.all(
        `SELECT id, first_name, last_name, contact_identifier 
     FROM users 
     WHERE contact_identifier LIKE ? 
     LIMIT 10`,
        [searchTerm],
        (err: Error | null, rows: SearchUser[]) => {
            if (err) {
                console.error('Database error in search-users:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            res.json(rows);
        }
    );
});

// Helper to get username from socket.id
function getUsernameFromSocket(socket: Socket): string | undefined {
    for (const [username, id] of userSockets.entries()) {
        if (id === socket.id) return username;
    }
    return undefined;
}

io.on('connection', (socket: Socket) => {
    console.log(`User connected: ${socket.id}`);

    // 1. User sets their username after login
    socket.on('set username', (username: string) => {
        if (!username) return socket.emit('error', 'Username required');

        userSockets.set(username, socket.id);
        socket.join(username); // personal room (optional future use)

        // Broadcast updated online list
        io.emit('user list', Array.from(userSockets.keys()));

        console.log(`${username} connected`);
    });

    // 2. Join private chat room when selecting a contact
    socket.on('join chat', (contactUsername: string) => {
        const senderUsername = getUsernameFromSocket(socket);
        if (!senderUsername) return socket.emit('error', 'Not authenticated');

        // Create deterministic room name (sorted so order doesn't matter)
        const participants = [senderUsername, contactUsername].sort();
        const room = `private_${participants.join('_')}`;

        socket.join(room);

        // Optional: notify the other person someone joined
        const contactSocketId = userSockets.get(contactUsername);
        if (contactSocketId) {
            io.to(contactSocketId).emit('chat joined', { from: senderUsername });
        }

        console.log(`${senderUsername} joined room: ${room}`);
    });

    // 3. Send private message to specific user
    socket.on('private message', ({ to, text }: { to: string; text: string }) => {
        const senderUsername = getUsernameFromSocket(socket);
        if (!senderUsername) return socket.emit('error', 'Not authenticated');

        const participants = [senderUsername, to].sort();
        const room = `private_${participants.join('_')}`;

        const messageData: Message = {
            username: senderUsername,
            text,
            timestamp: new Date().toISOString(),
        };

        // Send ONLY to this room → only the two participants receive it
        io.to(room).emit('private message', messageData);
    });

    // 4. Disconnect cleanup
    socket.on('disconnect', () => {
        const username = getUsernameFromSocket(socket);
        if (username) {
            userSockets.delete(username);
            io.emit('user list', Array.from(userSockets.keys()));
            console.log(`${username} disconnected`);
        }
    });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});