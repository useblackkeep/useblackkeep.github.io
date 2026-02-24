// FirebaseAPI.js
'use strict';

const FirebaseAPI = (function() {
    const config = {
        databaseURL: "https://blackkeep-c0d02-default-rtdb.firebaseio.com/"
    };

    let db = null;
    let initialized = false;

    const ROOM_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours
    const MAX_FAILED_ATTEMPTS = 5;
    const SIGNAL_TTL_MS = 30000; // signals expire after 30s

    function init() {
        if (initialized) return;
        if (typeof firebase === 'undefined') {
            throw new Error('Firebase SDK not loaded.');
        }
        if (!firebase.apps.length) {
            firebase.initializeApp(config);
        }
        db = firebase.database();
        initialized = true;
    }

    function generateRoomCode() {
        // 8-char alphanumeric, no ambiguous chars (0,O,I,1,l)
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const result = new Array(8);
        const array = new Uint8Array(8);
        crypto.getRandomValues(array);
        for (let i = 0; i < 8; i++) {
            result[i] = chars[array[i] % chars.length];
        }
        return result.join('');
    }

    function sanitizeRoomCode(code) {
        if (typeof code !== 'string') return null;
        const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
        return cleaned.length === 8 ? cleaned : null;
    }

    function sanitizePeerId(peerId) {
        if (typeof peerId !== 'string') return null;
        return /^[A-Z0-9]{8}$/.test(peerId) ? peerId : null;
    }

    async function createRoom(peerId, publicKey, displayName) {
        init();
        if (!sanitizePeerId(peerId)) throw new Error('Invalid peer ID');

        const roomId = generateRoomCode();
        const now = Date.now();
        const ref = db.ref('rooms/' + roomId);

        await ref.set({
            createdAt: now,
            expiresAt: now + ROOM_EXPIRY_MS,
            failedAttempts: 0,
            locked: false
        });

        await ref.child('peers/' + peerId).set({
            publicKey: publicKey,
            displayName: displayName,
            joinedAt: now
        });

        // Set up server-side cleanup via onDisconnect
        ref.child('peers/' + peerId).onDisconnect().remove();

        // Schedule client-side expiry
        setTimeout(() => checkAndExpireRoom(roomId), ROOM_EXPIRY_MS + 5000);

        return roomId;
    }

    async function joinRoom(roomId, peerId, publicKey, displayName) {
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        const safePeer = sanitizePeerId(peerId);
        if (!safeRoom) throw new Error('Invalid room code format');
        if (!safePeer) throw new Error('Invalid peer ID');

        const ref = db.ref('rooms/' + safeRoom);
        const snapshot = await ref.once('value');

        if (!snapshot.exists()) return null;

        const roomData = snapshot.val();

        if (roomData.locked) throw new Error('Room is locked due to too many failed attempts');
        if (Date.now() > roomData.expiresAt) {
            await burnRoom(safeRoom);
            return null;
        }

        await ref.child('peers/' + safePeer).set({
            publicKey,
            displayName,
            joinedAt: firebase.database.ServerValue.TIMESTAMP
        });

        ref.child('peers/' + safePeer).onDisconnect().remove();

        const peersSnapshot = await ref.child('peers').once('value');
        const peersData = peersSnapshot.val() || {};

        const peersList = Object.entries(peersData)
            .filter(([id]) => id !== safePeer)
            .map(([id, data]) => ({ id, publicKey: data.publicKey, displayName: data.displayName }));

        return { ...roomData, peers: peersList };
    }

    async function leaveRoom(roomId, peerId) {
        if (!roomId || !peerId) return;
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        const safePeer = sanitizePeerId(peerId);
        if (!safeRoom || !safePeer) return;

        try {
            await db.ref('rooms/' + safeRoom + '/peers/' + safePeer).remove();
            const peersSnapshot = await db.ref('rooms/' + safeRoom + '/peers').once('value');
            if (!peersSnapshot.exists() || Object.keys(peersSnapshot.val() || {}).length === 0) {
                await burnRoom(safeRoom);
            }
        } catch (err) {
            // Best effort
        }
    }

    async function burnRoom(roomId) {
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        if (!safeRoom) return;
        await db.ref('rooms/' + safeRoom).remove();
    }

    async function checkAndExpireRoom(roomId) {
        init();
        try {
            const safeRoom = sanitizeRoomCode(roomId);
            if (!safeRoom) return;
            const snapshot = await db.ref('rooms/' + safeRoom).once('value');
            if (snapshot.exists()) {
                const data = snapshot.val();
                if (Date.now() > data.expiresAt) await burnRoom(safeRoom);
            }
        } catch (e) { /* ignore */ }
    }

    async function incrementFailedAttempts(roomId) {
        if (!roomId) return;
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        if (!safeRoom) return;

        await db.ref('rooms/' + safeRoom).transaction((current) => {
            if (!current) return null;
            current.failedAttempts = (current.failedAttempts || 0) + 1;
            if (current.failedAttempts >= MAX_FAILED_ATTEMPTS) current.locked = true;
            return current;
        });
    }

    async function sendSignal(roomId, fromPeerId, toPeerId, encryptedBlob) {
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        if (!safeRoom) throw new Error('Invalid room code');

        const signalRef = db.ref('rooms/' + safeRoom + '/signals').push();
        const expiresAt = Date.now() + SIGNAL_TTL_MS;

        await signalRef.set({
            from: fromPeerId,
            to: toPeerId,
            encryptedBlob,
            timestamp: firebase.database.ServerValue.TIMESTAMP,
            expiresAt
        });

        // Auto-remove after TTL
        signalRef.onDisconnect().remove();
        setTimeout(() => signalRef.remove().catch(() => {}), SIGNAL_TTL_MS);
    }

    function listenForSignals(roomId, peerId, callback) {
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        if (!safeRoom) return () => {};

        const signalsRef = db.ref('rooms/' + safeRoom + '/signals');
        const listener = signalsRef.on('child_added', (snapshot) => {
            const data = snapshot.val();
            if (data && data.to === peerId) {
                // Discard expired signals
                if (data.expiresAt && Date.now() > data.expiresAt) {
                    snapshot.ref.remove().catch(() => {});
                    return;
                }
                callback(data);
                snapshot.ref.remove().catch(() => {});
            }
        });

        return () => signalsRef.off('child_added', listener);
    }

    async function getPeerPublicKey(roomId, peerId) {
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        const safePeer = sanitizePeerId(peerId);
        if (!safeRoom || !safePeer) return null;

        const snapshot = await db.ref('rooms/' + safeRoom + '/peers/' + safePeer + '/publicKey').once('value');
        return snapshot.exists() ? snapshot.val() : null;
    }

    async function getRoom(roomId) {
        init();
        const safeRoom = sanitizeRoomCode(roomId);
        if (!safeRoom) return null;
        const snapshot = await db.ref('rooms/' + safeRoom).once('value');
        return snapshot.exists() ? snapshot.val() : null;
    }

    return {
        init, createRoom, joinRoom, leaveRoom, burnRoom,
        incrementFailedAttempts, sendSignal, listenForSignals,
        getPeerPublicKey, getRoom, sanitizeRoomCode, sanitizePeerId
    };
})();
