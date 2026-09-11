
// --- 純靜態模式抽題與評分引擎 (用於 GitHub Pages 免伺服器模式) ---
const StaticEngine = {
  sample80Questions(bank) {
    const diffNeeded = { '難': 20, '中': 40, '易': 20 };
    const subjMap = {};
    bank.forEach(q => {
      const s = q.subject || '其他';
      if (!subjMap[s]) subjMap[s] = [];
      subjMap[s].push(q);
    });

    const allSubjs = Object.keys(subjMap).sort(() => Math.random() - 0.5);
    // 依科目可選難易度種類排序
    allSubjs.sort((a, b) => {
      const setA = new Set(subjMap[a].map(x => x.difficulty)).size;
      const setB = new Set(subjMap[b].map(x => x.difficulty)).size;
      return setA - setB;
    });

    let chosen = [];
    const chosenIds = new Set();
    const curDiff = { ...diffNeeded };

    // 優先讓每個科目至少 1 題
    allSubjs.forEach(s => {
      const avail = subjMap[s].filter(q => curDiff[q.difficulty] > 0 && !chosenIds.has(q.id));
      if (avail.length > 0) {
        const picked = avail[Math.floor(Math.random() * avail.length)];
        chosen.push(picked);
        chosenIds.add(picked.id);
        curDiff[picked.difficulty]--;
      }
    });

    // 補足剩餘題目
    const remPool = bank.filter(q => !chosenIds.has(q.id)).sort(() => Math.random() - 0.5);
    ['難', '中', '易'].forEach(d => {
      const needed = curDiff[d];
      const match = remPool.filter(q => q.difficulty === d && !chosenIds.has(q.id));
      const picked = match.slice(0, needed);
      picked.forEach(q => {
        chosen.push(q);
        chosenIds.add(q.id);
      });
    });

    // 打亂題目順序
    chosen.sort(() => Math.random() - 0.5);

    // 封裝安全題目清單與標準答案清單
    const questions = [];
    const answersKey = {};
    chosen.forEach((q, idx) => {
      questions.push({
        index: idx + 1,
        id: q.id,
        subject: q.subject,
        scope: q.scope,
        question: q.question,
        options: { ...q.options },
        image: q.image || ""
      });
      answersKey[String(idx + 1)] = q.answer;
    });

    return { questions, answersKey };
  }
};

/* ==========================================================================
   臨床實習病毒學考試系統 (Clinical Virology Examination System) - app.js
   ========================================================================== */

const STORAGE_KEY = 'virology_exam_backup_v1';
const GAS_URL_KEY = 'virology_gas_url';

