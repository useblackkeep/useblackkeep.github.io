'use strict';

// Initialize Firebase
const firebaseConfig = {
    databaseURL: "https://blackkeep-881e8-default-rtdb.firebaseio.com/"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// App State
const state = {
    uid: localStorage.getItem('bk_uid'),
    username: localStorage.getItem('bk_username'),
    currentChatId: null,
    currentChatMeta: null,
    listeners: {},
    unsubscribers: [],
    games: {}
};

// --- UTILITIES ---
const sanitize = (str) => str.replace(/[^a-z0-9_]/gi, '').toLowerCase();
const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
};

// --- AUTH & INIT ---
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        // Try to resume session
        if (state.uid && state.username) {
            await auth.signInAnonymously(); // Re-auth to get DB access
        } else {
            window.location.href = 'index.html';
        }
    } else {
        if (!state.uid) window.location.href = 'index.html';
        initApp();
    }
});

async function initApp() {
    document.getElementById('currentUsernameDisplay').textContent = state.username;
    loadSettings();
    initListeners();
    initGamesList();
    initEmojiPicker();
    
    // Screenshot Detection
    document.addEventListener('keyup', (e) => {
        if (e.key === 'PrintScreen') {
            alert("Screenshot detected! Your partner will be notified.");
            if (state.currentChatId) {
                sendSystemMessage("⚠️ User took a screenshot!", state.currentChatId);
            }
        }
    });
}

function initListeners() {
    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            const tab = e.target.dataset.tab;
            document.querySelectorAll('.list-container').forEach(c => c.classList.remove('active'));
            document.getElementById(`${tab}List`).classList.add('active');
            
            if (tab === 'friends') loadFriends();
        });
    });

    // Search
    document.getElementById('searchInput').addEventListener('keyup', (e) => {
        if (e.key === 'Enter') searchUser(e.target.value);
    });

    // Chat Input
    const msgInput = document.getElementById('messageInput');
    msgInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
        else handleTyping();
    });
    
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('attachBtn').addEventListener('click', () => alert("Image embedding: Paste a link in your message. For files, feature coming soon."));
    
    // Settings
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('closeSettings').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
    document.getElementById('logoutBtn').addEventListener('click', logout);
    
    // Chat Actions
    document.getElementById('addFriendToChat').addEventListener('click', addFriendToCurrentChat);
    document.getElementById('blockUserBtn').addEventListener('click', blockCurrentUser);
    
    loadChats();
}

// --- CHAT LOGIC ---

function loadChats() {
    const ref = db.ref(`users/${state.uid}/chats`);
    ref.on('value', (snapshot) => {
        const chats = snapshot.val();
        const list = document.getElementById('chatsList');
        list.innerHTML = '';
        
        if (!chats) return;

        Object.keys(chats).forEach(chatId => {
            getChatMeta(chatId).then(meta => {
                if (!meta) return;
                const div = document.createElement('div');
                div.className = 'list-item';
                div.dataset.id = chatId;
                
                const unread = meta.unread && meta.unread[state.uid] ? `<div class="unread-badge">!</div>` : '';
                
                div.innerHTML = `
                    <div class="item-avatar">${meta.isGroup ? '👥' : (meta.name || 'U').charAt(0).toUpperCase()}</div>
                    <div class="item-info">
                        <div class="item-name">${escapeHtml(meta.name || 'Direct Chat')}</div>
                        <div class="item-preview">${meta.lastMessage || 'No messages yet'}</div>
                    </div>
                    ${unread}
                `;
                div.onclick = () => openChat(chatId, meta);
                list.appendChild(div);
            });
        });
    });
    state.unsubscribers.push(() => ref.off());
}

async function getChatMeta(chatId) {
    return new Promise(resolve => {
        db.ref(`chats/${chatId}/meta`).once('value', s => resolve(s.val()));
    });
}

