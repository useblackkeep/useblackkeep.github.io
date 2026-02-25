'use strict';

// ===================== BLACKKEEP APP =====================
const App = (function() {
    let session = null; // { token, uid, username }
    let myProfile = null;
    let mySettings = {};
    let activeChatId = null;
    let activeChatData = null;
    let presenceListenerOff = null;
    let friends = {}; // uid -> profile
    let chatList = {}; // chatId -> meta
    let replyingTo = null; // { msgId, content, sender }
    let editingMsg = null; // { msgId, chatId }
    let activeTab = 'chats';
    let profilePanelOpen = false;
    let profilePanelUserId = null;

    // Listeners to unsubscribe
    let listeners = [];
    let typingTimeout = null;
    let presenceListenerOff = null;
    let typingListeners = {};
    let messageListeners = {};
    let disappearTimers = {};
    let streakListeners = {};

    function unsub(fn) { if (fn) { try { fn(); } catch(e){} } }

    // ===================== INIT =====================
    async function init() {
        const loading = document.getElementById('loadingScreen');
        const loadingText = document.getElementById('loadingText');

        session = Auth.getSessionSync();
        if (!session) { window.location.href = 'index.html'; return; }

        loadingText.textContent = 'Verifying session...';
        const valid = await Auth.getSession();
        if (!valid) { window.location.href = 'index.html'; return; }

        loadingText.textContent = 'Loading your data...';
        myProfile = await DB.get('users/' + session.uid);
        if (!myProfile) { window.location.href = 'index.html'; return; }

        try { mySettings = JSON.parse(myProfile.settings || '{}'); } catch { mySettings = {}; }

        // Set presence
        const presenceRef = 'presence/' + session.uid;
        await DB.set(presenceRef, { status: 'online', lastSeen: DB.serverTimestamp() });
        DB.onDisconnect(presenceRef, { status: 'offline', lastSeen: DB.serverTimestamp() });

        // Update user status
        await DB.update('users/' + session.uid, { status: 'online', lastSeen: Date.now() });
        DB.onDisconnect('users/' + session.uid + '/status', 'offline');
        DB.onDisconnect('users/' + session.uid + '/lastSeen', Date.now());

        // Transition
        loading.classList.add('fade-out');
        await sleep(500);
        loading.classList.add('hidden');
        document.getElementById('app').style.display = 'flex';

        setupUI();
        loadSidebar();
        listenFriendRequests();
        listenPresence();
        checkDailyStreak();
        setupScreenshotDetection();

        // Keyboard shortcuts
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                closeAllModals();
                if (profilePanelOpen) toggleProfilePanel(false);
            }
        });

        // Unload cleanup
        window.addEventListener('beforeunload', () => {
            DB.update('users/' + session.uid, { status: 'offline', lastSeen: Date.now() }).catch(() => {});
        });
    }

    // ===================== UI SETUP =====================
    function setupUI() {
        // Sidebar footer
        const av = document.getElementById('myAvatar');
        av.textContent = myProfile.username.charAt(0).toUpperCase();
        document.getElementById('myUsername').textContent = myProfile.username;
        document.getElementById('myMood').textContent = myProfile.mood || 'No mood set';

        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeTab = btn.dataset.tab;
                loadSidebar();
            });
        });

        // Search
        document.getElementById('searchInput').addEventListener('input', e => {
            filterChatList(e.target.value);
        });

        // Modals
        document.querySelectorAll('.modal-close, [data-close]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.close || btn.closest('.modal-overlay').id;
                closeModal(id);
            });
        });
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', e => {
                if (e.target === overlay) closeModal(overlay.id);
            });
        });

        // Sidebar buttons
        document.getElementById('addFriendBtn').addEventListener('click', () => openModal('addFriendModal'));
        document.getElementById('friendReqBtn').addEventListener('click', () => { openModal('friendRequestsModal'); loadFriendRequests(); });
        document.getElementById('newGroupBtn').addEventListener('click', () => openNewGroupModal());
        document.getElementById('settingsBtn').addEventListener('click', () => openSettings());

        // Add friend
        document.getElementById('sendFriendRequest').addEventListener('click', sendFriendRequest);
        document.getElementById('addFriendInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendFriendRequest(); });

        // Create group
        document.getElementById('createGroupBtn').addEventListener('click', createGroup);

        // Chat controls
        document.getElementById('chatImageBtn').addEventListener('click', () => openModal('imageEmbedModal'));
        document.getElementById('chatGifBtn').addEventListener('click', toggleGifPicker);
        document.getElementById('chatDisappearBtn').addEventListener('click', () => { if (activeChatId) openModal('disappearModal'); });
        document.getElementById('chatMuteBtn').addEventListener('click', toggleMuteChat);
        document.getElementById('chatPinBtn').addEventListener('click', togglePinChat);
        document.getElementById('viewProfileBtn').addEventListener('click', () => {
            if (activeChatData && !activeChatData.isGroup) toggleProfilePanel(true, activeChatData.otherUid);
        });

        // Send
        document.getElementById('sendBtn').addEventListener('click', sendMessage);
        document.getElementById('msgInput').addEventListener('keydown', e => {
            const enterToSend = mySettings.enterToSend !== false;
            if (e.key === 'Enter' && !e.shiftKey && enterToSend) { e.preventDefault(); sendMessage(); }
        });
        document.getElementById('msgInput').addEventListener('input', handleTyping);
        document.getElementById('msgInput').addEventListener('input', autoResizeTextarea);

        // Reply cancel
        document.getElementById('replyCancel').addEventListener('click', () => { replyingTo = null; document.getElementById('replyPreview').classList.remove('visible'); });

        // Emoji
        document.getElementById('emojiBtn').addEventListener('click', toggleEmojiPicker);
        buildEmojiPicker();

        // GIF
        document.getElementById('gifSearch').addEventListener('input', e => handleGifSearch(e.target.value));

        // Image embed
        document.getElementById('sendImageEmbed').addEventListener('click', sendImageEmbed);
        document.getElementById('imageEmbedUrl').addEventListener('keydown', e => { if (e.key === 'Enter') sendImageEmbed(); });

        // Disappear
        document.getElementById('setDisappearBtn').addEventListener('click', setDisappearingMessages);

        // Edit message
        document.getElementById('saveEditBtn').addEventListener('click', saveEditMessage);

        // Profile panel
        document.getElementById('blockUserBtn').addEventListener('click', blockUser);
        document.getElementById('removeFriendBtn').addEventListener('click', removeFriend);

        // Settings tabs
        document.querySelectorAll('.settings-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderSettingsTab(btn.dataset.tab);
            });
        });

        // Image viewer
        document.getElementById('imgViewerClose').addEventListener('click', closeImgViewer);
        document.getElementById('imgViewer').addEventListener('click', e => { if (e.target === document.getElementById('imgViewer')) closeImgViewer(); });
    }

    

    // ===================== SIDEBAR =====================
    async function loadSidebar() {
        const chatListEl = document.getElementById('chatList');
        chatListEl.innerHTML = '';

        if (activeTab === 'chats') {
            await loadChats();
        } else {
            await loadFriendsList();
        }
    }

    async function loadChats() {
        const chatListEl = document.getElementById('chatList');
    
        // Unsubscribe any previous chat list listener
        if (App._chatListOff) { App._chatListOff(); App._chatListOff = null; }
    
        const off = DB.onValue('chats', async snap => {
            const all = snap.val() || {};
            const relevant = Object.entries(all).filter(([id, c]) => c.members && c.members[session.uid]);
    
            if (relevant.length === 0) {
                chatListEl.innerHTML = '<div class="empty-list"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>No chats yet</span></div>';
                return;
            }
    
            relevant.sort((a, b) => {
                const aPinned = myProfile.pinnedChats && myProfile.pinnedChats[a[0]];
                const bPinned = myProfile.pinnedChats && myProfile.pinnedChats[b[0]];
                if (aPinned && !bPinned) return -1;
                if (!aPinned && bPinned) return 1;
                return (b[1].meta?.lastMessageAt || 0) - (a[1].meta?.lastMessageAt || 0);
            });
    
            chatListEl.innerHTML = '';
            for (const [id, data] of relevant) {
                await renderChatItem(id, data, chatListEl);
            }
        });
    
        App._chatListOff = off;
    }

    async function renderChatItem(chatId, chatData, container) {
        const isGroup = chatData.meta?.isGroup;
        let name, avatarLetter, otherUid;

        if (isGroup) {
            name = chatData.meta?.name || 'Group';
            avatarLetter = name.charAt(0).toUpperCase();
        } else {
            const memberUids = Object.keys(chatData.members || {}).filter(u => u !== session.uid);
            otherUid = memberUids[0];
            if (!otherUid) return;
            const otherProfile = await DB.get('users/' + otherUid);
            if (!otherProfile) return;
            // Check blocked
            const blocked = await DB.get('users/' + session.uid + '/blocked/' + otherUid);
            if (blocked) return;
            name = otherProfile.username;
            avatarLetter = name.charAt(0).toUpperCase();
        }

        const lastMsg = chatData.meta?.lastMessage || '';
        const lastTime = chatData.meta?.lastMessageAt;
        const pinned = myProfile.pinnedChats && myProfile.pinnedChats[chatId];
        const muted = myProfile.mutedChats && myProfile.mutedChats[chatId];

        // Unread count
        let unread = 0;
        if (chatData.messages) {
            for (const [msgId, msg] of Object.entries(chatData.messages)) {
                if (!msg.readBy || !msg.readBy[session.uid]) {
                    if (msg.senderUid !== session.uid) unread++;
                }
            }
        }

        const item = document.createElement('div');
        item.className = 'chat-list-item' + (activeChatId === chatId ? ' active' : '') + (pinned ? ' pinned' : '');
        item.dataset.chatId = chatId;

        const onlineSnap = await DB.get('presence/' + otherUid);
        const isOnline = onlineSnap?.status === 'online';

        item.innerHTML = `
            <div class="chat-avatar${isGroup ? ' group' : ''}">
                ${escHtml(avatarLetter)}
                ${!isGroup && isOnline ? '<div class="online-dot"></div>' : ''}
            </div>
            <div class="chat-info">
                <div class="chat-name">${escHtml(name)}</div>
                <div class="chat-preview">${muted ? '🔇 ' : ''}${escHtml(lastMsg.substring(0, 40))}</div>
            </div>
            <div class="chat-meta">
                <div class="chat-time">${lastTime ? formatTime(lastTime) : ''}</div>
                ${unread > 0 && !muted ? `<div class="unread-badge">${unread > 99 ? '99+' : unread}</div>` : ''}
                ${muted ? '<svg class="muted-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg>' : ''}
            </div>
        `;

        item.addEventListener('click', () => openChat(chatId, { ...chatData, isGroup, name, otherUid, avatarLetter }));
        item.addEventListener('contextmenu', e => { e.preventDefault(); showChatContextMenu(e, chatId); });
        container.appendChild(item);
    }

    async function loadFriendsList() {
        const chatListEl = document.getElementById('chatList');
        const friendsData = await DB.get('users/' + session.uid + '/friends');
        if (!friendsData) {
            chatListEl.innerHTML = '<div class="empty-list"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><span>No friends yet<br>Add someone!</span></div>';
            return;
        }

        for (const [uid, v] of Object.entries(friendsData)) {
            if (!v) continue;
            const profile = await DB.get('users/' + uid);
            if (!profile) continue;
            const presence = await DB.get('presence/' + uid);
            const isOnline = presence?.status === 'online';

            const item = document.createElement('div');
            item.className = 'chat-list-item';
            item.innerHTML = `
                <div class="chat-avatar">
                    ${escHtml(profile.username.charAt(0).toUpperCase())}
                    ${isOnline ? '<div class="online-dot"></div>' : ''}
                </div>
                <div class="chat-info">
                    <div class="chat-name">${escHtml(profile.username)}</div>
                    <div class="chat-preview">${escHtml(profile.bio?.substring(0, 40) || 'No bio')}</div>
                </div>
                <div class="chat-meta">
                    <div class="chat-time" style="color:${isOnline ? 'var(--success)' : 'var(--fg-muted)'}">${isOnline ? 'online' : 'offline'}</div>
                </div>
            `;
            item.addEventListener('click', () => startOrOpenDM(uid));
            chatListEl.appendChild(item);
        }
    }

    // ===================== CHAT OPEN =====================
    async function openChat(chatId, meta) {
        activeChatId = chatId;
        activeChatData = meta;
    
        // Update sidebar active state
        document.querySelectorAll('.chat-list-item').forEach(el => {
            el.classList.toggle('active', el.dataset.chatId === chatId);
        });
    
        document.getElementById('emptyChat').style.display = 'none';
        const chatView = document.getElementById('chatView');
        chatView.style.display = 'flex';
    
        // Header avatar
        const av = document.getElementById('chatAvatar');
        av.textContent = meta.avatarLetter || '?';
        if (meta.isGroup) {
            av.style.background = 'rgba(124,58,237,0.12)';
            av.style.color = '#7c3aed';
            av.style.borderColor = 'rgba(124,58,237,0.2)';
        } else {
            av.style.background = '';
            av.style.color = '';
            av.style.borderColor = '';
        }
        document.getElementById('chatName').textContent = meta.name;
    
        // Status + presence listener
        if (presenceListenerOff) { presenceListenerOff(); presenceListenerOff = null; }
    
        if (!meta.isGroup && meta.otherUid) {
            const presence = await DB.get('presence/' + meta.otherUid);
            updateChatStatus(presence);
            presenceListenerOff = DB.onValue('presence/' + meta.otherUid, snap => {
                updateChatStatus(snap.val());
            });
        } else if (meta.isGroup) {
            const members = await DB.get('chats/' + chatId + '/members');
            const count = Object.keys(members || {}).length;
            document.getElementById('chatStatus').textContent = count + ' members';
        }
    
        // Pin/mute button states
        const pinned = myProfile.pinnedChats && myProfile.pinnedChats[chatId];
        document.getElementById('chatPinBtn').classList.toggle('active', !!pinned);
        const muted = myProfile.mutedChats && myProfile.mutedChats[chatId];
        document.getElementById('chatMuteBtn').classList.toggle('active', !!muted);
    
        // Messages + typing
        loadMessages(chatId);
        listenTyping(chatId, meta);
        markAllRead(chatId);
    
        document.getElementById('msgInput').focus();
    }
    async function startOrOpenDM(uid) {
        // Find existing DM chat
        const chatsSnap = await DB.get('chats');
        if (chatsSnap) {
            for (const [chatId, chat] of Object.entries(chatsSnap)) {
                if (!chat.meta?.isGroup && chat.members && chat.members[session.uid] && chat.members[uid]) {
                    const profile = await DB.get('users/' + uid);
                    const name = profile?.username || uid;
                    await openChat(chatId, { isGroup: false, name, otherUid: uid, avatarLetter: name.charAt(0).toUpperCase() });
                    // Switch to chats tab
                    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.toggle('active', b.dataset.tab === 'chats'); });
                    activeTab = 'chats';
                    loadSidebar();
                    return;
                }
            }
        }

        // Create new DM
        const chatId = [session.uid, uid].sort().join('_');
        const profile = await DB.get('users/' + uid);
        const name = profile?.username || uid;
        const updates = {};
        updates['chats/' + chatId + '/members/' + session.uid] = true;
        updates['chats/' + chatId + '/members/' + uid] = true;
        updates['chats/' + chatId + '/meta'] = { isGroup: false, createdAt: Date.now(), lastMessageAt: Date.now(), lastMessage: '' };
        await DB.multiUpdate(updates);
        await openChat(chatId, { isGroup: false, name, otherUid: uid, avatarLetter: name.charAt(0).toUpperCase() });
        document.querySelectorAll('.tab-btn').forEach(b => { b.classList.toggle('active', b.dataset.tab === 'chats'); });
        activeTab = 'chats';
        loadSidebar();
    }

    // ===================== MESSAGES =====================
    function loadMessages(chatId) {
        const wrap = document.getElementById('messagesWrap');
        // Remove previous messages (keep typing indicator)
        Array.from(wrap.children).forEach(el => {
            if (!el.id) el.remove();
        });

        // Unsubscribe old listener
        if (messageListeners[chatId]) { unsub(messageListeners[chatId]); }

        const off = DB.onValue('chats/' + chatId + '/messages', snap => {
            const msgs = snap.val() || {};
            renderMessages(chatId, msgs);
        });
        messageListeners[chatId] = off;
        listeners.push(off);
    }

    function renderMessages(chatId, msgs) {
        const wrap = document.getElementById('messagesWrap');
        const typingEl = document.getElementById('typingIndicator');

        // Remove all except typing
        Array.from(wrap.children).forEach(el => {
            if (el.id !== 'typingIndicator' && el.id !== 'emojiPicker' && el.id !== 'gifPicker') el.remove();
        });

        const sorted = Object.entries(msgs).sort((a, b) => a[1].timestamp - b[1].timestamp);
        let lastDay = null;

        for (const [msgId, msg] of sorted) {
            // Check expire
            if (msg.disappearAt && Date.now() > msg.disappearAt) {
                DB.remove('chats/' + chatId + '/messages/' + msgId).catch(() => {});
                continue;
            }

            const day = new Date(msg.timestamp).toLocaleDateString();
            if (day !== lastDay) {
                const divider = document.createElement('div');
                divider.className = 'msg-day-divider';
                divider.textContent = day;
                wrap.insertBefore(divider, typingEl);
                lastDay = day;
            }

            const el = buildMsgEl(chatId, msgId, msg);
            wrap.insertBefore(el, typingEl);

            // Schedule disappear
            if (msg.disappearAt && !disappearTimers[msgId]) {
                const remaining = msg.disappearAt - Date.now();
                if (remaining > 0) {
                    disappearTimers[msgId] = setTimeout(() => {
                        DB.remove('chats/' + chatId + '/messages/' + msgId).catch(() => {});
                        el.remove();
                    }, remaining);
                }
            }
        }

        wrap.scrollTop = wrap.scrollHeight;
    }

    function buildMsgEl(chatId, msgId, msg) {
        const isSelf = msg.senderUid === session.uid;
        const wrapper = document.createElement('div');
        wrapper.className = 'msg' + (isSelf ? ' self' : '');
        wrapper.dataset.msgId = msgId;

        if (msg.deleted) {
            wrapper.innerHTML = `
                <div class="msg-header">
                    <span class="msg-sender">${escHtml(msg.sender)}</span>
                    <span class="msg-time">${formatTime(msg.timestamp)}</span>
                </div>
                <div class="msg-bubble deleted">🗑 This message was deleted</div>
            `;
            return wrapper;
        }

        let bubbleContent = '';

        if (msg.replyTo) {
            const replyText = msg.replyToContent ? escHtml(msg.replyToContent.substring(0, 80)) : 'Message';
            const replySender = msg.replyToSender ? escHtml(msg.replyToSender) : '';
            bubbleContent += `<div class="msg-reply-preview"><div class="reply-sender">${replySender}</div>${replyText}</div>`;
        }

        if (msg.imageUrl) {
            bubbleContent += `<img src="${escHtml(msg.imageUrl)}" alt="image" loading="lazy" onclick="App.openImgViewer('${escHtml(msg.imageUrl)}')">`;
        } else if (msg.gifUrl) {
            bubbleContent += `<img src="${escHtml(msg.gifUrl)}" alt="gif" loading="lazy" style="max-width:240px;border-radius:6px;display:block;margin-top:4px;" onclick="App.openImgViewer('${escHtml(msg.gifUrl)}')">`;
        } else if (msg.content) {
            bubbleContent += parseMentions(escHtml(msg.content));
        }

        // Read receipts (for self only in DMs)
        let readReceiptsHtml = '';
        if (isSelf && activeChatData && !activeChatData.isGroup) {
            const otherUid = activeChatData.otherUid;
            if (msg.readBy && msg.readBy[otherUid]) {
                readReceiptsHtml = '<div class="read-receipts"><span class="read-receipt">✓✓ Read</span></div>';
            }
        }

        // Reactions
        let reactionsHtml = '';
        if (msg.reactions) {
            const grouped = {};
            for (const [uid, emoji] of Object.entries(msg.reactions)) {
                grouped[emoji] = (grouped[emoji] || []);
                grouped[emoji].push(uid);
            }
            reactionsHtml = '<div class="msg-reactions">';
            for (const [emoji, uids] of Object.entries(grouped)) {
                const mine = uids.includes(session.uid);
                reactionsHtml += `<div class="reaction-chip${mine ? ' mine' : ''}" onclick="App.reactMsg('${chatId}','${msgId}','${escHtml(emoji)}')">
                    ${emoji} <span class="reaction-count">${uids.length}</span>
                </div>`;
            }
            reactionsHtml += '</div>';
        }

        // Actions
        const editBtn = isSelf && msg.content ? `<button class="msg-action-btn" onclick="App.startEditMsg('${chatId}','${msgId}','${escHtml(msg.content?.replace(/'/g, "\\'") || '')}')">Edit</button>` : '';
        const deleteBtn = isSelf ? `<button class="msg-action-btn danger" onclick="App.deleteMsg('${chatId}','${msgId}')">Delete</button>` : '';
        const replyBtn = `<button class="msg-action-btn" onclick="App.startReply('${msgId}','${escHtml((msg.content || '').substring(0,60).replace(/'/g, "\\'"))}','${escHtml(msg.sender)}')">Reply</button>`;
        const reactBtnEmojis = ['👍','❤️','😂','😮','😢','🔥'];
        const quickReacts = reactBtnEmojis.map(e => `<button class="msg-action-btn" onclick="App.reactMsg('${chatId}','${msgId}','${e}')">${e}</button>`).join('');

        wrapper.innerHTML = `
            <div class="msg-header">
                <span class="msg-sender">${escHtml(msg.sender)}</span>
                <span class="msg-time">${formatTime(msg.timestamp)}</span>
                ${msg.edited ? '<span class="msg-edited">(edited)</span>' : ''}
            </div>
            <div class="msg-bubble">${bubbleContent}</div>
            ${reactionsHtml}
            ${readReceiptsHtml}
            <div class="msg-actions">${quickReacts}${replyBtn}${editBtn}${deleteBtn}</div>
        `;

        return wrapper;
    }

    function parseMentions(text) {
        return text.replace(/@(\w+)/g, '<span style="color:var(--accent);font-weight:600">@$1</span>');
    }

    // ===================== SEND MESSAGE =====================
    async function sendMessage() {
        const input = document.getElementById('msgInput');
        const content = input.value.trim();
        if ((!content) || !activeChatId) return;

        input.value = '';
        autoResizeTextarea.call(input);

        // Clear typing
        clearTypingIndicator();

        const disappearAfter = await DB.get('chats/' + activeChatId + '/disappearAfter') || 0;
        const msgData = {
            sender: session.username,
            senderUid: session.uid,
            content: content,
            timestamp: Date.now(),
            edited: false
        };

        if (replyingTo) {
            msgData.replyTo = replyingTo.msgId;
            msgData.replyToContent = replyingTo.content;
            msgData.replyToSender = replyingTo.sender;
            replyingTo = null;
            document.getElementById('replyPreview').classList.remove('visible');
        }

        if (disappearAfter > 0) {
            msgData.disappearAt = Date.now() + disappearAfter;
        }

        const msgId = await DB.push('chats/' + activeChatId + '/messages', msgData);
        await DB.update('chats/' + activeChatId + '/meta', {
            lastMessage: content.substring(0, 60),
            lastMessageAt: Date.now()
        });

        // Update streak
        updateStreak();
    }

    function handleTyping() {
        if (!activeChatId) return;
        DB.set('chats/' + activeChatId + '/typing/' + session.uid, true).catch(() => {});
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(clearTypingIndicator, 2500);
    }

    function clearTypingIndicator() {
        if (activeChatId) {
            DB.set('chats/' + activeChatId + '/typing/' + session.uid, false).catch(() => {});
        }
    }

    function listenTyping(chatId, meta) {
        if (typingListeners[chatId]) unsub(typingListeners[chatId]);
        const off = DB.onValue('chats/' + chatId + '/typing', snap => {
            const typing = snap.val() || {};
            const typers = Object.entries(typing).filter(([uid, v]) => uid !== session.uid && v === true).map(([uid]) => uid);
            const el = document.getElementById('typingIndicator');
            const nameEl = document.getElementById('typingName');
            if (typers.length > 0) {
                nameEl.textContent = (meta.isGroup ? (typers[0] + ' is') : '') + ' typing...';
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
            }
            document.getElementById('messagesWrap').scrollTop = document.getElementById('messagesWrap').scrollHeight;
        });
        typingListeners[chatId] = off;
        listeners.push(off);
    }

    async function markAllRead(chatId) {
        const msgs = await DB.get('chats/' + chatId + '/messages');
        if (!msgs) return;
        const updates = {};
        for (const [msgId, msg] of Object.entries(msgs)) {
            if (msg.senderUid !== session.uid && (!msg.readBy || !msg.readBy[session.uid])) {
                updates['chats/' + chatId + '/messages/' + msgId + '/readBy/' + session.uid] = Date.now();
            }
        }
        if (Object.keys(updates).length > 0) await DB.multiUpdate(updates);
    }

    // ===================== MESSAGE ACTIONS =====================
    function startReply(msgId, content, sender) {
        replyingTo = { msgId, content, sender };
        document.getElementById('replyPreviewText').textContent = sender + ': ' + content;
        document.getElementById('replyPreview').classList.add('visible');
        document.getElementById('msgInput').focus();
    }

    function startEditMsg(chatId, msgId, content) {
        editingMsg = { chatId, msgId };
        document.getElementById('editMsgInput').value = content;
        openModal('editMsgModal');
    }

    async function saveEditMessage() {
        if (!editingMsg) return;
        const newContent = document.getElementById('editMsgInput').value.trim();
        if (!newContent) return;
        await DB.update('chats/' + editingMsg.chatId + '/messages/' + editingMsg.msgId, {
            content: newContent, edited: true
        });
        closeModal('editMsgModal');
        editingMsg = null;
    }

    async function deleteMsg(chatId, msgId) {
        if (!confirm('Delete this message?')) return;
        await DB.update('chats/' + chatId + '/messages/' + msgId, { deleted: true, content: null, imageUrl: null, gifUrl: null });
    }

    async function reactMsg(chatId, msgId, emoji) {
        const path = 'chats/' + chatId + '/messages/' + msgId + '/reactions/' + session.uid;
        const current = await DB.get(path);
        if (current === emoji) {
            await DB.remove(path);
        } else {
            await DB.set(path, emoji);
        }
    }

    // ===================== IMAGE / GIF =====================
    async function sendImageEmbed() {
        const url = document.getElementById('imageEmbedUrl').value.trim();
        if (!url || !activeChatId) return;
        if (!url.startsWith('http')) {
            showModalError('imageEmbedError', 'Please enter a valid URL');
            return;
        }
        await DB.push('chats/' + activeChatId + '/messages', {
            sender: session.username, senderUid: session.uid,
            imageUrl: url, timestamp: Date.now()
        });
        await DB.update('chats/' + activeChatId + '/meta', { lastMessage: '📷 Image', lastMessageAt: Date.now() });
        document.getElementById('imageEmbedUrl').value = '';
        closeModal('imageEmbedModal');
    }

    async function sendGif(url) {
        if (!activeChatId) return;
        await DB.push('chats/' + activeChatId + '/messages', {
            sender: session.username, senderUid: session.uid,
            gifUrl: url, timestamp: Date.now()
        });
        await DB.update('chats/' + activeChatId + '/meta', { lastMessage: '🎬 GIF', lastMessageAt: Date.now() });
        document.getElementById('gifPicker').classList.remove('visible');
    }

    function handleGifSearch(query) {
        const grid = document.getElementById('gifGrid');
        if (!query) { grid.innerHTML = ''; return; }
        // Since we can't use Tenor API without a key, show a note to use direct URLs
        grid.innerHTML = `<div style="font-size:11px;color:var(--fg-muted);grid-column:1/-1;text-align:center;padding:10px;">
            Use the Embed Image button to send GIFs by URL.<br>Try <a href="https://tenor.com" target="_blank" style="color:var(--accent)">Tenor.com</a> to find GIF links.
        </div>`;
    }

    function toggleGifPicker() {
        const gif = document.getElementById('gifPicker');
        const emoji = document.getElementById('emojiPicker');
        emoji.classList.remove('visible');
        gif.classList.toggle('visible');
    }

    // ===================== EMOJI =====================
    const EMOJIS = {
        'Smileys': ['😀','😂','🥹','😊','😇','🙂','😉','😍','🥰','😘','😜','🤩','😎','🥲','😢','😭','😤','😡','🤬','🤯','😱','🥶','🤗','🤔','🫡','🤫','🫠','😴','🥴','🤢','🤮','🤧'],
        'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💖','💗','💕','💞','💓','💝','💘','💔','❣️'],
        'Hands': ['👍','👎','👌','🤌','✌️','🤞','🫶','🤝','🙏','👏','🫰','🤜','👊','✊','🫳','💪','🦵','🦶'],
        'Objects': ['🔥','✨','⭐','🌟','💫','⚡','🎉','🎊','🎈','🎯','🏆','💎','👑','🔑','🗝️','💡','🔮','🎭','🎪','🎸','🎺','🎻'],
        'Nature': ['🌺','🌸','🌼','🌻','🌷','🌹','🍀','🌿','🌱','🌲','🌳','🍄','🌊','🌙','☀️','⛅','🌈','❄️','🔥','💧'],
        'Food': ['🍕','🍔','🌮','🌯','🍜','🍣','🍱','🍩','🍪','🎂','🍰','🧁','🍭','🍫','🍬','🍺','🥤','☕','🧃'],
        'Animals': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🦆','🦅','🦉'],
    };

    function buildEmojiPicker() {
        const picker = document.getElementById('emojiPicker');
        picker.innerHTML = '';
        for (const [cat, emojis] of Object.entries(EMOJIS)) {
            const catEl = document.createElement('div');
            catEl.className = 'emoji-category';
            catEl.textContent = cat;
            picker.appendChild(catEl);
            const grid = document.createElement('div');
            grid.className = 'emoji-grid';
            for (const emoji of emojis) {
                const btn = document.createElement('button');
                btn.className = 'emoji-btn';
                btn.textContent = emoji;
                btn.addEventListener('click', () => {
                    const input = document.getElementById('msgInput');
                    const pos = input.selectionStart;
                    input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
                    input.selectionStart = input.selectionEnd = pos + emoji.length;
                    input.focus();
                    document.getElementById('emojiPicker').classList.remove('visible');
                });
                grid.appendChild(btn);
            }
            picker.appendChild(grid);
        }
    }

    function toggleEmojiPicker() {
        const emoji = document.getElementById('emojiPicker');
        const gif = document.getElementById('gifPicker');
        gif.classList.remove('visible');
        emoji.classList.toggle('visible');
    }

    // ===================== DISAPPEARING MESSAGES =====================
    async function setDisappearingMessages() {
        if (!activeChatId) return;
        const val = parseInt(document.getElementById('disappearSelect').value);
        await DB.set('chats/' + activeChatId + '/disappearAfter', val);
        addSystemMsg(val === 0 ? 'Disappearing messages turned off' : `Messages will disappear after ${formatDuration(val)}`);
        closeModal('disappearModal');
    }

    function formatDuration(ms) {
        if (ms < 60000) return (ms/1000) + ' seconds';
        if (ms < 3600000) return (ms/60000) + ' minutes';
        if (ms < 86400000) return (ms/3600000) + ' hour(s)';
        return (ms/86400000) + ' day(s)';
    }

    // ===================== FRIENDS =====================
    async function sendFriendRequest() {
        const username = document.getElementById('addFriendInput').value.trim();
        clearModalMsg('addFriendError');
        clearModalMsg('addFriendSuccess');

        if (!username) { showModalError('addFriendError', 'Enter a username'); return; }
        if (username.toLowerCase() === session.username.toLowerCase()) {
            showModalError('addFriendError', "You can't add yourself"); return;
        }

        const usernameLookup = await DB.get('usernames/' + username);
        if (!usernameLookup) { showModalError('addFriendError', 'User not found'); return; }

        const targetUid = usernameLookup.uid;

        // Check if already friends
        const alreadyFriend = await DB.get('users/' + session.uid + '/friends/' + targetUid);
        if (alreadyFriend) { showModalError('addFriendError', 'Already friends with this user'); return; }

        // Check if blocked
        const blocked = await DB.get('users/' + session.uid + '/blocked/' + targetUid);
        if (blocked) { showModalError('addFriendError', 'You have blocked this user'); return; }

        // Send request
        await DB.set('friendRequests/' + targetUid + '/' + session.uid, {
            from: session.uid,
            fromUsername: session.username,
            timestamp: Date.now()
        });

        showModalSuccess('addFriendSuccess', 'Friend request sent!');
        document.getElementById('addFriendInput').value = '';
    }

    async function loadFriendRequests() {
        const container = document.getElementById('friendRequestsList');
        container.innerHTML = '';
        const requests = await DB.get('friendRequests/' + session.uid);

        if (!requests || Object.keys(requests).length === 0) {
            container.innerHTML = '<div style="text-align:center;color:var(--fg-muted);font-size:11px;padding:20px;">No pending requests</div>';
            return;
        }

        for (const [fromUid, req] of Object.entries(requests)) {
            const item = document.createElement('div');
            item.className = 'request-item';
            item.innerHTML = `
                <div class="request-avatar">${escHtml(req.fromUsername.charAt(0).toUpperCase())}</div>
                <div class="request-info">
                    <div class="request-name">${escHtml(req.fromUsername)}</div>
                    <div class="request-sub">${timeAgo(req.timestamp)}</div>
                </div>
                <div class="request-actions">
                    <button class="accept-btn">Accept</button>
                    <button class="decline-btn">Decline</button>
                </div>
            `;
            item.querySelector('.accept-btn').addEventListener('click', () => acceptFriendRequest(fromUid, req.fromUsername, item));
            item.querySelector('.decline-btn').addEventListener('click', () => declineFriendRequest(fromUid, item));
            container.appendChild(item);
        }
    }

    async function acceptFriendRequest(fromUid, fromUsername, item) {
        const updates = {};
        updates['users/' + session.uid + '/friends/' + fromUid] = true;
        updates['users/' + fromUid + '/friends/' + session.uid] = true;
        updates['friendRequests/' + session.uid + '/' + fromUid] = null;
        await DB.multiUpdate(updates);
        item.remove();
        loadSidebar();
    }

    async function declineFriendRequest(fromUid, item) {
        await DB.remove('friendRequests/' + session.uid + '/' + fromUid);
        item.remove();
    }

    function listenFriendRequests() {
        const off = DB.onValue('friendRequests/' + session.uid, snap => {
            const reqs = snap.val() || {};
            const count = Object.keys(reqs).length;
            const badge = document.getElementById('friendReqBadge');
            badge.classList.toggle('visible', count > 0);
        });
        listeners.push(off);
    }

    async function blockUser() {
        if (!profilePanelUserId) return;
        if (!confirm('Block this user?')) return;
        await DB.set('users/' + session.uid + '/blocked/' + profilePanelUserId, true);
        // Remove friend if they are one
        await DB.remove('users/' + session.uid + '/friends/' + profilePanelUserId);
        await DB.remove('users/' + profilePanelUserId + '/friends/' + session.uid);
        toggleProfilePanel(false);
        loadSidebar();
        addSystemMsg('User blocked');
    }

    async function removeFriend() {
        if (!profilePanelUserId) return;
        if (!confirm('Remove this friend?')) return;
        await DB.remove('users/' + session.uid + '/friends/' + profilePanelUserId);
        await DB.remove('users/' + profilePanelUserId + '/friends/' + session.uid);
        toggleProfilePanel(false);
        loadSidebar();
        addSystemMsg('Friend removed');
    }

    // ===================== GROUP CHATS =====================
    function openNewGroupModal() {
        document.getElementById('groupNameInput').value = '';
        buildGroupMemberList();
        openModal('newGroupModal');
    }

    async function buildGroupMemberList() {
        const container = document.getElementById('groupMemberList');
        container.innerHTML = '';
        const friendsData = await DB.get('users/' + session.uid + '/friends');
        if (!friendsData) { container.textContent = 'No friends to add'; return; }

        for (const [uid, v] of Object.entries(friendsData)) {
            if (!v) continue;
            const profile = await DB.get('users/' + uid);
            if (!profile) continue;
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;padding:4px 8px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;';
            label.innerHTML = `<input type="checkbox" value="${uid}" style="accent-color:var(--accent);"> ${escHtml(profile.username)}`;
            container.appendChild(label);
        }
    }

    async function createGroup() {
        const name = document.getElementById('groupNameInput').value.trim();
        if (!name) { showModalError('newGroupError', 'Group name required'); return; }

        const checked = Array.from(document.getElementById('groupMemberList').querySelectorAll('input:checked')).map(el => el.value);
        if (checked.length === 0) { showModalError('newGroupError', 'Add at least one friend'); return; }

        const chatId = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
        const members = { [session.uid]: true };
        checked.forEach(uid => { members[uid] = true; });

        await DB.set('chats/' + chatId, {
            members,
            meta: { isGroup: true, name, createdAt: Date.now(), lastMessageAt: Date.now(), lastMessage: '' },
            disappearAfter: 0
        });

        // Post system message
        await DB.push('chats/' + chatId + '/messages', {
            sender: 'System', senderUid: 'system',
            content: session.username + ' created the group',
            timestamp: Date.now()
        });

        closeModal('newGroupModal');
        loadSidebar();
        openChat(chatId, { isGroup: true, name, avatarLetter: name.charAt(0).toUpperCase() });
    }

    // ===================== MUTE / PIN =====================
    async function toggleMuteChat() {
        if (!activeChatId) return;
        const path = 'users/' + session.uid + '/mutedChats/' + activeChatId;
        const current = await DB.get(path);
        if (current) { await DB.remove(path); } else { await DB.set(path, true); }
        myProfile = await DB.get('users/' + session.uid);
        document.getElementById('chatMuteBtn').classList.toggle('active', !current);
        loadSidebar();
    }

    async function togglePinChat() {
        if (!activeChatId) return;
        const path = 'users/' + session.uid + '/pinnedChats/' + activeChatId;
        const current = await DB.get(path);
        if (current) { await DB.remove(path); } else { await DB.set(path, true); }
        myProfile = await DB.get('users/' + session.uid);
        document.getElementById('chatPinBtn').classList.toggle('active', !current);
        loadSidebar();
    }

    // ===================== PROFILE PANEL =====================
    async function toggleProfilePanel(open, uid) {
        profilePanelOpen = open;
        profilePanelUserId = uid || null;
        const panel = document.getElementById('profilePanel');

        if (!open) { panel.classList.add('hidden'); return; }
        panel.classList.remove('hidden');

        if (!uid) return;
        const profile = await DB.get('users/' + uid);
        if (!profile) return;

        document.getElementById('profileAvatarLg').textContent = profile.username.charAt(0).toUpperCase();
        document.getElementById('profileUsername').textContent = '@' + profile.username;

        const presence = await DB.get('presence/' + uid);
        const isOnline = presence?.status === 'online';
        document.getElementById('profileStatusDot').className = 'profile-status-dot' + (isOnline ? ' online' : '');
        document.getElementById('profileStatusText').textContent = isOnline ? 'Online' : ('Last seen ' + (presence?.lastSeen ? timeAgo(presence.lastSeen) : 'unknown'));

        document.getElementById('profileBio').textContent = profile.bio || 'No bio set';
        const moodEl = document.getElementById('profileMood');
        if (profile.mood) { moodEl.textContent = '🎭 ' + profile.mood; moodEl.style.display = 'inline-block'; }
        else moodEl.style.display = 'none';

        // Streak
        const chatId = [session.uid, uid].sort().join('_');
        const streak = await DB.get('chats/' + chatId + '/streak');
        const streakEl = document.getElementById('profileStreak');
        if (streak) { streakEl.style.display = 'block'; document.getElementById('profileStreakCount').textContent = streak; }
        else streakEl.style.display = 'none';
    }

    // ===================== STREAKS =====================
    async function checkDailyStreak() {
        const lastLogin = await DB.get('users/' + session.uid + '/lastLoginDate');
        const today = new Date().toDateString();
        if (lastLogin !== today) {
            await DB.set('users/' + session.uid + '/lastLoginDate', today);
        }
    }

    async function updateStreak() {
        if (!activeChatId || !activeChatData || activeChatData.isGroup) return;
        const otherUid = activeChatData.otherUid;
        if (!otherUid) return;
        const chatId = activeChatId;
        const today = new Date().toDateString();
        const lastDay = await DB.get('chats/' + chatId + '/lastStreakDate');
        if (lastDay === today) return;
        const yesterday = new Date(Date.now() - 86400000).toDateString();
        const current = (await DB.get('chats/' + chatId + '/streak')) || 0;
        const newStreak = (lastDay === yesterday) ? current + 1 : 1;
        await DB.update('chats/' + chatId, { streak: newStreak, lastStreakDate: today });
    }

    // ===================== PRESENCE =====================
    function listenPresence() {
        // Poll friends' presence
    }

    // ===================== SCREENSHOT DETECTION =====================
    function setupScreenshotDetection() {
        document.addEventListener('keydown', e => {
            if ((e.key === 'PrintScreen') || (e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4' || e.key === 's'))) {
                notifyScreenshot();
            }
        });
        document.addEventListener('visibilitychange', () => {
            // Can't detect actual screenshots but notify on relevant combos
        });
    }

    function notifyScreenshot() {
        const banner = document.createElement('div');
        banner.className = 'screenshot-banner';
        banner.textContent = '📸 Screenshot detected — recipients will be notified';
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), 3000);
        // Notify in chat
        if (activeChatId) {
            DB.push('chats/' + activeChatId + '/messages', {
                sender: 'System', senderUid: 'system',
                content: session.username + ' took a screenshot',
                timestamp: Date.now()
            }).catch(() => {});
        }
    }

    // ===================== SETTINGS =====================
    function openSettings() {
        renderSettingsTab('account');
        openModal('settingsModal');
    }

    async function renderSettingsTab(tab) {
        const content = document.getElementById('settingsContent');
        content.innerHTML = '';

        if (tab === 'account') {
            content.innerHTML = `
                <div class="settings-section">
                    <div class="settings-section-title">Account</div>
                    <div class="input-group">
                        <label class="input-label">Username</label>
                        <input class="input-field" value="${escHtml(session.username)}" disabled style="opacity:.6;">
                    </div>
                    <div class="input-group">
                        <label class="input-label">Bio</label>
                        <textarea class="input-field" id="setBioInput" style="min-height:70px;">${escHtml(myProfile.bio || '')}</textarea>
                    </div>
                    <div class="input-group">
                        <label class="input-label">Mood Status</label>
                        <input class="input-field" id="setMoodInput" placeholder="How are you feeling?" maxlength="100" value="${escHtml(myProfile.mood || '')}">
                    </div>
                    <div class="input-group">
                        <label class="input-label">Change Password</label>
                        <input type="password" class="input-field" id="newPasswordInput" placeholder="New password (min 8 chars)">
                    </div>
                    <button class="btn btn-primary" id="saveAccountBtn" style="width:100%;">Save Changes</button>
                    <div class="modal-success" id="accountSaveSuccess" style="margin-top:10px;"></div>
                    <div class="modal-error" id="accountSaveError" style="margin-top:10px;"></div>
                </div>
            `;
            document.getElementById('saveAccountBtn').addEventListener('click', async () => {
                const bio = document.getElementById('setBioInput').value.trim().substring(0, 200);
                const mood = document.getElementById('setMoodInput').value.trim().substring(0, 100);
                const newPw = document.getElementById('newPasswordInput').value;
                const updates = { bio, mood };
                if (newPw) {
                    if (newPw.length < 8) { showModalError('accountSaveError', 'Password must be 8+ chars'); return; }
                    const { hash, salt } = await Auth.signUp.__proto__ || {};
                    // Re-hash password directly
                    const enc = new TextEncoder();
                    const salt2 = crypto.getRandomValues(new Uint8Array(16));
                    const keyMat = await crypto.subtle.importKey('raw', enc.encode(newPw), 'PBKDF2', false, ['deriveBits']);
                    const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt:salt2, iterations:100000, hash:'SHA-256' }, keyMat, 256);
                    const b64 = v => { let s=''; new Uint8Array(v).forEach(b => s += String.fromCharCode(b)); return btoa(s); };
                    updates.passwordHash = b64(bits);
                    updates.passwordSalt = b64(salt2);
                }
                await DB.update('users/' + session.uid, updates);
                myProfile = { ...myProfile, ...updates };
                document.getElementById('myMood').textContent = mood || 'No mood set';
                const successEl = document.getElementById('accountSaveSuccess');
                successEl.textContent = 'Saved!'; successEl.classList.add('visible');
                setTimeout(() => successEl.classList.remove('visible'), 2000);
            });
        }

        else if (tab === 'privacy') {
            const s = mySettings;
            content.innerHTML = `
                <div class="settings-section">
                    <div class="settings-section-title">Privacy</div>
                    <div class="setting-row"><div><div class="setting-label">Show Online Status</div><div class="setting-sub">Let others see when you're online</div></div><div class="toggle ${s.showOnlineStatus !== false ? 'on' : ''}" data-key="showOnlineStatus"></div></div>
                    <div class="setting-row"><div><div class="setting-label">Show Last Seen</div><div class="setting-sub">Let others see your last seen time</div></div><div class="toggle ${s.showLastSeen !== false ? 'on' : ''}" data-key="showLastSeen"></div></div>
                    <div class="setting-row"><div><div class="setting-label">Read Receipts</div><div class="setting-sub">Send read confirmations</div></div><div class="toggle ${s.readReceipts !== false ? 'on' : ''}" data-key="readReceipts"></div></div>
                </div>
                <div class="settings-section">
                    <div class="settings-section-title">Blocked Users</div>
                    <div id="blockedList"></div>
                </div>
            `;
            content.querySelectorAll('.toggle').forEach(t => {
                t.addEventListener('click', async () => {
                    t.classList.toggle('on');
                    const key = t.dataset.key;
                    mySettings[key] = t.classList.contains('on');
                    await DB.update('users/' + session.uid, { settings: JSON.stringify(mySettings) });
                });
            });
            // Load blocked
            const blocked = await DB.get('users/' + session.uid + '/blocked');
            const bl = document.getElementById('blockedList');
            if (!blocked || Object.keys(blocked).length === 0) { bl.innerHTML = '<div style="font-size:11px;color:var(--fg-muted);">No blocked users</div>'; }
            else {
                for (const [uid, v] of Object.entries(blocked)) {
                    if (!v) continue;
                    const p = await DB.get('users/' + uid);
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);';
                    row.innerHTML = `<span style="font-size:12px">${escHtml(p?.username || uid)}</span><button class="btn btn-danger" style="padding:5px 12px;font-size:11px;">Unblock</button>`;
                    row.querySelector('button').addEventListener('click', async () => {
                        await DB.remove('users/' + session.uid + '/blocked/' + uid);
                        row.remove();
                    });
                    bl.appendChild(row);
                }
            }
        }

        else if (tab === 'security') {
            const sessions = await Auth.getActiveSessions(session.uid);
            content.innerHTML = `
                <div class="settings-section">
                    <div class="settings-section-title">Active Sessions</div>
                    <div id="sessionsList"></div>
                </div>
            `;
            const sl = document.getElementById('sessionsList');
            for (const s of sessions) {
                const row = document.createElement('div');
                row.style.cssText = 'background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;font-size:11px;';
                row.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">Current Session</div><div style="color:var(--fg-muted)">${escHtml(s.userAgent?.substring(0,80) || 'Unknown device')}</div><div style="color:var(--fg-muted);margin-top:4px;">Created ${timeAgo(s.createdAt)}</div>`;
                sl.appendChild(row);
            }
        }

        else if (tab === 'chats') {
            const s = mySettings;
            content.innerHTML = `
                <div class="settings-section">
                    <div class="settings-section-title">Chats</div>
                    <div class="setting-row"><div><div class="setting-label">Enter to Send</div><div class="setting-sub">Press Enter to send, Shift+Enter for newline</div></div><div class="toggle ${s.enterToSend !== false ? 'on' : ''}" data-key="enterToSend"></div></div>
                    <div class="setting-row"><div><div class="setting-label">Notifications</div></div><div class="toggle ${s.notificationsEnabled !== false ? 'on' : ''}" data-key="notificationsEnabled"></div></div>
                    <div class="input-group" style="margin-top:16px;">
                        <label class="input-label">Default Disappearing Messages</label>
                        <select class="input-field" id="defaultDisappear">
                            <option value="0" ${!s.disappearingDefault ? 'selected' : ''}>Off</option>
                            <option value="300000" ${s.disappearingDefault === 300000 ? 'selected' : ''}>5 minutes</option>
                            <option value="3600000" ${s.disappearingDefault === 3600000 ? 'selected' : ''}>1 hour</option>
                            <option value="86400000" ${s.disappearingDefault === 86400000 ? 'selected' : ''}>24 hours</option>
                        </select>
                    </div>
                </div>
            `;
            content.querySelectorAll('.toggle').forEach(t => {
                t.addEventListener('click', async () => {
                    t.classList.toggle('on');
                    mySettings[t.dataset.key] = t.classList.contains('on');
                    await DB.update('users/' + session.uid, { settings: JSON.stringify(mySettings) });
                });
            });
            document.getElementById('defaultDisappear')?.addEventListener('change', async e => {
                mySettings.disappearingDefault = parseInt(e.target.value);
                await DB.update('users/' + session.uid, { settings: JSON.stringify(mySettings) });
            });
        }

        else if (tab === 'appearance') {
            content.innerHTML = `
                <div class="settings-section">
                    <div class="settings-section-title">Appearance</div>
                    <div class="setting-row"><div><div class="setting-label">Theme</div><div class="setting-sub">Only dark theme available</div></div><div style="font-size:11px;color:var(--accent);">Dark</div></div>
                </div>
            `;
        }

        else if (tab === 'data') {
            content.innerHTML = `
                <div class="settings-section">
                    <div class="settings-section-title">Data</div>
                    <div style="font-size:11px;color:var(--fg-muted);margin-bottom:16px;">Your messages are stored in Firebase RTDB. Only accessible to chat participants.</div>
                    <button class="btn" id="clearCacheBtn" style="width:100%;margin-bottom:8px;">Clear Local Cache</button>
                    <button class="btn btn-danger" id="exportDataBtn" style="width:100%;">Export My Data (JSON)</button>
                </div>
            `;
            content.querySelector('#clearCacheBtn').addEventListener('click', () => {
                localStorage.removeItem('bk_cache');
                alert('Cache cleared');
            });
            content.querySelector('#exportDataBtn').addEventListener('click', async () => {
                const data = { profile: myProfile, session: { username: session.username } };
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'blackkeep-data.json';
                a.click();
            });
        }

        else if (tab === 'danger') {
            content.innerHTML = `
                <div class="settings-section">
                    <div class="settings-section-title" style="color:var(--error)">Danger Zone</div>
                    <button class="btn btn-danger" id="logoutBtn" style="width:100%;margin-bottom:8px;">Logout</button>
                    <button class="btn btn-danger" id="deleteAccountBtn" style="width:100%;">Delete Account</button>
                </div>
            `;
            content.querySelector('#logoutBtn').addEventListener('click', async () => {
                await DB.update('users/' + session.uid, { status: 'offline', lastSeen: Date.now() });
                await Auth.signOut(session.token);
                window.location.href = 'index.html';
            });
            content.querySelector('#deleteAccountBtn').addEventListener('click', async () => {
                if (!confirm('Delete your account? This cannot be undone.')) return;
                const username = prompt('Type your username to confirm:');
                if (username !== session.username) { alert('Username mismatch'); return; }
                await DB.remove('users/' + session.uid);
                await DB.remove('usernames/' + session.username);
                await Auth.signOut(session.token);
                window.location.href = 'index.html';
            });
        }
    }

    // ===================== SEARCH / FILTER =====================
    function filterChatList(query) {
        const items = document.querySelectorAll('.chat-list-item');
        const q = query.toLowerCase();
        items.forEach(item => {
            const name = item.querySelector('.chat-name')?.textContent.toLowerCase() || '';
            item.style.display = name.includes(q) ? '' : 'none';
        });
    }

    // ===================== HELPERS =====================
    function addSystemMsg(text, type = '') {
        const wrap = document.getElementById('messagesWrap');
        if (!wrap) return;
        const el = document.createElement('div');
        el.className = 'system-msg' + (type ? ' ' + type : '');
        el.textContent = text;
        const typingEl = document.getElementById('typingIndicator');
        wrap.insertBefore(el, typingEl);
        wrap.scrollTop = wrap.scrollHeight;
    }

    function openModal(id) {
        document.getElementById(id)?.classList.add('visible');
    }
    function closeModal(id) {
        document.getElementById(id)?.classList.remove('visible');
    }
    function closeAllModals() {
        document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('visible'));
    }

    function showModalError(id, msg) {
        const el = document.getElementById(id);
        if (el) { el.textContent = msg; el.classList.add('visible'); }
    }
    function clearModalMsg(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('visible');
    }
    function showModalSuccess(id, msg) {
        const el = document.getElementById(id);
        if (el) { el.textContent = msg; el.classList.add('visible'); }
    }

    function openImgViewer(url) {
        const viewer = document.getElementById('imgViewer');
        const content = document.getElementById('imgViewerContent');
        content.innerHTML = '';
        const img = document.createElement('img');
        img.src = url;
        content.appendChild(img);
        viewer.classList.add('visible');
    }
    function closeImgViewer() {
        document.getElementById('imgViewer').classList.remove('visible');
    }

    function autoResizeTextarea() {
        const el = document.getElementById('msgInput');
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }

    function showChatContextMenu(e, chatId) {
        // Simple right-click info
    }

    function escHtml(text) {
        if (!text) return '';
        const d = document.createElement('div');
        d.textContent = String(text);
        return d.innerHTML;
    }

    function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (now - d < 7 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function timeAgo(ts) {
        const diff = Date.now() - ts;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
        return Math.floor(diff/86400000) + 'd ago';
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    return {
        init,
        // Exposed for inline handlers
        openImgViewer,
        reactMsg,
        startReply,
        startEditMsg,
        deleteMsg,
        _chatListOff: null,
    };
})();

document.addEventListener('DOMContentLoaded', App.init);