const App = {
  state: {
    examId: null,
    studentName: '',
    studentId: '',
    questions: [],
    userAnswers: {},
    bookmarks: new Set(),
    currentIndex: 1,
    deadline: 0,
    isCompleted: false,
    timerId: null,
    isOffline: !navigator.onLine,
    scoreResult: null,
    screenshotViolations: 0,
    penaltyPoints: 0,
    lastViolationTime: 0
  },

  // --- 初始化 ---
  init() {
    this.bindNetworkEvents();
    this.bindKeyboardEvents();
    this.bindAntiCheating();
    this.checkExistingExam();
    
    // 預載先前儲存的 GAS URL
    const savedGasUrl = localStorage.getItem(GAS_URL_KEY) || '';
    const gasInput = document.getElementById('gas-url-input');
    if (gasInput && savedGasUrl) {
      gasInput.value = savedGasUrl;
    }
  },

  // --- 監聽網路連線狀態 (斷網救援) ---
  bindNetworkEvents() {
    window.addEventListener('online', () => {
      this.state.isOffline = false;
      this.updateNetworkBadge();
      this.showToast('網路連線已恢復，作答資料已自動同步！', 'success');
      this.syncPendingAnswers();
    });

    window.addEventListener('offline', () => {
      this.state.isOffline = true;
      this.updateNetworkBadge();
      this.showToast('偵測到離線狀態！作答持續妥善保存在本機，請放心繼續作答。', 'warning');
    });

    window.addEventListener('beforeunload', (e) => {
      if (this.state.examId && !this.state.isCompleted) {
        e.preventDefault();
        e.returnValue = '考試正在進行中，離開將不會暫停計時！確定要離開嗎？';
      }
    });

    this.updateNetworkBadge();
  },

  updateNetworkBadge() {
    const badge = document.getElementById('network-badge');
    const text = document.getElementById('network-text');
    if (!badge || !text) return;

    if (this.state.isOffline) {
      badge.className = 'network-status offline';
      text.innerText = '離線保存中';
    } else {
      badge.className = 'network-status';
      text.innerText = '連線正常';
    }
  },

  showToast(msg, type = 'info') {
    const banner = document.getElementById('global-banner');
    const text = document.getElementById('banner-text');
    if (!banner || !text) return;
    
    text.innerText = msg;
    banner.className = `notification-banner ${type === 'warning' ? 'warning' : ''}`;
    banner.style.display = 'flex';
    
    setTimeout(() => {
      banner.style.display = 'none';
    }, 6000);
  },

  // --- 防作弊：防文字選取複製與防螢幕截圖扣分 ---
  bindAntiCheating() {
    // 1. 禁用右鍵選單
    document.addEventListener('contextmenu', (e) => {
      if (this.state.examId && !this.state.isCompleted) {
        e.preventDefault();
        this.showToast('⚠️ 考試進行中嚴禁使用右鍵選單！', 'warning');
        return false;
      }
    });

    // 2. 禁用剪貼簿複製、剪下、貼上
    document.addEventListener('copy', (e) => {
      if (this.state.examId && !this.state.isCompleted) {
        e.preventDefault();
        this.showToast('⚠️ 考試進行中嚴禁複製試題文字！', 'warning');
        return false;
      }
    });
    document.addEventListener('cut', (e) => {
      if (this.state.examId && !this.state.isCompleted) {
        e.preventDefault();
        return false;
      }
    });

    // 3. 監聽 keydown 與 keyup 偵測截圖與違規熱鍵
    window.addEventListener('keydown', (e) => {
      if (!this.state.examId || this.state.isCompleted) return;

      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      // 禁用開發者工具、原始碼、列印、全選、存檔
      if (
        (isCtrlOrCmd && ['c', 'C', 'u', 'U', 'p', 'P', 's', 'S', 'a', 'A'].includes(e.key)) ||
        e.key === 'F12' ||
        (isCtrlOrCmd && e.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key))
      ) {
        e.preventDefault();
        this.showToast('⚠️ 考試進行中此功能/快速鍵已被系統鎖定！', 'warning');
      }

      // 偵測截圖組合鍵：
      // - Windows 剪取工具: Win + Shift + S 或 Ctrl + Shift + S
      // - Mac 截圖: Cmd + Shift + 3 / 4 / 5
      // - PrintScreen
      const isSnippingTool = (e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S'));
      const isMacScreenshot = (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key));
      const isPrintScreen = (e.key === 'PrintScreen' || e.keyCode === 44);

      if (isSnippingTool || isMacScreenshot || isPrintScreen) {
        e.preventDefault();
        this.triggerScreenshotViolation();
      }
    });

    // Windows 的 PrintScreen 通常在 keyup 觸發
    window.addEventListener('keyup', (e) => {
      if (!this.state.examId || this.state.isCompleted) return;
      if (e.key === 'PrintScreen' || e.keyCode === 44) {
        this.triggerScreenshotViolation();
      }
    });
  },

  // --- 觸發截圖違規扣分處置 (每次扣 5 分) ---
  triggerScreenshotViolation() {
    const now = Date.now();
    // 1.5 秒冷卻時間，防止連擊瞬間重複扣分
    if (now - this.state.lastViolationTime < 1500) return;
    this.state.lastViolationTime = now;

    this.state.screenshotViolations += 1;
    this.state.penaltyPoints += 5;

    // 清空並覆寫剪貼簿
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText('【嚴正警告】考試進行中嚴禁螢幕截圖！本次已被系統記錄違規並自總成績扣除 5 分！').catch(() => {});
    }

    // 彈出違規警告視窗
    const statElem = document.getElementById('violation-stat');
    if (statElem) {
      statElem.innerText = `目前累積截圖違規：${this.state.screenshotViolations} 次，累計已扣除總分：${this.state.penaltyPoints} 分！`;
    }
    const modal = document.getElementById('violation-modal');
    if (modal) modal.style.display = 'flex';

    // 即時通報後端記錄處分
    if (!this.state.isOffline) {
      fetch('/api/violation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exam_id: this.state.examId,
          type: 'screenshot',
          penalty_points: 5
        })
      }).catch(() => {});
    }

    this.saveToLocal();
  },

  closeViolationModal() {
    const modal = document.getElementById('violation-modal');
    if (modal) modal.style.display = 'none';
  },

  // --- 鍵盤快捷鍵 ---
  bindKeyboardEvents() {
    window.addEventListener('keydown', (e) => {
      if (!this.state.examId || this.state.isCompleted) return;
      if (['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase())) return;

      if (e.key === 'ArrowLeft') {
        this.navigateQuestion(-1);
      } else if (e.key === 'ArrowRight') {
        this.navigateQuestion(1);
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        const map = {'1': 'A', '2': 'B', '3': 'C', '4': 'D'};
        this.selectOption(map[e.key]);
      } else if (['a', 'b', 'c', 'd', 'A', 'B', 'C', 'D'].includes(e.key)) {
        this.selectOption(e.key.toUpperCase());
      } else if (e.key.toLowerCase() === 'm') {
        this.toggleBookmark();
      }
    });
  },

  // --- 檢查是否有進行中考試 (防跳出/恢復) ---
  async checkExistingExam() {
    // 優先向後端確認狀態
    try {
      const resp = await fetch('/api/status');
      if (resp.ok) {
        const data = await resp.json();
        if (data.has_active && !data.is_completed) {
          const now = Date.now() / 1000;
          if (data.deadline > now) {
            this.resumeExam(data);
            return;
          }
        }
      }
    } catch (e) {
      console.log('後端暫時無法連線，改由 LocalStorage 檢查復原...');
    }

    // 後端若連不上，檢查本地 localStorage
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const localData = JSON.parse(saved);
        const now = Date.now() / 1000;
        if (localData.examId && !localData.isCompleted && localData.deadline > now) {
          this.resumeExam(localData);
          return;
        }
      } catch (err) {
        console.error('解析本地備份失敗', err);
      }
    }
  },

  // --- 開始新考試 ---
  async startExam() {
    const nameInput = document.getElementById('student-name');
    const idInput = document.getElementById('student-id');
    const name = nameInput.value.trim();
    const id = idInput.value.trim();

    if (!name || !id) {
      alert('請務必填寫「考生姓名」與「學號/座號」始可開始考試！');
      return;
    }

    const startBtn = document.getElementById('start-exam-btn');
    startBtn.disabled = true;
    startBtn.innerText = '正在抽題並建置考卷...';

    try {
      let resp; try { resp = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: name, student_id: id })
      });

      if (!resp.ok) throw new Error('伺服器抽題失敗');
      const data = await resp.json();
      this.loadExamSession(data);
    } catch (fetchErr) {
      console.log('運行於純靜態 GitHub Pages 模式，由瀏覽器端直接抽題！');
      if (!window.QUESTIONS_BANK) throw new Error('題庫未載入');
      const sampled = StaticEngine.sample80Questions(window.QUESTIONS_BANK);
      window.__STATIC_ANSWERS_KEY = sampled.answersKey;
      const staticData = {
        exam_id: 'GH-' + Math.random().toString(36).substr(2, 9),
        student_name: name,
        student_id: id,
        deadline: (Date.now() / 1000) + 3600,
        questions: sampled.questions,
        user_answers: {},
        is_completed: false,
        screenshot_violations: 0,
        penalty_points: 0
      };
      this.loadExamSession(staticData);
    }
    } catch (err) {
      console.error(err);
      alert('啟動考試失敗，請確認伺服器運作正常。');
      startBtn.disabled = false;
      startBtn.innerText = '開始正式考試';
    }
  },

  // --- 載入考試 Session ---
  loadExamSession(data) {
    this.state.examId = data.exam_id;
    this.state.studentName = data.student_name;
    this.state.studentId = data.student_id;
    this.state.questions = data.questions;
    this.state.userAnswers = data.user_answers || {};
    this.state.deadline = data.deadline;
    this.state.isCompleted = data.is_completed || false;
    this.state.currentIndex = 1;
    this.state.bookmarks = new Set(data.bookmarks || []);
    this.state.screenshotViolations = data.screenshot_violations || data.screenshotViolations || 0;
    this.state.penaltyPoints = data.penalty_points || data.penaltyPoints || 0;

    this.saveToLocal();

    // 更新介面與啟用防文字複製
    document.body.classList.add('exam-active');
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('exam-view').style.display = 'grid';
    document.getElementById('header-user-info').innerText = `${this.state.studentName} (${this.state.studentId})`;
    document.getElementById('submit-btn-top').style.display = 'inline-flex';

    this.startTimer();
    this.renderQuestionGrid();
    this.renderQuestion(this.state.currentIndex);
  },

  // --- 復原考試 (Disaster Recovery) ---
  resumeExam(data) {
    this.showToast('偵測到未完成之考試，已自動為您恢復考卷與作答進度！', 'info');
    this.loadExamSession(data);
  },

  // --- 計時器邏輯 (不可中途暫停) ---
  startTimer() {
    if (this.state.timerId) clearInterval(this.state.timerId);

    const updateTimerDisplay = () => {
      const now = Date.now() / 1000;
      const remaining = Math.max(0, Math.floor(this.state.deadline - now));

      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      const displayStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      
      const timerElem = document.getElementById('timer-text');
      const timerContainer = document.getElementById('timer-container');
      if (timerElem) timerElem.innerText = displayStr;

      // 顏色預警
      if (timerContainer) {
        if (remaining <= 300) { // < 5 分鐘
          timerContainer.className = 'timer-container timer-danger';
        } else if (remaining <= 900) { // < 15 分鐘
          timerContainer.className = 'timer-container timer-warning';
        } else {
          timerContainer.className = 'timer-container';
        }
      }

      // 時間到自動交卷
      if (remaining <= 0) {
        clearInterval(this.state.timerId);
        this.showToast('考試時間已到！系統正在自動交卷...', 'warning');
        this.submitExam(true);
      }
    };

    updateTimerDisplay();
    this.state.timerId = setInterval(updateTimerDisplay, 1000);
  },

  // --- 渲染題目 ---
  renderQuestion(index) {
    this.state.currentIndex = index;
    const q = this.state.questions[index - 1];
    if (!q) return;

    // 題目編號與中繼資料 (不顯示難易度)
    document.getElementById('q-num-display').innerText = `第 ${index} 題 / 共 ${this.state.questions.length} 題`;
    document.getElementById('q-subject-badge').innerText = `科目: ${q.subject}`;
    document.getElementById('q-scope-badge').innerText = q.scope || '一般';

    // 標記按鈕狀態
    const bookmarkBtn = document.getElementById('bookmark-btn');
    if (this.state.bookmarks.has(index)) {
      bookmarkBtn.className = 'bookmark-btn active';
      bookmarkBtn.innerText = '★ 已標記覆查';
    } else {
      bookmarkBtn.className = 'bookmark-btn';
      bookmarkBtn.innerText = '☆ 標記此題';
    }

    // 題目文字
    document.getElementById('q-text').innerText = q.question;

    // 考題附圖處理 (若有附圖則呈現，無則隱藏)
    const imgContainer = document.getElementById('q-image-container');
    const imgElem = document.getElementById('q-image');
    if (imgContainer && imgElem) {
      if (q.image && q.image.trim()) {
        imgElem.src = q.image.trim();
        imgContainer.style.display = 'block';
      } else {
        imgContainer.style.display = 'none';
        imgElem.src = '';
      }
    }

    // 選項列表
    const optsContainer = document.getElementById('options-container');
    optsContainer.innerHTML = '';

    const selectedOption = this.state.userAnswers[String(index)];

    ['A', 'B', 'C', 'D'].forEach(optKey => {
      const optText = q.options[optKey] || '';
      const isSelected = selectedOption === optKey;

      const item = document.createElement('div');
      item.className = `option-item ${isSelected ? 'selected' : ''}`;
      item.onclick = () => this.selectOption(optKey);

      item.innerHTML = `
        <div class="option-radio">${optKey}</div>
        <div class="option-content">${this.escapeHtml(optText)}</div>
      `;
      optsContainer.appendChild(item);
    });

    // 更新上一題/下一題按鈕
    document.getElementById('prev-q-btn').disabled = index === 1;
    document.getElementById('next-q-btn').innerText = index === this.state.questions.length ? '檢查完畢' : '下一題 →';

    this.updateGridActive();
  },

  // --- 選取選項 (即時雙重存檔) ---
  selectOption(optKey) {
    if (this.state.isCompleted) return;

    const idxStr = String(this.state.currentIndex);
    this.state.userAnswers[idxStr] = optKey;

    // 即時寫入 LocalStorage (防跳出/斷網關鍵)
    this.saveToLocal();

    // 更新當前選項視圖
    const items = document.querySelectorAll('.option-item');
    ['A', 'B', 'C', 'D'].forEach((key, i) => {
      if (items[i]) {
        items[i].className = `option-item ${key === optKey ? 'selected' : ''}`;
      }
    });

    // 更新題號導航盤與進度條
    this.updateGridBtn(this.state.currentIndex);
    this.updateProgressSummary();

    // 背景同步至後端 (若離線將暫存於本地)
    this.syncAnswerToBackend(this.state.currentIndex, optKey);
  },

  async syncAnswerToBackend(index, optKey) {
    if (this.state.isOffline) return;
    try {
      await fetch('/api/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exam_id: this.state.examId,
          index: index,
          answer: optKey
        })
      });
    } catch (e) {
      console.warn('後端同步暫時受阻，本地已安全暫存。');
    }
  },

  // --- 題號導航盤 ---
  renderQuestionGrid() {
    const grid = document.getElementById('question-grid');
    grid.innerHTML = '';

    for (let i = 1; i <= this.state.questions.length; i++) {
      const btn = document.createElement('button');
      btn.className = 'grid-btn';
      btn.id = `grid-btn-${i}`;
      btn.innerText = i;
      btn.onclick = () => this.renderQuestion(i);
      grid.appendChild(btn);
      this.updateGridBtn(i);
    }
    this.updateProgressSummary();
  },

  updateGridBtn(index) {
    const btn = document.getElementById(`grid-btn-${index}`);
    if (!btn) return;

    const isAnswered = !!this.state.userAnswers[String(index)];
    const isBookmarked = this.state.bookmarks.has(index);
    const isCurrent = index === this.state.currentIndex;

    let cls = 'grid-btn';
    if (isAnswered) cls += ' answered';
    if (isBookmarked) cls += ' bookmarked';
    if (isCurrent) cls += ' current';
    btn.className = cls;
  },

  updateGridActive() {
    for (let i = 1; i <= this.state.questions.length; i++) {
      this.updateGridBtn(i);
    }
  },

  updateProgressSummary() {
    const answeredCount = Object.keys(this.state.userAnswers).length;
    const total = this.state.questions.length;
    const pct = Math.round((answeredCount / total) * 100);

    const summaryText = document.getElementById('progress-text');
    if (summaryText) summaryText.innerText = `${answeredCount} / ${total} 題已完成 (${pct}%)`;

    const fillBar = document.getElementById('progress-fill');
    if (fillBar) fillBar.style.width = `${pct}%`;
  },

  navigateQuestion(delta) {
    const nextIdx = this.state.currentIndex + delta;
    if (nextIdx >= 1 && nextIdx <= this.state.questions.length) {
      this.renderQuestion(nextIdx);
    }
  },

  toggleBookmark() {
    const idx = this.state.currentIndex;
    if (this.state.bookmarks.has(idx)) {
      this.state.bookmarks.delete(idx);
    } else {
      this.state.bookmarks.add(idx);
    }
    this.saveToLocal();
    this.renderQuestion(idx);
  },

  saveToLocal() {
    const payload = {
      examId: this.state.examId,
      studentName: this.state.studentName,
      studentId: this.state.studentId,
      questions: this.state.questions,
      userAnswers: this.state.userAnswers,
      bookmarks: Array.from(this.state.bookmarks),
      deadline: this.state.deadline,
      isCompleted: this.state.isCompleted,
      screenshotViolations: this.state.screenshotViolations,
      penaltyPoints: this.state.penaltyPoints
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('LocalStorage 存取失敗', e);
    }
  },

  // --- 嘗試同步未送出之答案 ---
  async syncPendingAnswers() {
    if (!this.state.examId || this.state.isCompleted) return;
    for (const [idx, ans] of Object.entries(this.state.userAnswers)) {
      this.syncAnswerToBackend(idx, ans);
    }
  },

  // --- 交卷確認彈窗 ---
  openSubmitModal() {
    const answeredCount = Object.keys(this.state.userAnswers).length;
    const total = this.state.questions.length;
    const unans = total - answeredCount;

    const title = document.getElementById('modal-title');
    const desc = document.getElementById('modal-desc');

    if (unans > 0) {
      title.innerText = '⚠️ 尚有題目未作答！';
      desc.innerHTML = `您還有 <strong style="color:#b91c1c; font-size:1.2rem;">${unans}</strong> 題尚未作答。<br>交卷後將無法再次修改，確定要現在交卷嗎？`;
    } else {
      title.innerText = '確認送出考卷？';
      desc.innerHTML = `您已作答全部 ${total} 題！<br>送出後系統將立即結算總分，確定送出嗎？`;
    }

    document.getElementById('submit-modal').style.display = 'flex';
  },

  closeSubmitModal() {
    document.getElementById('submit-modal').style.display = 'none';
  },

  // --- 正式交卷 (結束後只顯示成績) ---
  async submitExam(isAuto = false) {
    this.closeSubmitModal();
    if (this.state.timerId) clearInterval(this.state.timerId);
    this.state.isCompleted = true;
    this.saveToLocal();

    let result = null;

    try {
      const resp = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exam_id: this.state.examId,
          answers: this.state.userAnswers,
          screenshot_violations: this.state.screenshotViolations,
          penalty_points: this.state.penaltyPoints
        })
      });
      if (resp.ok) {
        result = await resp.json();
      }
    } catch (e) {
      console.warn('後端連線異常，將由本地快取結算成績');
    }

    // 若後端離線或無回應，以備用模式計算（若有答案金鑰）或顯示完成提示
    if (!result) {
      alert('已於離線狀態完成交卷！請將成績憑證或 CSV 存檔並上傳。');
      const rawScore = Object.keys(this.state.userAnswers).length * 1.25;
      result = {
        student_name: this.state.studentName,
        student_id: this.state.studentId,
        raw_score: rawScore,
        penalty_points: this.state.penaltyPoints,
        screenshot_violations: this.state.screenshotViolations,
        score: (() => {
          let correct = 0;
          const keys = window.__STATIC_ANSWERS_KEY || {};
          for (const [idx, ans] of Object.entries(this.state.userAnswers)) {
            if (keys[idx] && keys[idx].toUpperCase() === ans.toUpperCase()) correct++;
          }
          const raw = Math.round(correct * 1.25 * 100) / 100;
          const penalty = this.state.penaltyPoints || 0;
          return Math.max(0, Math.round((raw - penalty) * 100) / 100);
        })(),
        correct_count: (() => {
          let correct = 0;
          const keys = window.__STATIC_ANSWERS_KEY || {};
          for (const [idx, ans] of Object.entries(this.state.userAnswers)) {
            if (keys[idx] && keys[idx].toUpperCase() === ans.toUpperCase()) correct++;
          }
          return correct;
        })(),
        total_questions: this.state.questions.length,
        submitted_at: Date.now() / 1000
      };
    }

    this.state.scoreResult = result;
    this.showScoreView(result);
  },

  // --- 成績結算頁面 (Requirement 4: 結束後只顯示成績) ---
  showScoreView(result) {
    document.body.classList.remove('exam-active');
    document.getElementById('exam-view').style.display = 'none';
    document.getElementById('submit-btn-top').style.display = 'none';
    document.getElementById('timer-container').style.display = 'none';
    
    const view = document.getElementById('result-view');
    view.style.display = 'block';

    document.getElementById('res-name').innerText = result.student_name || this.state.studentName;
    document.getElementById('res-id').innerText = result.student_id || this.state.studentId;
    
    const scoreVal = result.score !== undefined ? result.score : '--';
    document.getElementById('res-score-num').innerText = scoreVal;

    document.getElementById('res-correct').innerText = `${result.correct_count ?? '--'} / ${result.total_questions || 80} 題`;
    
    const durMins = result.duration_used_seconds ? Math.floor(result.duration_used_seconds / 60) : '--';
    const durSecs = result.duration_used_seconds ? Math.round(result.duration_used_seconds % 60) : '--';
    document.getElementById('res-time-spent').innerText = `${durMins} 分 ${durSecs} 秒`;

    // 違規扣分提示
    const penalty = result.penalty_points !== undefined ? result.penalty_points : (this.state.penaltyPoints || 0);
    const violations = result.screenshot_violations !== undefined ? result.screenshot_violations : (this.state.screenshotViolations || 0);
    const penaltyBox = document.getElementById('res-penalty-box');
    const penaltyVal = document.getElementById('res-penalty-val');
    if (penaltyBox && penaltyVal) {
      if (penalty > 0) {
        penaltyBox.style.display = 'block';
        penaltyVal.innerText = `-${penalty} 分 (共 ${violations} 次截圖)`;
      } else {
        penaltyBox.style.display = 'none';
      }
    }

    const subTime = result.submitted_at ? new Date(result.submitted_at * 1000).toLocaleString('zh-TW') : new Date().toLocaleString('zh-TW');
    document.getElementById('res-submit-time').innerText = subTime;

    // 清理考題備份，標記為已完成
    localStorage.removeItem(STORAGE_KEY);

    // 嘗試自動上傳至 Google Sheet (若已設定 URL)
    const gasInput = document.getElementById('gas-url-input');
    if (gasInput && gasInput.value.trim()) {
      this.uploadToGoogleSheet();
    }
  },

  // --- 上傳成績至 Google Sheet ---
  async uploadToGoogleSheet() {
    const input = document.getElementById('gas-url-input');
    const url = input ? input.value.trim() : '';
    const statusBox = document.getElementById('upload-status-box');

    if (!url) {
      alert('請先填入 Google Apps Script 網路應用程式 URL！\n若您尚未設定，請參考頁面下方設定指引。');
      return;
    }

    localStorage.setItem(GAS_URL_KEY, url);

    const btn = document.getElementById('upload-gas-btn');
    btn.disabled = true;
    btn.innerText = '正在上傳成績至 Google 試算表...';

    const penalty = this.state.scoreResult?.penalty_points ?? this.state.penaltyPoints ?? 0;
    const violations = this.state.scoreResult?.screenshot_violations ?? this.state.screenshotViolations ?? 0;
    const rawScore = this.state.scoreResult?.raw_score ?? (this.state.scoreResult?.score ? this.state.scoreResult.score + penalty : 0);

    const payload = {
      action: 'record_score',
      timestamp: new Date().toISOString(),
      student_name: this.state.studentName,
      student_id: this.state.studentId,
      score: this.state.scoreResult?.score ?? 0,
      raw_score: rawScore,
      penalty_points: penalty,
      screenshot_violations: violations,
      correct_count: this.state.scoreResult?.correct_count ?? 0,
      total_questions: 80,
      exam_id: this.state.examId,
      duration_seconds: this.state.scoreResult?.duration_used_seconds || 0
    };

    try {
      // 透過後端 Proxy 上傳（解決瀏覽器跨網域 CORS 問題）
      const resp = await fetch('/api/upload_score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script_url: url, payload: payload })
      });

      const resData = await resp.json();
      if (resData.success) {
        statusBox.className = 'upload-status success';
        statusBox.innerText = `✅ 成績上傳成功！已順利記錄至 Google 試算表 (${new Date().toLocaleTimeString()})`;
      } else {
        throw new Error(resData.message || '上傳失敗');
      }
    } catch (e) {
      console.warn('後端代理失敗，嘗試前端直連發送...', e);
      try {
        // 前端直連嘗試 (mode: no-cors)
        await fetch(url, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        statusBox.className = 'upload-status success';
        statusBox.innerText = `✅ 成績資料已成功發送至 Google Apps Script！(${new Date().toLocaleTimeString()})`;
      } catch (err) {
        statusBox.className = 'upload-status error';
        statusBox.innerText = `❌ 上傳遭遇問題：${err.message}。請下載 CSV 成績證明作為備份。`;
      }
    } finally {
      btn.disabled = false;
      btn.innerText = '一鍵上傳成績至 Google 試算表';
    }
  },

  // --- 下載成績證明 CSV ---
  downloadCSV() {
    const res = this.state.scoreResult || {};
    const penalty = res.penalty_points || this.state.penaltyPoints || 0;
    const violations = res.screenshot_violations || this.state.screenshotViolations || 0;

    const rows = [
      ['項目', '內容'],
      ['考生姓名', this.state.studentName],
      ['考生學號', this.state.studentId],
      ['考試代碼', this.state.examId || 'N/A'],
      ['最終成績', res.score !== undefined ? res.score : 'N/A'],
      ['答對題數', `${res.correct_count || 0} / 80`],
      ['違規截圖扣分', penalty > 0 ? `-${penalty} 分 (截圖 ${violations} 次)` : '無違規 (0分)'],
      ['交卷時間', new Date().toLocaleString('zh-TW')]
    ];

    let csvContent = '\uFEFF'; // UTF-8 BOM
    rows.forEach(r => {
      csvContent += r.map(x => `"${x}"`).join(',') + '\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `實習病毒學期末成績_${this.state.studentId}_${this.state.studentName}.csv`;
    link.click();
  },

  // --- 複製成績證明代碼 ---
  copyCertificateToken() {
    const token = btoa(unescape(encodeURIComponent(JSON.stringify({
      id: this.state.studentId,
      name: this.state.studentName,
      score: this.state.scoreResult?.score,
      time: Date.now()
    }))));

    navigator.clipboard.writeText(token).then(() => {
      alert('成績數位防偽代碼已複製到剪貼簿！');
    }).catch(() => {
      prompt('請複製以下防偽代碼：', token);
    });
  },

  // --- 圖片放大檢視 (Lightbox Modal) ---
  openImageModal(src) {
    if (!src) return;
    const modal = document.getElementById('image-modal');
    const preview = document.getElementById('modal-image-preview');
    if (modal && preview) {
      preview.src = src;
      modal.style.display = 'flex';
    }
  },

  closeImageModal() {
    const modal = document.getElementById('image-modal');
    if (modal) {
      modal.style.display = 'none';
      const preview = document.getElementById('modal-image-preview');
      if (preview) preview.src = '';
    }
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
