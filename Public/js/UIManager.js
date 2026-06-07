class UIManager {
  constructor(socketClient) {
    this.client = socketClient;
    this.container = document.getElementById('app');
    this.roomId = null;
    this.characterId = null;
    this.phase = 'lobby';
    this.isHost = false;
    this.hostId = null;
    this.revealedClues = [];
    this.hiddenClueContent = {};
    this.voteCounts = { round1: 0, round2: 0, total: 1 };
    this.phaseDeadline = null;
    this.currentPlayers = {};
    this.myVotes = { round1: null, round2: null };
    this.token = localStorage.getItem('murder_token') || null;
    this._timerHandle = null;
    this._secret = null;
    this.selectedScript = 'default';
    this.roomCreatedAt = null;
    this._bindEvents();
    this._tryReconnect();
  }

  _bindEvents() {
    this.client.events.on('room:update', (data) => {
      this.currentPlayers = data.players || {};
      this.hostId = data.hostId;
      this.isHost = this.client.socket.id === data.hostId;
      this.voteCounts = data.voteCounts || this.voteCounts;
      this.phaseDeadline = data.phaseDeadline;
      if (data.createdAt) this.roomCreatedAt = data.createdAt;
      this._updateLobbyPlayers();
      this._updateChatTargets();
      this._updateTimer();
    });
    this.client.events.on('phase:change', (phase) => { this.phase = phase; this._renderPhase(); });
    this.client.events.on('secret:deliver', (secret) => { this._secret = secret; if (this.phase === 'reading') this._renderPhase(); });
    this.client.events.on('clue:sync', (clues) => { this.revealedClues = clues; if (this.phase === 'investigate') this._renderPhase(); });
    this.client.events.on('clue:revealed', (entry) => { this.revealedClues.push(entry); Sound.play('clue'); if (this.phase === 'investigate') this._renderPhase(); });
    this.client.events.on('hidden:content', (content) => { this.hiddenClueContent = content; if (this.phase === 'investigate') this._renderPhase(); });
    this.client.events.on('reveal:results', (r) => { Sound.play('reveal'); this._renderReveal(r); this._showShareModal(r); });
    this.client.events.on('chat:public', (d) => this._addChat('公聊', d));
    this.client.events.on('chat:private', (d) => this._addChat('私聊', d));
    this.client.events.on('host:changed', (hostId) => { this.hostId = hostId; this.isHost = this.client.socket.id === hostId; if (this.phase !== 'lobby') this._renderPhase(); });
    this.client.events.on('vote:confirmed', (data) => { this.myVotes[data.round] = data.characterId; if (this.phase === 'vote') this._renderPhase(); });
    this.client.events.on('timer:updated', (deadline) => { this.phaseDeadline = deadline; this._updateTimer(); });
  }

  _tryReconnect() {
    if (this.token) {
      this.client.reconnect(this.token, (res) => {
        if (res.success) {
          Sound._ensure();
          this.characterId = res.characterId;
          this.myVotes = res.myVotes || { round1: null, round2: null };
          this.client.socket.emit('secret:request');
        } else {
          localStorage.removeItem('murder_token');
          this._renderLobby();
        }
      });
    } else {
      this._renderLobby();
    }
  }

  async _renderLobby() {
    let scripts = [];
    try {
      const res = await fetch('/api/scripts/list');
      const data = await res.json();
      if (data.success) scripts = data.scripts;
    } catch(e) {
      scripts = [{ id: 'default', title: '隔壁的陌生人：现代浮世绘', subtitle: '一墙隔生死，百态见人心' }];
    }

    this.container.innerHTML = `<div class="murder-container">
      <h1 class="title">🏘️ 剧本杀引擎</h1>
      <p class="subtitle">选择剧本，开启推理</p>
      <div id="script-list" class="script-list">
        ${scripts.map(s => `
          <div class="script-card" onclick="ui.selectScript('${s.id}')">
            <h3>${s.title}</h3>
            <p>${s.subtitle || ''}</p>
            <span class="script-meta">${s.minPlayers || 3}-${s.maxPlayers || 5}人</span>
          </div>
        `).join('')}
      </div>
      <div id="lobby-area" style="display:none;">
        <button onclick="ui._renderLobby()" style="background:none;border:none;color:var(--cyan);cursor:pointer;margin-bottom:10px;">← 返回剧本列表</button>
        <div class="lobby-actions">
          <button id="create-btn">创建房间</button>
          <input id="room-input" placeholder="房间号" maxlength="4">
          <button id="join-btn">加入房间</button>
        </div>
        <div id="ai-toggle" style="display:none;text-align:center;margin:10px 0;">
          <label style="color:#8a8070;font-size:14px;">
            <input type="checkbox" id="ai-check"> 🤖 开启AI补位
          </label>
        </div>
        <div id="player-list"></div>
        <div id="char-select" style="display:none;"></div>
        <button id="ready-btn" style="display:none;">准备</button>
      </div>
    </div>`;

    this._bindLobbyEvents();
  }

  _bindLobbyEvents() {
    const createBtn = document.getElementById('create-btn');
    const joinBtn = document.getElementById('join-btn');
    const aiCheck = document.getElementById('ai-check');

    if (createBtn) {
      createBtn.onclick = () => {
        Sound._ensure();
        // 确保默认剧本数据已加载
        if (!window.MurderConfig || Object.keys(window.MurderConfig.characters || {}).length === 0) {
          // 如果没加载过，先加载再创建
          this.loadScriptData(this.selectedScript, () => {
            this._createRoom();
          });
        } else {
          this._createRoom();
        }
      };
    }
    if (joinBtn) {
      joinBtn.onclick = () => {
        Sound._ensure();
        const rid = document.getElementById('room-input').value.toUpperCase();
        this.client.joinRoom(rid, (r) => {
          if (r.success) {
            this.roomId = rid; this.token = r.token; localStorage.setItem('murder_token', r.token);
            document.querySelector('.lobby-actions').innerHTML = '<p>已加入</p>';
          } else alert(r.error);
        });
      };
    }
    if (aiCheck) {
      aiCheck.onchange = () => this.client.enableAI(aiCheck.checked);
    }
  }

  _createRoom() {
    this.client.createRoom({ scriptId: this.selectedScript || 'default' }, (r) => {
      this.roomId = r.roomId; this.token = r.token; localStorage.setItem('murder_token', r.token);
      document.querySelector('.lobby-actions').innerHTML = `<p>房间号：<strong>${r.roomId}</strong></p>`;
    });
  }

  selectScript(scriptId) {
    this.selectedScript = scriptId;
    this.loadScriptData(scriptId, () => {
      document.getElementById('script-list').style.display = 'none';
      document.getElementById('lobby-area').style.display = 'block';
    });
  }

  loadScriptData(scriptId, callback) {
    fetch(`/api/scripts/${scriptId}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          window.MurderConfig = { ...window.MurderConfig, ...data.script };
        }
        if (callback) callback();
      })
      .catch(() => {
        if (callback) callback();
      });
  }

  _updateLobbyPlayers() {
    const list = document.getElementById('player-list');
    const select = document.getElementById('char-select');
    const aiToggle = document.getElementById('ai-toggle');
    if (!list) return;
    const entries = Object.values(this.currentPlayers);
    const chars = window.MurderConfig?.characters || {};
    list.innerHTML = entries.map(p => {
      const char = chars[p.characterId] || {};
      return `<div style="color:${char.color || '#8a8070'};${!p.isOnline ? 'opacity:0.4' : ''}">${p.isAI ? '🤖 ' : ''}${p.characterName || '待选择'} ${p.isReady ? '✅' : '⏳'} ${!p.isOnline ? '⚫' : ''}</div>`;
    }).join('');
    if (aiToggle && this.isHost) aiToggle.style.display = 'block';
    if (select) {
      const taken = entries.filter(p => p.isOnline && p.characterId).map(p => p.characterId);
      const available = Object.values(chars).filter(c => !taken.includes(c.id) || c.id === this.characterId);
      select.style.display = 'block';
      select.innerHTML = available.map(c => `<div class="char-card" style="border-color:${c.color}" onclick="ui.selectCharacter('${c.id}')"><div style="color:${c.color};font-size:18px;">${c.name}</div></div>`).join('');
    }
  }

  _updateChatTargets() {
    const select = document.getElementById('chat-target');
    if (!select) return;
    const currentVal = select.value;
    const players = Object.entries(this.currentPlayers).filter(([,p]) => p.isOnline && p.id !== this.client.socket.id);
    select.innerHTML = `<option value="">公聊</option>` + 
      players.map(([id, p]) => `<option value="${id}">${p.isAI ? '🤖' : ''}${p.characterName}</option>`).join('');
    if ([...select.options].some(o => o.value === currentVal)) select.value = currentVal;
  }

  selectCharacter(id) {
    this.characterId = id;
    this.client.selectCharacter(id);
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) { readyBtn.style.display = 'block'; readyBtn.onclick = () => this.playerReady(); }
  }

  playerReady() { this.client.playerReady(); this.client.socket.emit('secret:request'); }

  _renderPhase() {
    this.container.innerHTML = '';
    switch (this.phase) {
      case 'reading': this._renderReading(); break;
      case 'investigate': this._renderInvestigation(); break;
      case 'vote': this._renderVote(); break;
      case 'reveal': break;
    }
    this._renderChat();
    this._renderTimer();
  }

  _renderReading() {
    const chars = window.MurderConfig?.characters || {};
    const c = chars[this.characterId] || {};
    const s = this._secret || {};
    this.container.innerHTML = `<div class="murder-container" style="border-left:4px solid ${c.color || '#4a5568'};">
      <h2 style="color:${c.color || '#e0e6ed'};">${c.name || '未知角色'}｜${c.role || ''}｜${c.room || ''}室</h2>
      <div class="secret-box"><h3>🔒 你的秘密</h3><p>${s.secret || '加载中...'}</p></div>
      <div class="goal-box"><h3>🎯 你的目标</h3><p>${s.goal || ''}</p></div>
      <div class="forbidden-box"><h3>🚫 绝不能</h3><p>${s.forbidden || ''}</p></div>
      ${this.isHost ? '<button onclick="ui.client.startInvestigate()">开始搜证</button>' : '<p>等待主持人开始搜证...</p>'}
      ${this.isHost ? '<p style="font-size:12px;color:#8a8070;">超时后将自动进入搜证阶段</p>' : ''}
      ${this.isHost ? '<button onclick="ui.client.extendTimer(5)" style="margin-top:5px;">⏱ 延长5分钟</button>' : ''}
    </div>`;
  }

  _renderInvestigation() {
    const isLin = this.characterId === 'lin_qiang';
    const clues = window.MurderConfig?.clues || {};
    this.container.innerHTML = `<div class="murder-container">
      <h2>🔍 搜证阶段</h2>
      ${isLin ? '<button class="crack-btn" id="crack-btn" onclick="ui.linQiangCrack()">💻 破解监控系统</button>' : ''}
      <div class="clue-grid">${Object.values(clues).map(c => {
        const entry = this.revealedClues.find(r => r.id === c.id);
        const isHidden = c.lockedBy && c.lockedBy !== this.characterId && !entry;
        if (isHidden) return '<div class="clue-card hidden">🔒 ???</div>';
        const text = c.text || this.hiddenClueContent[c.id] || '（仅林强可查看）';
        const icon = c.icon || '📄';
        return `<div class="clue-card" style="border-color:${c.color}" onclick="${entry ? '' : `ui.client.revealClue('${c.id}')`}">
          <div class="clue-icon">${icon}</div>
          <h4 style="color:${c.color};">${c.title}</h4>
          ${entry ? `<p>${text}</p><p class="clue-meta">——由 ${entry.characterName} 发现</p>` : '<p style="color:#666;">点击查看</p>'}
        </div>`;
      }).join('')}</div>
      ${this.isHost ? '<button onclick="ui.client.startVote()">前往投票</button>' : '<p>等待主持人...</p>'}
      ${this.isHost ? '<button onclick="ui.client.extendTimer(5)" style="margin-top:5px;">⏱ 延长5分钟</button>' : ''}
    </div>`;
  }

  linQiangCrack() {
    const btn = document.getElementById('crack-btn');
    if (!btn || btn.classList.contains('hacking')) return;
    btn.classList.add('hacking');
    btn.textContent = '破解中...';
    Sound.play('hack');
    setTimeout(() => {
      this.client.linQiangCrack();
      btn.classList.remove('hacking');
      btn.textContent = '💻 已破解';
      btn.disabled = true;
    }, 3000);
  }

  _renderVote() {
    const v = window.MurderConfig?.voting || { round1: { title: '第一票', question: '?', options: [] }, round2: { title: '第二票', question: '?', options: [] } };
    this.container.innerHTML = `<div class="murder-container">
      <h2>🗳️ 双票制投票</h2>
      <p>已投票：${this.voteCounts.round1}/${this.voteCounts.total}（第一票） | ${this.voteCounts.round2}/${this.voteCounts.total}（第二票）</p>
      ${['round1','round2'].map(r => `<div class="vote-section" style="border-color:${r==='round1'?'#FF2A7A':'#00F0FF'}">
        <h3>${v[r]?.title || r}</h3><p>${v[r]?.question || ''}</p>
        <div>${(v[r]?.options || []).map(o => {
          const selected = this.myVotes[r] === o;
          return `<button class="vote-btn${selected ? ' selected' : ''}" onclick="ui.client.castVote('${r}','${o}')">${o}${selected ? ' ✅' : ''}</button>`;
        }).join('')}</div>
      </div>`).join('')}
      <p style="font-size:12px;color:#8a8070;">你已投第一票：${this.myVotes.round1 || '未投'} | 第二票：${this.myVotes.round2 || '未投'}</p>
      ${this.isHost ? '<button onclick="ui.client.reveal()">揭晓结果</button>' : ''}
      ${this.isHost ? '<button onclick="ui.client.extendTimer(5)" style="margin-top:5px;">⏱ 延长5分钟</button>' : ''}
    </div>`;
  }

  _renderReveal(r) {
    const timeline = r.timeline || [];
    const legal = window.MurderConfig?.legalConclusion || '';
    const truth = window.MurderConfig?.truth || { killer: '未知', accomplice: '未知', mastermind: '未知', bystander: '未知', conclusion: '' };
    
    this.container.innerHTML = `<div class="murder-container reveal">
      <h2>🎭 真相揭晓</h2>
      <div class="result-box"><h3>法理之票</h3><p>正确：${r.round1.correct}</p><p>${r.round1.topVoted.includes(r.round1.correct)?'✅ 多数正确':'❌ 判断错误'}</p></div>
      <div class="result-box"><h3>道德之票</h3><p>正确：${r.round2.correct}</p><p>${r.round2.topVoted.includes(r.round2.correct)?'✅ 多数正确':'❌ 判断错误'}</p></div>
      
      <div class="timeline-box">
        <h3>📜 事件时间线</h3>
        <div class="timeline">${timeline.map(t => `<div class="timeline-item"><span class="timeline-time">${t.time}</span><span class="timeline-icon">${t.icon}</span><span class="timeline-event">${t.event}</span></div>`).join('')}</div>
      </div>
      
      <div class="truth-box">
        <p><strong>物理真凶：${truth.killer}</strong></p>
        <p><strong>补刀者：${truth.accomplice}</strong></p>
        <p><strong>幕后教唆：${truth.mastermind}</strong></p>
        <p><strong>冷酷旁观：${truth.bystander}</strong></p>
        ${truth.conclusion ? `<p class="final-line">${truth.conclusion}</p>` : ''}
      </div>
      
      ${legal ? `<div class="legal-box" style="background:#1a1a1a;border-left:3px solid #FF2A7A;padding:15px;margin:20px 0;font-family:仿宋,FangSong,serif;"><h3 style="color:#FF2A7A;margin-bottom:8px;">📜 法治课堂</h3><p style="color:#ccc;line-height:1.6;">${legal}</p></div>` : ''}
    </div>`;
  }

  _showShareModal(results) {
    setTimeout(() => {
      const share = new ShareCanvas();
      const myPlayer = this.currentPlayers[this.client.socket.id];
      const otherPlayers = Object.values(this.currentPlayers).filter(p => p.id !== this.client.socket.id);
      const chars = window.MurderConfig?.characters || {};
      const myChar = chars[myPlayer?.characterId] || {};
      const data = {
        scriptTitle: '隔壁的陌生人',
        myCharacter: {
          name: myPlayer?.characterName,
          color: myChar.color || '#FF2A7A',
          room: myChar.room || '',
          role: myChar.role || ''
        },
        players: otherPlayers,
        votes: this.myVotes,
        results: results,
        duration: this.roomCreatedAt ? Date.now() - this.roomCreatedAt : 0,
        revealedClues: this.revealedClues || []
      };

      share.generate(data).then(imageDataUrl => {
        const modal = document.createElement('div');
        modal.className = 'share-modal';
        modal.innerHTML = `
          <div class="share-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center;">
            <h2 style="color:#FF2A7A;margin-bottom:15px;font-family:Songti SC,serif;">推理复盘</h2>
            <img src="${imageDataUrl}" style="max-width:90%;max-height:60vh;border:2px solid #4a5568;border-radius:10px;box-shadow:0 0 30px rgba(255,42,122,0.3);">
            <div style="margin-top:20px;display:flex;gap:15px;">
              <button id="btn-download" style="padding:12px 30px;background:#FF2A7A;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:16px;">保存图片</button>
              <button id="btn-copy" style="padding:12px 30px;background:#00F0FF;color:#0D0D0D;border:none;border-radius:6px;cursor:pointer;font-size:16px;">复制分享</button>
              <button id="btn-close" style="padding:12px 30px;background:transparent;color:#8a8070;border:1px solid #4a5568;border-radius:6px;cursor:pointer;font-size:16px;">关闭</button>
            </div>
            <p style="color:#666;margin-top:15px;font-size:12px;">截图发朋友圈，邀请好友下一局</p>
          </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#btn-download').onclick = () => share.download();
        modal.querySelector('#btn-copy').onclick = () => share.copyToClipboard();
        modal.querySelector('#btn-close').onclick = () => modal.remove();
        modal.querySelector('.share-overlay').onclick = (e) => {
          if (e.target === modal.querySelector('.share-overlay')) modal.remove();
        };
      });
    }, 800);
  }

  _renderTimer() {
    if (this.phase === 'reveal') return;
    let existing = document.getElementById('phase-timer');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'phase-timer';
      existing.style.cssText = 'position:fixed;top:10px;right:10px;background:#1a2c42;border:1px solid #4a5568;padding:8px 15px;border-radius:6px;font-size:14px;z-index:9999;';
      document.body.appendChild(existing);
    }
    this._updateTimerDisplay(existing);
  }

  _updateTimer() { const el = document.getElementById('phase-timer'); if (el) this._updateTimerDisplay(el); }

  _updateTimerDisplay(el) {
    if (!this.phaseDeadline) { el.textContent = ''; el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (this._timerHandle) clearTimeout(this._timerHandle);
    const remaining = Math.max(0, Math.ceil((this.phaseDeadline - Date.now()) / 1000));
    const min = Math.floor(remaining / 60), sec = remaining % 60;
    el.textContent = `⏱ ${min}:${sec.toString().padStart(2,'0')}`;
    el.style.color = remaining < 60 ? '#ff0000' : '#e0e6ed';
    if (remaining > 0) this._timerHandle = setTimeout(() => this._updateTimer(), 1000);
  }

  _renderChat() {
    if (document.getElementById('chat-panel')) return;
    const chat = document.createElement('div');
    chat.id = 'chat-panel';
    chat.style.cssText = 'position:fixed;bottom:0;right:0;width:300px;background:#0D0D0D;border:1px solid #4a5568;z-index:9999;';
    const players = Object.entries(this.currentPlayers).filter(([,p]) => p.isOnline && p.id !== this.client.socket.id);
    chat.innerHTML = `
      <div id="chat-header" style="cursor:pointer;font-size:12px;color:#8a8070;text-align:center;padding:6px;background:#1a1a1a;border-bottom:1px solid #4a5568;">💬 聊天 ▼</div>
      <div id="chat-body" style="padding:10px;">
        <div id="chat-messages" style="height:120px;overflow-y:auto;border:1px solid #333;padding:5px;margin-bottom:5px;"></div>
        <select id="chat-target"><option value="">公聊</option>${players.map(([id, p]) => `<option value="${id}">${p.isAI ? '🤖' : ''}${p.characterName}</option>`).join('')}</select>
        <input id="chat-input" placeholder="消息" style="width:120px;"><button onclick="ui._sendChat()">发送</button>
      </div>`;
    document.body.appendChild(chat);
    document.getElementById('chat-header').onclick = () => {
      const body = document.getElementById('chat-body');
      const header = document.getElementById('chat-header');
      if (body.style.display === 'none') { body.style.display = 'block'; header.textContent = '💬 聊天 ▼'; }
      else { body.style.display = 'none'; header.textContent = '💬 聊天 ▶'; }
    };
  }

  _sendChat() {
    const input = document.getElementById('chat-input');
    const target = document.getElementById('chat-target').value;
    if (!input.value) return;
    if (target) this.client.socket.emit('chat:private', target, input.value);
    else this.client.socket.emit('chat:public', input.value);
    input.value = '';
  }

  _addChat(type, data) {
    const msgs = document.getElementById('chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.style.color = type === '私聊' ? '#FF2A7A' : '#e0e6ed';
    div.textContent = `[${type}] ${data.characterName}: ${data.message}`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }
}

// ========== 音效系统 ==========
class Sound {
  static ctx = null;
  static _ensure() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); }
  static play(type) {
    try {
      this._ensure(); const ctx = this.ctx;
      if (type === 'clue') { const o=ctx.createOscillator(),g=ctx.createGain(); o.connect(g);g.connect(ctx.destination); o.type='sine'; o.frequency.setValueAtTime(600,ctx.currentTime); o.frequency.exponentialRampToValueAtTime(1000,ctx.currentTime+0.15); g.gain.setValueAtTime(0.08,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.4); o.start(); o.stop(ctx.currentTime+0.4); }
      else if (type === 'hack') { for(let i=0;i<8;i++){ const o=ctx.createOscillator(),g=ctx.createGain(); o.connect(g);g.connect(ctx.destination); o.type='square'; o.frequency.setValueAtTime(150+Math.random()*400,ctx.currentTime+i*0.06); g.gain.setValueAtTime(0.04,ctx.currentTime+i*0.06); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+i*0.06+0.08); o.start(ctx.currentTime+i*0.06); o.stop(ctx.currentTime+i*0.06+0.08); } }
      else if (type === 'reveal') { const o=ctx.createOscillator(),g=ctx.createGain(); o.connect(g);g.connect(ctx.destination); o.type='sawtooth'; o.frequency.setValueAtTime(80,ctx.currentTime); o.frequency.linearRampToValueAtTime(40,ctx.currentTime+1.5); g.gain.setValueAtTime(0.1,ctx.currentTime); g.gain.linearRampToValueAtTime(0,ctx.currentTime+1.5); o.start(); o.stop(ctx.currentTime+1.5); }
    } catch(e) {}
  }
}
