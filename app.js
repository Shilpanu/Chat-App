const DB_NAME = 'pwa-chat-db';
const DB_VERSION = 1;
const API_BASE = '/pwa-chat-app/api/messages';

let db = null;
const messagesList = document.getElementById('messages-list');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const statusBadge = document.getElementById('status-badge');
const sender = 'User_' + Math.random().toString(36).substring(2, 6);

init();

async function init() {
  db = await openDB();
  registerSW();
  loadMessages();
  setupListeners();
  updateOnlineStatus();
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      console.log('SW registered', reg.scope);

      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'message-synced') {
          updateMessageStatus(event.data.id, 'sent');
        }
      });
    }).catch(err => console.error('SW registration failed', err));
  }
}

async function loadMessages() {
  const messages = await fetchMessages();
  const local = await getLocalMessages();
  const all = mergeMessages(messages, local);
  renderMessages(all);
}

async function fetchMessages() {
  try {
    const res = await fetch(API_BASE);
    if (res.ok) {
      const data = await res.json();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      for (const msg of data) {
        if (!msg.id) msg.id = crypto.randomUUID();
        store.put(msg);
      }
      await done(tx);
      return data;
    }
  } catch {}
  return [];
}

function mergeMessages(server, local) {
  const map = new Map();
  for (const m of server) map.set(m.id, { ...m, status: 'sent' });
  for (const m of local) {
    if (!map.has(m.id)) map.set(m.id, m);
  }
  return [...map.values()].sort((a, b) =>
    new Date(a.timestamp) - new Date(b.timestamp)
  );
}

function renderMessages(messages) {
  messagesList.innerHTML = '';
  for (const msg of messages) {
    messagesList.appendChild(createMessageElement(msg));
  }
  scrollToBottom();
}

function createMessageElement(msg) {
  const div = document.createElement('div');
  const isMine = msg.sender === sender;
  div.className = `message ${isMine ? 'sent' : 'received'}`;
  if (msg.status === 'pending') div.classList.add('pending');
  div.dataset.id = msg.id;

  const senderEl = msg.sender && !isMine
    ? `<span class="msg-sender">${escapeHtml(msg.sender)}</span>`
    : '';

  const statusIcon = isMine
    ? `<span class="msg-status">${msg.status === 'pending' ? '⏳' : '✓'}</span>`
    : '';

  div.innerHTML = `
    ${senderEl}
    ${escapeHtml(msg.text)}
    <span class="msg-time">${formatTime(msg.timestamp)}${statusIcon}</span>
  `;
  return div;
}

function updateMessageStatus(id, status) {
  const el = messagesList.querySelector(`[data-id="${id}"]`);
  if (el) {
    el.classList.remove('pending');
    const statusEl = el.querySelector('.msg-status');
    if (statusEl) statusEl.textContent = status === 'sent' ? '✓' : '⏳';
  }
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = '';

  const msg = {
    id: crypto.randomUUID(),
    text,
    sender,
    timestamp: new Date().toISOString(),
    status: 'pending'
  };

  addMessageToUI(msg);

  const online = navigator.onLine;

  if (online) {
    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sender, timestamp: msg.timestamp })
      });
      if (res.ok) {
        msg.status = 'sent';
        updateMessageStatus(msg.id, 'sent');
        return;
      }
    } catch {}
  }

  await addToOutbox(msg);
  registerSync();
}

function addMessageToUI(msg) {
  messagesList.appendChild(createMessageElement(msg));
  scrollToBottom();
}

async function addToOutbox(msg) {
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').put(msg);
  await done(tx);
}

function registerSync() {
  if ('sync' in navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(reg => {
      reg.sync.register('sync-messages').catch(() => {});
    });
  }
}

async function getLocalMessages() {
  const tx = db.transaction('outbox', 'readonly');
  const store = tx.objectStore('outbox');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  statusBadge.textContent = online ? 'Online' : 'Offline';
  statusBadge.className = online ? 'status-online' : 'status-offline';
  sendBtn.disabled = !online;
  if (online) messageInput.placeholder = 'Type a message...';
  else messageInput.placeholder = 'Offline — messages will queue';
}

function setupListeners() {
  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
  });

  window.addEventListener('online', () => {
    updateOnlineStatus();
    registerSync();
    loadMessages();
  });

  window.addEventListener('offline', updateOnlineStatus);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('messages')) {
        d.createObjectStore('messages', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('outbox')) {
        d.createObjectStore('outbox', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

function scrollToBottom() {
  const container = document.getElementById('messages-container');
  container.scrollTop = container.scrollHeight;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
