class ShareCanvas {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 900;
    this.canvas.height = 500;
    this.ctx = this.canvas.getContext('2d');
  }

  async generate(data) {
    const { scriptTitle, myCharacter, players, votes, results, duration, timeline } = data;
    this._drawBackground();
    this._drawHeader(scriptTitle);
    this._drawCharacterCard(myCharacter, players);
    this._drawVoteSection(votes, results);
    this._drawStats(duration, data.revealedClues?.length || 0);
    this._drawFooter();
    return this.canvas.toDataURL('image/png');
  }

  download(filename = 'murder-replay.png') {
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  async copyToClipboard() {
    this.canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        alert('复盘图已复制到剪贴板');
      } catch {
        this.download();
      }
    });
  }

  _drawBackground() {
    const ctx = this.ctx;
    ctx.fillStyle = '#0D0D0D';
    ctx.fillRect(0, 0, 900, 500);
    const gradient = ctx.createLinearGradient(0, 0, 900, 0);
    gradient.addColorStop(0, 'rgba(255,42,122,0.15)');
    gradient.addColorStop(0.5, 'rgba(0,240,255,0.1)');
    gradient.addColorStop(1, 'rgba(255,42,122,0.15)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 900, 120);
    ctx.strokeStyle = 'rgba(74,85,104,0.15)';
    ctx.lineWidth = 1;
    for (let x = 0; x < 900; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 500); ctx.stroke(); }
    for (let y = 0; y < 500; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(900, y); ctx.stroke(); }
  }

  _drawHeader(scriptTitle) {
    const ctx = this.ctx;
    ctx.font = 'bold 32px "Songti SC", serif';
    ctx.fillStyle = '#FF2A7A';
    ctx.textAlign = 'center';
    ctx.fillText('「' + (scriptTitle || '隔壁的陌生人') + '」', 450, 55);
    ctx.font = '16px "Songti SC", sans-serif';
    ctx.fillStyle = '#8a8070';
    ctx.fillText('现代浮世绘 · 沉浸式推理复盘', 450, 85);
    ctx.strokeStyle = '#4a5568';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(80, 100); ctx.lineTo(820, 100); ctx.stroke();
  }

  _drawCharacterCard(myCharacter, players) {
    const ctx = this.ctx;
    const x = 60, y = 130, w = 280, h = 160;
    ctx.fillStyle = 'rgba(26,26,26,0.9)';
    ctx.strokeStyle = myCharacter?.color || '#FF2A7A';
    ctx.lineWidth = 2;
    this._roundRect(x, y, w, h, 10);
    ctx.fill(); ctx.stroke();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#8a8070';
    ctx.textAlign = 'left';
    ctx.fillText('我的角色', x + 20, y + 30);
    ctx.font = 'bold 24px "Songti SC", serif';
    ctx.fillStyle = myCharacter?.color || '#FF2A7A';
    ctx.fillText(myCharacter?.name || '未知', x + 20, y + 65);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#e0e6ed';
    ctx.fillText((myCharacter?.room || '') + ' · ' + (myCharacter?.role || ''), x + 20, y + 95);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#8a8070';
    let playerText = '同局玩家: ';
    if (players && players.length > 0) {
      playerText += players.slice(0, 4).map(p => p.characterName).join(' ');
      if (players.length > 4) playerText += '...';
    }
    ctx.fillText(playerText, x + 20, y + 135);
  }

  _drawVoteSection(votes, results) {
    const ctx = this.ctx;
    const startX = 380, startY = 130;
    ctx.font = 'bold 18px "Songti SC", serif';
    ctx.fillStyle = '#00F0FF';
    ctx.textAlign = 'left';
    ctx.fillText('投票结果', startX, startY);
    const rounds = [
      { key: 'round1', label: '法理之票', correct: results?.round1?.correct },
      { key: 'round2', label: '道德之票', correct: results?.round2?.correct }
    ];
    rounds.forEach((round, idx) => {
      const y = startY + 40 + idx * 65;
      const myVote = votes?.[round.key];
      const isCorrect = myVote === round.correct;
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#8a8070';
      ctx.fillText(round.label, startX, y);
      ctx.font = 'bold 16px "Songti SC", serif';
      ctx.fillStyle = isCorrect ? '#00cc66' : '#8C0000';
      ctx.fillText('我投: ' + (myVote || '未投票'), startX + 100, y);
      ctx.font = '14px sans-serif';
      ctx.fillStyle = isCorrect ? '#00cc66' : '#8C0000';
      ctx.fillText(isCorrect ? '✓ 正确' : '✗ 真相: ' + round.correct, startX + 220, y);
    });
    ctx.strokeStyle = '#333';
    ctx.beginPath(); ctx.moveTo(startX, startY + 155); ctx.lineTo(840, startY + 155); ctx.stroke();
  }

  _drawStats(duration, clueCount) {
    const ctx = this.ctx;
    const y = 340;
    const stats = [
      { label: '游戏时长', value: this._formatDuration(duration), color: '#FF2A7A' },
      { label: '搜证线索', value: clueCount + ' 条', color: '#00F0FF' },
      { label: '推理评级', value: this._getRating(duration), color: '#e0e6ed' }
    ];
    stats.forEach((stat, idx) => {
      const x = 120 + idx * 280;
      ctx.font = 'bold 28px "Songti SC", serif';
      ctx.fillStyle = stat.color;
      ctx.textAlign = 'center';
      ctx.fillText(stat.value, x, y);
      ctx.font = '12px sans-serif';
      ctx.fillStyle = '#8a8070';
      ctx.fillText(stat.label, x, y + 25);
    });
    ctx.font = 'italic 16px "Songti SC", serif';
    ctx.fillStyle = '#8a8070';
    ctx.fillText('"真相只有一个，但人心不止一面"', 450, 400);
  }

  _drawFooter() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255,42,122,0.1)';
    ctx.fillRect(0, 460, 900, 40);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.fillText('隔壁的陌生人 · 现代浮世绘推理平台', 450, 485);
    ctx.strokeStyle = '#4a5568';
    ctx.lineWidth = 1;
    ctx.strokeRect(820, 460, 60, 40);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#4a5568';
    ctx.fillText('扫码', 850, 485);
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _formatDuration(ms) {
    if (!ms || ms < 0) return '00:00';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  _getRating(duration) {
    if (!duration) return '???';
    const mins = duration / 60000;
    if (mins < 15) return '闪电猎手';
    if (mins < 30) return '逻辑大师';
    if (mins < 45) return '沉稳侦探';
    return '浮世观察者';
  }
}
window.ShareCanvas = ShareCanvas;