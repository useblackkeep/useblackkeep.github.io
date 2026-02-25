'use strict';

// ===================== AUTH MODULE =====================
// Custom auth using PBKDF2 for password hashing client-side
// Sessions stored in Firebase + localStorage

const Auth = (function() {
    const SESSION_KEY = 'bk_session';
    const PBKDF2_ITERATIONS = 100000;
    const SALT_LENGTH = 16;

    // Hash password with PBKDF2
    async function hashPassword(password, saltB64) {
        const encoder = new TextEncoder();
        const passwordBytes = encoder.encode(password);
        
        let saltBytes;
        if (saltB64) {
            saltBytes = base64ToBytes(saltB64);
        } else {
            saltBytes = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
        }

        const keyMaterial = await crypto.subtle.importKey(
            'raw', passwordBytes, 'PBKDF2', false, ['deriveBits']
        );

        const hashBits = await crypto.subtle.deriveBits({
            name: 'PBKDF2',
            salt: saltBytes,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        }, keyMaterial, 256);

        return {
            hash: bytesToBase64(new Uint8Array(hashBits)),
            salt: bytesToBase64(saltBytes)
        };
    }

    // Verify password against stored hash
    async function verifyPassword(password, storedHash, storedSalt) {
        const { hash } = await hashPassword(password, storedSalt);
        // Constant-time comparison
        if (hash.length !== storedHash.length) return false;
        let diff = 0;
        for (let i = 0; i < hash.length; i++) {
            diff |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i);
        }
        return diff === 0;
    }

    // Generate secure session token
    function generateSessionToken() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return bytesToBase64(bytes).replace(/[+/=]/g, c => c === '+' ? '-' : c === '/' ? '_' : '');
    }

    // Sanitize username
    function sanitizeUsername(u) {
        if (!u || typeof u !== 'string') return null;
        const clean = u.trim().replace(/[^a-zA-Z0-9_]/g, '').substring(0, 24);
        return clean.length >= 3 ? clean : null;
    }

    // Generate a UID from username (deterministic, for Firebase path)
    async function usernameToUid(username) {
        const bytes = new TextEncoder().encode('blackkeep_uid:' + username.toLowerCase());
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return 'u_' + bytesToBase64(new Uint8Array(hash)).substring(0, 22).replace(/[+/=]/g, c => c === '+' ? 'a' : c === '/' ? 'b' : 'c');
    }

    // Sign up
    async function signUp(username, password) {
        const safeUser = sanitizeUsername(username);
        if (!safeUser) throw new Error('Username must be 3-24 alphanumeric/underscore characters');
        if (password.length < 8) throw new Error('Password must be at least 8 characters');

        // Check if username taken
        const existing = await DB.get('usernames/' + safeUser);
        if (existing) throw new Error('Username already taken');

        const uid = await usernameToUid(safeUser);
        const { hash, salt } = await hashPassword(password);
        const now = Date.now();

        // Store username → uid mapping (public lookup)
        await DB.set('usernames/' + safeUser, { uid, createdAt: now });

        // Store user profile
        await DB.set('users/' + uid, {
            username: safeUser,
            passwordHash: hash,
            passwordSalt: salt,
            bio: '',
            mood: '',
            status: 'online',
            createdAt: now,
            lastSeen: now,
            settings: JSON.stringify({
                enterToSend: true,
                showOnlineStatus: true,
                showLastSeen: true,
                readReceipts: true,
                disappearingDefault: 0,
                theme: 'dark',
                notificationsEnabled: true
            })
        });

        // Create session
        return await createSession(uid, safeUser);
    }

    // Sign in
    async function signIn(username, password) {
        const safeUser = sanitizeUsername(username);
        if (!safeUser) throw new Error('Invalid username');

        const usernameData = await DB.get('usernames/' + safeUser);
        if (!usernameData) throw new Error('Invalid username or password');

        const uid = usernameData.uid;
        const userData = await DB.get('users/' + uid);
        if (!userData) throw new Error('Account not found');

        const valid = await verifyPassword(password, userData.passwordHash, userData.passwordSalt);
        if (!valid) throw new Error('Invalid username or password');

        return await createSession(uid, safeUser);
    }

    // Create session
    async function createSession(uid, username) {
        const token = generateSessionToken();
        const now = Date.now();

        await DB.set('sessions/' + token, {
            uid,
            username,
            createdAt: now,
            userAgent: navigator.userAgent.substring(0, 200)
        });

        const session = { token, uid, username };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        return session;
    }

    // Get current session
    async function getSession() {
        const stored = localStorage.getItem(SESSION_KEY);
        if (!stored) return null;
        try {
            const session = JSON.parse(stored);
            // Verify session still valid in DB
            const dbSession = await DB.get('sessions/' + session.token);
            if (!dbSession || dbSession.uid !== session.uid) {
                localStorage.removeItem(SESSION_KEY);
                return null;
            }
            return session;
        } catch {
            localStorage.removeItem(SESSION_KEY);
            return null;
        }
    }

    // Get session synchronously (from localStorage only)
    function getSessionSync() {
        const stored = localStorage.getItem(SESSION_KEY);
        if (!stored) return null;
        try { return JSON.parse(stored); } catch { return null; }
    }

    // Sign out
    async function signOut(token) {
        if (token) await DB.delete('sessions/' + token).catch(() => {});
        localStorage.removeItem(SESSION_KEY);
    }

    // Sign out all sessions
    async function signOutAll(uid) {
        // We'd need to scan sessions - for simplicity just clear local
        localStorage.removeItem(SESSION_KEY);
    }

    // Get all active sessions for a user (simplified - only stores token reference)
    async function getActiveSessions(uid) {
        // Returns just the current session info
        const session = getSessionSync();
        if (!session || session.uid !== uid) return [];
        const dbSession = await DB.get('sessions/' + session.token);
        return dbSession ? [{ ...dbSession, token: session.token }] : [];
    }

    function bytesToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function base64ToBytes(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    return {
        signUp, signIn, signOut, signOutAll,
        getSession, getSessionSync,
        getActiveSessions, sanitizeUsername, usernameToUid
    };
})();
