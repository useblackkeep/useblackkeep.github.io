'use strict';

// ===================== DB MODULE =====================
// Lightweight Firebase RTDB wrapper

const DB = (function() {
    const FIREBASE_URL = 'https://blackkeep-881e8-default-rtdb.firebaseio.com/';
    
    let _db = null;
    let _initialized = false;
    let _authToken = null; // custom auth token (session token used as auth)

    function init() {
        if (_initialized) return;
        if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
        if (!firebase.apps.length) {
            firebase.initializeApp({ databaseURL: FIREBASE_URL });
        }
        _db = firebase.database();
        _initialized = true;
    }

    function setAuthToken(token) {
        _authToken = token;
    }

    function ref(path) {
        init();
        return _db.ref(path);
    }

    async function get(path) {
        init();
        const snap = await _db.ref(path).once('value');
        return snap.exists() ? snap.val() : null;
    }

    async function set(path, data) {
        init();
        await _db.ref(path).set(data);
    }

    async function update(path, data) {
        init();
        await _db.ref(path).update(data);
    }

    async function push(path, data) {
        init();
        const newRef = _db.ref(path).push();
        await newRef.set(data);
        return newRef.key;
    }

    async function remove(path) {
        init();
        await _db.ref(path).remove();
    }

    async function transaction(path, updateFn) {
        init();
        return _db.ref(path).transaction(updateFn);
    }

    function on(path, event, callback) {
        init();
        const r = _db.ref(path);
        r.on(event, callback);
        return () => r.off(event, callback);
    }

    function onChildAdded(path, callback) {
        init();
        const r = _db.ref(path);
        r.on('child_added', callback);
        return () => r.off('child_added', callback);
    }

    function onChildChanged(path, callback) {
        init();
        const r = _db.ref(path);
        r.on('child_changed', callback);
        return () => r.off('child_changed', callback);
    }

    function onChildRemoved(path, callback) {
        init();
        const r = _db.ref(path);
        r.on('child_removed', callback);
        return () => r.off('child_removed', callback);
    }

    function onValue(path, callback) {
        init();
        const r = _db.ref(path);
        r.on('value', callback);
        return () => r.off('value', callback);
    }

    function onDisconnect(path, data) {
        init();
        if (data === null) {
            _db.ref(path).onDisconnect().remove();
        } else {
            _db.ref(path).onDisconnect().set(data);
        }
    }

    function serverTimestamp() {
        return firebase.database.ServerValue.TIMESTAMP;
    }

    // Generate a push ID (time-sortable)
    function pushId() {
        return _db.ref().push().key;
    }

    // Batch write
    async function multiUpdate(updates) {
        init();
        await _db.ref().update(updates);
    }

    // Ordered query
    function queryOrderByChild(path, child, options = {}) {
        init();
        let q = _db.ref(path).orderByChild(child);
        if (options.equalTo !== undefined) q = q.equalTo(options.equalTo);
        if (options.limitToLast) q = q.limitToLast(options.limitToLast);
        if (options.limitToFirst) q = q.limitToFirst(options.limitToFirst);
        if (options.startAt !== undefined) q = q.startAt(options.startAt);
        if (options.endAt !== undefined) q = q.endAt(options.endAt);
        return q;
    }

    return {
        init, setAuthToken, ref,
        get, set, update, push, remove, transaction,
        on, onChildAdded, onChildChanged, onChildRemoved, onValue,
        onDisconnect, serverTimestamp, pushId, multiUpdate,
        queryOrderByChild
    };
})();