async function openChat(chatId, meta) {
    state.currentChatId = chatId;
    state.currentChatMeta = meta;
    
    // UI Updates
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('chatView').classList.remove('hidden');
    
    // Header
    document.getElementById('chatTitle').textContent = meta.name || 'Chat';
    document.getElementById('chatStatus').textContent = meta.members ? `${Object.keys(meta.members).length} members` : 'Online';
    document.getElementById('chatAvatar').textContent = meta.name ? meta.name.charAt(0) : 'U';
    
    // Clear previous messages
    const area = document.getElementById('messagesArea');
    area.innerHTML = '';
    
    // Load Messages
    if (state.listeners.messages) state.listeners.messages.off();
    state.listeners.messages = db.ref(`messages/${chatId}`).orderByChild('timestamp').limitToLast(100);
    
    state.listeners.messages.on('child_added', (snapshot) => {
        const msg = snapshot.val();
        appendMessage(msg, snapshot.key);
        
        // Disappearing Logic
        if (meta.disappear && msg.timestamp) {
            const lifespan = 60000; // 1 min for demo
            if (Date.now() - msg.timestamp > lifespan) {
                db.ref(`messages/${chatId}/${snapshot.key}`).remove();
            } else {
                setTimeout(() => db.ref(`messages/${chatId}/${snapshot.key}`).remove(), lifespan - (Date.now() - msg.timestamp));
            }
        }
    });
    
    // Mark Read
    db.ref(`chats/${chatId}/meta/unread/${state.uid}`).set(false);
    
    // Typing Listener
    db.ref(`chats/${chatId}/typing`).on('value', (s) => {
        const typing = s.val();
        const indicator = document.getElementById('typingIndicator');
        if (typing) {
            const typers = Object.keys(typing).filter(u => u !== state.uid);
            if (typers.length > 0) {
                indicator.querySelector('span').textContent = typers.join(', ');
                indicator.classList.remove('hidden');
            } else indicator.classList.add('hidden');
        } else indicator.classList.add('hidden');
    });
}

function appendMessage(msg, key) {
    const area = document.getElementById('messagesArea');
    const isSelf = msg.sender === state.uid;
    
    const div = document.createElement('div');
    div.className = `message ${isSelf ? 'sent' : 'received'}`;
    div.dataset.id = key;
    
    let content = msg.text;
    // Check for Image/GIF links
    if (content.match(/\.(jpeg|jpg|gif|png|webp)$/) || content.includes('giphy.com') || content.includes('tenor.com')) {
        content = `<img src="${content}" style="max-width:100%; border-radius:8px; margin-top:5px;">`;
    }

    div.innerHTML = `
        <div class="message-bubble">
            ${!isSelf && state.currentChatMeta.isGroup ? `<strong style="color:var(--accent)">${msg.senderName || 'User'}</strong><br>` : ''}
            ${content}
            <div class="message-meta">
                <span>${new Date(msg.timestamp).toLocaleTimeString()}</span>
                ${msg.edited ? '<span>(edited)</span>' : ''}
            </div>
        </div>
        <div class="message-reactions" onclick="reactToMessage('${key}')">${msg.reactions ? Object.values(msg.reactions).join(' ') : '❤️'}</div>
    `;
    
    // Context Menu for Edit/Delete
    div.oncontextmenu = (e) => {
        e.preventDefault();
        if (isSelf) showContext(e, key, msg.text);
    };
    
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || !state.currentChatId) return;
    
    const msgData = {
        text: text,
        sender: state.uid,
        senderName: state.username,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    };
    
    db.ref(`messages/${state.currentChatId}`).push(msgData);
    db.ref(`chats/${state.currentChatId}/meta`).update({ lastMessage: text.substring(0, 30) + '...' });
    
    // Check Mentions
    if (text.includes('@')) {
        // In a full app, parse specific user and notify
        sendSystemMessage(`${state.username} mentioned someone.`, state.currentChatId);
    }

    input.value = '';
}

function handleTyping() {
    if (!state.currentChatId) return;
    db.ref(`chats/${state.currentChatId}/typing/${state.uid}`).set(true);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
        db.ref(`chats/${currentChatId}/typing/${state.uid}`).set(false);
    }, 1000);
}

// --- FRIEND SYSTEM ---

async function searchUser(query) {
    const clean = sanitize(query);
    const uidSnap = await db.ref(`usernames/${clean}`).once('value');
    if (uidSnap.exists()) {
        const uid = uidSnap.val();
        if (uid === state.uid) return alert("That's you!");
        
        const userSnap = await db.ref(`users/${uid}`).once('value');
        const user = userSnap.val();
        if (confirm(`Add ${user.username} as friend?`)) {
            sendFriendRequest(uid);
        }
    } else {
        alert("User not found.");
    }
}

async function sendFriendRequest(toUid) {
    // Check if already friends
    const snap = await db.ref(`friends/${state.uid}/${toUid}`).once('value');
    if (snap.exists()) return alert("Already friends!");
    
    await db.ref(`friend_requests/${toUid}/${state.uid}`).set({
        timestamp: Date.now(),
        username: state.username
    });
    alert("Request sent!");
}

