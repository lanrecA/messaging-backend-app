import sqlite3 from 'sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, 'messaging.db');
const sqlite = sqlite3.verbose();
const db = new sqlite.Database(dbPath, (err) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                                                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                 first_name TEXT NOT NULL,
                                                 last_name TEXT NOT NULL,
                                                 contact_identifier TEXT NOT NULL UNIQUE,
                                                 password_hash TEXT NOT NULL,
                                                 created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS contacts (
                                                    user_id INTEGER NOT NULL,
                                                    contact_user_id INTEGER NOT NULL,
                                                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                    PRIMARY KEY (user_id, contact_user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE CASCADE
                )
        `);
    });
}

export default db;