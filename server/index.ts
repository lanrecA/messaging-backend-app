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
//
// io.on('connection', (socket: Socket) => {
//     console.log(`User connected: ${socket.id}`);
//
//     socket.on('set username', (username: string) => {
//         if (!username) return socket.emit('error', 'Username required');
//
//         userSockets.set(username, socket.id);
//         socket.join(username);
//
//         io.emit('user list', Array.from(userSockets.keys()));
//     });
//
//     socket.on('chat message', (msg: string) => {
//         const sender = Array.from(userSockets.entries()).find(([, id]) => id === socket.id)?.[0];
//         if (!sender) return;
//
//         const messageData = {
//             username: sender,
//             text: msg,
//             timestamp: new Date().toISOString(),
//         };
//
//         io.emit('chat message', messageData);
//     });
//
//     socket.on('disconnect', () => {
//         const username = Array.from(userSockets.entries()).find(([, id]) => id === socket.id)?.[0];
//         if (username) {
//             userSockets.delete(username);
//             io.emit('user list', Array.from(userSockets.keys()));
//         }
//     });
// });

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