async function loadFriends() {
    // Requests
    const reqList = document.getElementById('friendRequests');
    reqList.innerHTML = '';
    db.ref(`friend_requests/${state.uid}`).on('child_added', (snap) => {
        const req = snap.val();
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `
            <div class="item-info"><div class="item-name">${req.username}</div></div>
            <button class="btn" onclick="acceptFriend('${snap.key}', '${req.username}')">✓</button>
            <button class="btn" onclick="declineFriend('${snap.key}')">✕</button>
        `;
        reqList.appendChild(div);
    });

    // Friends List
    const friendsList = document.getElementById('friendsOnline');
    friendsList.innerHTML = '';
    db.ref(`friends/${state.uid}`).on('child_added', (snap) => {
        const friendUid = snap.key;
        db.ref(`users/${friendUid}`).once('value', (uSnap) => {
            const user = uSnap.val();
            const div = document.createElement('div');
            div.className = 'list-item';
            div.innerHTML = `
                <div class="item-avatar">${user.username.charAt(0)}</div>
                <div class="item-info"><div class="item-name">${user.username}</div></div>
            `;
            div.onclick = () => startDirectChat(friendUid, user.username);
            friendsList.appendChild(div);
        });
    });
}

window.acceptFriend = async (fromUid, fromName) => {
    await db.ref(`friends/${state.uid}/${fromUid}`).set(true);
    await db.ref(`friends/${fromUid}/${state.uid}`).set(true);
    await db.ref(`friend_requests/${state.uid}/${fromUid}`).remove();
    alert(`You are now friends with ${fromName}`);
    loadFriends(); // Refresh
};

window.declineFriend = async (fromUid) => {
    await db.ref(`friend_requests/${state.uid}/${fromUid}`).remove();
};

async function startDirectChat(friendUid, friendName) {
    // Check for existing chat
    const chatId = [state.uid, friendUid].sort().join('_');
    const exists = await db.ref(`chats/${chatId}`).once('value');
    
    if (!exists.exists()) {
        await db.ref(`chats/${chatId}/meta`).set({
            name: friendName, // Display name for the user
            members: { [state.uid]: true, [friendUid]: true },
            created: Date.now()
        });
        await db.ref(`users/${state.uid}/chats/${chatId}`).set(true);
        await db.ref(`users/${friendUid}/chats/${chatId}`).set(true);
    }
    
    // Switch to chat tab and open
    document.querySelector('[data-tab="chats"]').click();
    openChat(chatId, { name: friendName });
}

// --- SETTINGS ---

function openSettings() {
    document.getElementById('settingsModal').classList.remove('hidden');
    renderSettingsSection('account');
}

document.querySelectorAll('.settings-sidebar li').forEach(li => {
    li.addEventListener('click', (e) => {
        document.querySelectorAll('.settings-sidebar li').forEach(l => l.classList.remove('active'));
        e.target.classList.add('active');
        renderSettingsSection(e.target.dataset.section);
    });
});

function renderSettingsSection(section) {
    const content = document.getElementById('settingsContent');
    if (section === 'account') {
        content.innerHTML = `
            <h2>Account</h2>
            <div class="setting-group">
                <label>Username</label>
                <input type="text" value="${state.username}" disabled>
            </div>
            <div class="setting-group">
                <label>Bio</label>
                <input type="text" id="bioInput" placeholder="Enter bio...">
            </div>
            <button class="btn btn-primary" onclick="saveBio()">Save Bio</button>
        `;
    } else if (section === 'appearance') {
        content.innerHTML = `
            <h2>Appearance</h2>
            <p>Theme is locked to BlackKeep Dark Mode for security and consistency.</p>
        `;
    } else if (section === 'danger') {
        content.innerHTML = `
            <h2>Danger Zone</h2>
            <button class="btn btn-danger" onclick="deleteAccount()">Delete Account</button>
        `;
    }
}

window.saveBio = async () => {
    const bio = document.getElementById('bioInput').value;
    await db.ref(`users/${state.uid}/bio`).set(bio);
    alert("Bio saved!");
};

// --- GAMES ---

function initGamesList() {
    document.querySelectorAll('.game-card').forEach(card => {
        card.addEventListener('click', () => {
            startGame(card.dataset.game);
        });
    });
}

