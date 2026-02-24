// crypto.js
'use strict';

const CryptoModule = (function() {
    const IV_LENGTH = 12;
    const SALT_LENGTH = 32;
    const PADDED_MESSAGE_SIZE = 4096;

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
            {
                name: 'X25519',
                public: peerPublicKey
            },
            privateKey,
            256
        );
        return new Uint8Array(sharedBits);
    }

    async function deriveSessionKeys(sharedSecret) {
        const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
        
        const baseKey = await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            { name: 'HKDF' },
            false,
            ['deriveKey']
        );
        
        const encryptionKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: salt,
                info: new TextEncoder().encode('encryption')
            },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt']
        );
        
        const decryptionKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: salt,
                info: new TextEncoder().encode('decryption')
            },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
        
        const ratchetSeed = new Uint8Array(await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: salt,
                info: new TextEncoder().encode('ratchet')
            },
            baseKey,
            256
        ));
        
        return {
            encryptionKey,
            decryptionKey,
            ratchetSeed,
            salt
        };
    }

    async function encryptMessage(plaintext, key) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encoder = new TextEncoder();
        const data = encoder.encode(plaintext);
        
        // Pad to fixed size
        const paddedData = new Uint8Array(PADDED_MESSAGE_SIZE);
        paddedData.set(data);
        const lengthMarker = new Uint8Array([data.length >> 8, data.length & 0xff]);
        paddedData.set(lengthMarker, PADDED_MESSAGE_SIZE - 2);
        
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
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
            { name: 'AES-GCM', iv: iv },
            key,
            encrypted
        );
        
        const paddedData = new Uint8Array(decrypted);
        const lengthMarker = (paddedData[PADDED_MESSAGE_SIZE - 2] << 8) | paddedData[PADDED_MESSAGE_SIZE - 1];
        
        return new TextDecoder().decode(paddedData.slice(0, lengthMarker));
    }

    async function encryptSignal(plaintext, context) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encoder = new TextEncoder();
        const data = encoder.encode(plaintext);
        
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
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
            { name: 'AES-GCM', iv: iv },
            context.signalKey,
            encrypted
        );
        
        return new TextDecoder().decode(decrypted);
    }

    async function createContext() {
        const keyPair = await generateKeyPair();
        const publicKey = await exportPublicKey(keyPair);
        
        const signalKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        
        return {
            keyPair,
            publicKey,
            signalKey
        };
    }

    async function ratchetKeys(keys) {
        const newSeed = new Uint8Array(await crypto.subtle.digest(
            'SHA-256',
            keys.ratchetSeed
        ));
        
        const baseKey = await crypto.subtle.importKey(
            'raw',
            newSeed,
            { name: 'HKDF' },
            false,
            ['deriveKey']
        );
        
        const newSalt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
        
        const encryptionKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: newSalt,
                info: new TextEncoder().encode('encryption')
            },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt']
        );
        
        const decryptionKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: newSalt,
                info: new TextEncoder().encode('decryption')
            },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
        
        // Zeroize old seed
        secureZero(keys.ratchetSeed);
        
        return {
            encryptionKey,
            decryptionKey,
            ratchetSeed: newSeed,
            salt: newSalt
        };
    }

    async function zeroizeContext(context) {
        if (context.keyPair) {
            // Keys are non-extractable, clear reference
            context.keyPair = null;
        }
        if (context.signalKey) {
            context.signalKey = null;
        }
        context.publicKey = null;
    }

    function secureZero(buffer) {
        if (buffer instanceof Uint8Array) {
            for (let i = 0; i < buffer.length; i++) {
                buffer[i] = 0;
            }
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

    return {
        generateKeyPair,
        exportPublicKey,
        importPublicKey,
        deriveSharedSecret,
        deriveSessionKeys,
        encryptMessage,
        decryptMessage,
        encryptSignal,
        decryptSignal,
        createContext,
        ratchetKeys,
        zeroizeContext,
        secureZero,
        hashBuffer,
        generateRandomPadding,
        arrayBufferToBase64,
        base64ToArrayBuffer
    };
})();
