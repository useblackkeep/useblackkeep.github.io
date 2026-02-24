// FirebaseAPI.js
'use strict';

const FirebaseAPI = (function() {
    const config = {
        databaseURL: "https://blackkeep-c0d02-default-rtdb.firebaseio.com/"
    };

    let db = null;
    let initialized = false;

    const ROOM_EXPIRY_MS = 120000; // 2 minutes
    const MAX_FAILED_ATTEMPTS = 5;

    function init() {
        if (initialized) return;
        if (typeof firebase === 'undefined') {
            console.error('Firebase SDK not loaded.');
            return;
        }
        
        if (!firebase.apps.length) {
            firebase.initializeApp(config);
        }
        
        db = firebase.database();
        initialized = true;
    }

    function generateRoomCode() {
        // 8-character alphanumeric, excluding ambiguous chars
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let result = '';
        const array = new Uint8Array(8);
        crypto.getRandomValues(array);
        for (let i = 0; i < 8; i++) {
            result += chars[array[i] % chars.length];
        }
        return result;
    }

    function generateDecoyField() {
        const length = 16 + Math.floor(Math.random() * 32);
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        const array = new Uint8Array(length);
        crypto.getRandomValues(array);
        for (let i = 0; i < length; i++) {
            result += chars[array[i] % chars.length];
        }
        return result;
    }

    function generateRandomPadding() {
        const length = 32 + Math.floor(Math.random() * 64);
        const array = new Uint8Array(length);
        crypto.getRandomValues(array);
        return Array.from(array);
    }

    async function createRoom(peerId, publicKey) {
        init();
        
        const roomId = generateRoomCode();
        const now = Date.now();
        const ref = db.ref('rooms/' + roomId);
        
        const roomData = {
            createdAt: now,
            expiresAt: now + ROOM_EXPIRY_MS,
            failedAttempts: 0,
            locked: false,
            decoy1: generateDecoyField(),
            decoy2: generateDecoyField(),
            hash: generateDecoyField()
        };
        
        // Set room meta data
        await ref.set(roomData);
        
        // Add self as first peer
        await ref.child('peers/' + peerId).set({
            publicKey: publicKey,
            joinedAt: now
        });
        
        // Schedule expiry check
        setTimeout(() => {
            checkAndExpireRoom(roomId);
        }, ROOM_EXPIRY_MS + 5000);
        
        return roomId;
    }

    async function joinRoom(roomId, peerId, publicKey) {
        init();
        
        const ref = db.ref('rooms/' + roomId);
        const snapshot = await ref.once('value');
        
        if (!snapshot.exists()) {
            return null;
        }
        
        const roomData = snapshot.val();
        
        // Check validity
        if (roomData.locked) {
            throw new Error('Room is locked');
        }
        
        if (Date.now() > roomData.expiresAt) {
            await burnRoom(roomId);
            return null;
        }
        
        // Use transaction to safely add peer
        const peerRef = ref.child('peers/' + peerId);
        await peerRef.set({
            publicKey: publicKey,
            joinedAt: firebase.database.ServerValue.TIMESTAMP
        });
        
        // Return room data with existing peers for the client to initiate connections
        // We need to fetch the updated peer list
        const peersSnapshot = await ref.child('peers').once('value');
        const peersData = peersSnapshot.val() || {};
        
        // Format peers for the client (excluding self)
        const peersList = [];
        Object.keys(peersData).forEach(id => {
            if (id !== peerId) {
                peersList.push({
                    id: id,
                    publicKey: peersData[id].publicKey
                });
            }
        });
        
        return {
            ...roomData,
            peers: peersList
        };
    }

    async function leaveRoom(roomId, peerId) {
        if (!roomId || !peerId) return;
        init();
        
        try {
            const peerRef = db.ref('rooms/' + roomId + '/peers/' + peerId);
            await peerRef.remove();
            
            // Check if room is empty to burn it
            const peersSnapshot = await db.ref('rooms/' + roomId + '/peers').once('value');
            if (!peersSnapshot.exists() || !peersSnapshot.val() || Object.keys(peersSnapshot.val()).length === 0) {
                await burnRoom(roomId);
            }
        } catch (err) {
            // Silently fail
        }
    }

    async function burnRoom(roomId) {
        init();
        await db.ref('rooms/' + roomId).remove();
    }

    async function checkAndExpireRoom(roomId) {
        init();
        try {
            const ref = db.ref('rooms/' + roomId);
            const snapshot = await ref.once('value');
            
            if (snapshot.exists()) {
                const data = snapshot.val();
                if (Date.now() > data.expiresAt) {
                    await burnRoom(roomId);
                }
            }
        } catch (e) {
            // Ignore
        }
    }

    async function incrementFailedAttempts(roomId) {
        if (!roomId) return;
        init();
        
        const ref = db.ref('rooms/' + roomId);
        
        // Transaction to safely increment
        await ref.transaction((currentData) => {
            if (currentData === null) {
                return null;
            }
            
            currentData.failedAttempts = (currentData.failedAttempts || 0) + 1;
            
            if (currentData.failedAttempts >= MAX_FAILED_ATTEMPTS) {
                currentData.locked = true;
            }
            
            return currentData;
        });
    }

    async function sendSignal(roomId, fromPeerId, toPeerId, encryptedBlob) {
        init();
        
        const signalData = {
            from: fromPeerId,
            to: toPeerId,
            encryptedBlob: encryptedBlob,
            timestamp: firebase.database.ServerValue.TIMESTAMP,
            randomPadding: generateRandomPadding(),
            decoy1: generateDecoyField()
        };
        
        // Push to signals sub-collection
        await db.ref('rooms/' + roomId + '/signals').push(signalData);
    }

    function listenForSignals(roomId, peerId, callback) {
        init();
        
        const signalsRef = db.ref('rooms/' + roomId + '/signals');
        
        // Listen for child_added events
        const listener = signalsRef.on('child_added', async (snapshot) => {
            const data = snapshot.val();
            
            // Filter for messages intended for this peer
            if (data && data.to === peerId) {
                callback(data);
                
                // Remove signal after processing (cleanup)
                snapshot.ref.remove().catch(() => {});
            }
        });
        
        // Return unsubscribe function
        return () => {
            signalsRef.off('child_added', listener);
        };
    }

    async function getPeerPublicKey(roomId, peerId) {
        init();
        
        const snapshot = await db.ref('rooms/' + roomId + '/peers/' + peerId + '/publicKey').once('value');
        return snapshot.exists() ? snapshot.val() : null;
    }

    async function getRoom(roomId) {
        init();
        const snapshot = await db.ref('rooms/' + roomId).once('value');
        return snapshot.exists() ? snapshot.val() : null;
    }

    // Cleanup function for periodic maintenance (optional)
    async function cleanupExpiredRooms() {
        // In a real production app, this would be done via Cloud Functions
        // For this client-only implementation, we do best-effort cleanup on interaction
        init();
        const now = Date.now();
        // This is expensive on client, so we rely mostly on on-demand expiry checks
    }

    return {
        init,
        createRoom,
        joinRoom,
        leaveRoom,
        burnRoom,
        incrementFailedAttempts,
        sendSignal,
        listenForSignals,
        getPeerPublicKey,
        getRoom
    };
})();