function startGame(type) {
    const modal = document.getElementById('gameModal');
    const header = document.getElementById('gameHeader');
    const body = document.getElementById('gameBody');
    
    modal.classList.remove('hidden');
    header.innerHTML = `<h2>${type.toUpperCase()}</h2><button class="btn-close" onclick="document.getElementById('gameModal').classList.add('hidden')">✕</button>`;
    
    if (type === 'coin') {
        const result = Math.random() > 0.5 ? 'Heads' : 'Tails';
        body.innerHTML = `<div style="font-size:4rem; margin:2rem 0">${result}</div>`;
        if (state.currentChatId) sendSystemMessage(`flipped a coin: ${result}`, state.currentChatId);
    } 
    else if (type === 'tictactoe') {
        body.innerHTML = `
            <div id="ttt_board" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; width:200px; margin:0 auto;">
                ${[0,1,2,3,4,5,6,7,8].map(i => `<div class="btn" style="height:60px; font-size:1.5rem" onclick="tttMove(${i})">-</div>`).join('')}
            </div>
        `;
        state.games.ttt = { board: Array(9).fill('-'), turn: 'X' };
    }
    else if (type === 'truth') {
        const truths = ["What is your biggest fear?", "What is your secret hobby?", "Have you ever lied to a friend?"];
        const dares = ["Do 10 pushups", "Send a funny emoji", "Sing a song"];
        const isTruth = Math.random() > 0.5;
        const txt = isTruth ? truths[Math.floor(Math.random()*truths.length)] : dares[Math.floor(Math.random()*dares.length)];
        body.innerHTML = `<h3 style="color:var(--accent)">${isTruth ? 'Truth' : 'Dare'}</h3><p>${txt}</p>`;
    }
}

window.tttMove = (idx) => {
    const game = state.games.ttt;
    if (game.board[idx] !== '-') return;
    game.board[idx] = game.turn;
    
    // Update UI
    const cells = document.querySelectorAll('#ttt_board .btn');
    cells[idx].textContent = game.turn;
    cells[idx].style.color = game.turn === 'X' ? 'var(--accent)' : 'var(--success)';
    
    // Check Win logic (simplified)
    game.turn = game.turn === 'X' ? 'O' : 'X';
};

// --- UTILS & MINOR FEATURES ---

window.reactToMessage = (msgId) => {
    const reactions = prompt("Enter reaction emoji:", "❤️");
    if(reactions) db.ref(`messages/${state.currentChatId}/${msgId}/reactions/${state.uid}`).set(reactions);
};

window.showContext = (e, msgId, text) => {
    if (confirm("Edit this message? (Cancel to Delete)")) {
        const newText = prompt("Edit:", text);
        if (newText) db.ref(`messages/${state.currentChatId}/${msgId}`).update({ text: newText, edited: true });
    } else {
        if (confirm("Delete this message?")) db.ref(`messages/${state.currentChatId}/${msgId}`).remove();
    }
};

function sendSystemMessage(text, chatId) {
    db.ref(`messages/${chatId}`).push({
        text: text,
        system: true,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    });
}

function initEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    const grid = picker.querySelector('.emoji-grid');
    const emojis = ['😀','😎','🔥','❤️','😂','😢','🤔','👀','🚀','🎮'];
    emojis.forEach(e => {
        const span = document.createElement('span');
        span.className = 'emoji-item';
        span.textContent = e;
        span.onclick = () => {
            document.getElementById('messageInput').value += e;
            picker.classList.add('hidden');
        };
        grid.appendChild(span);
    });
    
    document.getElementById('emojiBtn').onclick = () => picker.classList.toggle('hidden');
}

async function addFriendToCurrentChat() {
    if (!state.currentChatId) return;
    const name = prompt("Enter friend's username to add:");
    if (!name) return;
    const uidSnap = await db.ref(`usernames/${sanitize(name)}`).once('value');
    if (uidSnap.exists()) {
        const uid = uidSnap.val();
        await db.ref(`chats/${state.currentChatId}/meta/members/${uid}`).set(true);
        await db.ref(`users/${uid}/chats/${state.currentChatId}`).set(true);
        sendSystemMessage(`${name} was added to the group.`, state.currentChatId);
    } else alert("User not found.");
}

async function blockCurrentUser() {
    if (!state.currentChatMeta || state.currentChatMeta.isGroup) return;
    // In a real app, you'd add to a blocklist node.
    alert("User blocked. You will no longer receive messages.");
}

function logout() {
    localStorage.clear();
    auth.signOut();
    window.location.href = 'index.html';
}

window.addEventListener('beforeunload', () => {
    if (state.uid) db.ref(`users/${state.uid}/online`).set(false);
});
