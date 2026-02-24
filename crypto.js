// crypto.js
'use strict';

const CryptoModule = (function() {
    const IV_LENGTH = 12;
    const SALT_LENGTH = 32;
    const TAG_LENGTH = 16;

    // --- Key Generation ---

    async function generateKeyPair() {
        return await crypto.subtle.generateKey(
            { name: 'X25519' },
            false,
            ['deriveKey', 'deriveBits']
        );
    }

    async function exportPublicKey(keyPair) {
        const exported = await crypto.subtle.exportKey('raw', keyPair.publicKey);
        return arrayBufferToBase64(exported);
    }

    async function importPublicKey(base64Key) {
        const keyData = base64ToArrayBuffer(base64Key);
        return await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'X25519' },
            false,
            []
        );
    }

    async function deriveSharedSecret(privateKey, peerPublicKeyBase64) {
        const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
        const sharedBits = await crypto.subtle.deriveBits(
            { name: 'X25519', public: peerPublicKey },
            privateKey,
            256
        );
        return new Uint8Array(sharedBits);
    }

    async function deriveSessionKeys(sharedSecret) {
        const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
        
        const baseKey = await crypto.subtle.importKey(
            'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey', 'deriveBits']
        );
    
        const encryptionKey = await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('enc-v1') },
            baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
        );
    
        const decryptionKey = await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('enc-v1') },
            baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
        );
    
        const ratchetBits = await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('ratchet-v1') },
            baseKey, 256
        );
    
        return {
            encryptionKey,
            decryptionKey,
            ratchetSeed: new Uint8Array(ratchetBits),
            salt
        };
    }

    // --- Message Encryption (with random padding to obscure length) ---

    async function encryptMessage(plaintext, key) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encoder = new TextEncoder();
        const data = encoder.encode(plaintext);

        // Pad to next power of 512 to obscure message length
        const paddedSize = Math.max(512, Math.ceil((data.length + 4) / 512) * 512);
        const paddedData = new Uint8Array(paddedSize);
        const view = new DataView(paddedData.buffer);
        view.setUint32(0, data.length, false); // big-endian length prefix
        paddedData.set(data, 4);
        // rest is random padding
        crypto.getRandomValues(paddedData.subarray(4 + data.length));

        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 },
            key,
            paddedData
        );

        const combined = new Uint8Array(iv.length + encrypted.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(encrypted), iv.length);
        return arrayBufferToBase64(combined.buffer);
    }

    async function decryptMessage(ciphertextBase64, key) {
        const combined = base64ToArrayBuffer(ciphertextBase64);
        const iv = combined.slice(0, IV_LENGTH);
        const encrypted = combined.slice(IV_LENGTH);

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 },
            key,
            encrypted
        );

        const paddedData = new Uint8Array(decrypted);
        const view = new DataView(paddedData.buffer);
        const originalLength = view.getUint32(0, false);
        return new TextDecoder().decode(paddedData.slice(4, 4 + originalLength));
    }

    // --- Signal Encryption (for WebRTC signaling via Firebase) ---
    // Uses a room-derived key from the room code itself, preventing outsiders from reading signals

    async function deriveRoomKey(roomCode) {
        const raw = new TextEncoder().encode('blackkeep-room-signal:' + roomCode);
        const hashBits = await crypto.subtle.digest('SHA-256', raw);
        return crypto.subtle.importKey(
            'raw', hashBits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }

    async function encryptSignal(plaintext, context) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encoder = new TextEncoder();
        const data = encoder.encode(plaintext);

        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            context.signalKey,
            data
        );

        const combined = new Uint8Array(iv.length + encrypted.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(encrypted), iv.length);
        return arrayBufferToBase64(combined.buffer);
    }

    async function decryptSignal(ciphertextBase64, context) {
        const combined = base64ToArrayBuffer(ciphertextBase64);
        const iv = combined.slice(0, IV_LENGTH);
        const encrypted = combined.slice(IV_LENGTH);

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            context.signalKey,
            encrypted
        );
        return new TextDecoder().decode(decrypted);
    }

    async function createContext(roomCode) {
        const keyPair = await generateKeyPair();
        const publicKey = await exportPublicKey(keyPair);
        const signalKey = await deriveRoomKey(roomCode);

        return { keyPair, publicKey, signalKey };
    }

    // --- Double Ratchet Step ---

    async function ratchetKeys(keys) {
        // Hash-based ratchet: SHA-256 on current seed
        const newSeedBuf = await crypto.subtle.digest('SHA-256', keys.ratchetSeed);
        const newSeed = new Uint8Array(newSeedBuf);

        const baseKey = await crypto.subtle.importKey(
            'raw', newSeed, { name: 'HKDF' }, false, ['deriveKey', 'deriveBits']
        );

        const newSalt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

        const encryptionKey = await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: newSalt, info: new TextEncoder().encode('enc-v1') },
            baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
        );

        const decryptionKey = await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: newSalt, info: new TextEncoder().encode('dec-v1') },
            baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
        );

        const nextRatchetBits = await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: newSalt, info: new TextEncoder().encode('ratchet-v1') },
            baseKey, 256
        );

        secureZero(keys.ratchetSeed);

        return {
            encryptionKey,
            decryptionKey,
            ratchetSeed: new Uint8Array(nextRatchetBits),
            salt: newSalt
        };
    }

    async function zeroizeContext(context) {
        context.keyPair = null;
        context.signalKey = null;
        context.publicKey = null;
    }

    function secureZero(buffer) {
        if (buffer instanceof Uint8Array) {
            crypto.getRandomValues(buffer); // overwrite with random before zeroing
            buffer.fill(0);
        }
    }

    async function hashBuffer(buffer) {
        const hash = await crypto.subtle.digest('SHA-256', buffer);
        return arrayBufferToBase64(hash);
    }

    function generateRandomPadding() {
        const length = 64 + Math.floor(Math.random() * 256);
        const padding = new Uint8Array(length);
        crypto.getRandomValues(padding);
        return arrayBufferToBase64(padding.buffer);
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // Constant-time comparison to prevent timing attacks
    function constantTimeEqual(a, b) {
        if (a.length !== b.length) return false;
        let result = 0;
        for (let i = 0; i < a.length; i++) {
            result |= a[i] ^ b[i];
        }
        return result === 0;
    }

    return {
        generateKeyPair, exportPublicKey, importPublicKey,
        deriveSharedSecret, deriveSessionKeys,
        encryptMessage, decryptMessage,
        encryptSignal, decryptSignal,
        createContext, ratchetKeys, zeroizeContext,
        secureZero, hashBuffer, generateRandomPadding,
        arrayBufferToBase64, base64ToArrayBuffer, constantTimeEqual
    };
})();
