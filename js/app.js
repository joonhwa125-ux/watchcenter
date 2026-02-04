document.addEventListener("DOMContentLoaded", () => {
  // 1. STATE MODULE
  const State = {
    rawText: "",
    parsedData: [],
    dedupData: [],
    readIssues: JSON.parse(localStorage.getItem("readIssues_v3")) || [],

    saveSession(filename, text) {
      this.rawText = text;
      localStorage.setItem("watchtower_cached_text", text);
      localStorage.setItem("watchtower_cached_filename", filename);
    },
    clearSession() {
      localStorage.removeItem("watchtower_cached_text");
      localStorage.removeItem("watchtower_cached_filename");
    },
  };

  // 2. UI MODULE
  const UI = {
    els: {
      dropZone: document.getElementById("dropZone"),
      fileInput: document.getElementById("fileInput"),
      fileName: document.getElementById("fileName"),
      userSelect: document.getElementById("userSelect"),

      // [수정] 통계 영역 전체를 감싸는 섹션 (statsSection) 추가
      statsSection: document.getElementById("statsSection"),
      statsPanel: document.getElementById("statsPanel"),
      issueCount: document.getElementById("totalIssueCount"),
      userCount: document.getElementById("totalUserCount"),

      restoreNotice: document.getElementById("restoreNotice"),
      cardGrid: document.getElementById("cardGrid"),
      listTitle: document.getElementById("listTitle"),
      calendarEl: document.getElementById("calendar"),
      views: { calendar: document.getElementById("calendarView"), list: document.getElementById("listView") },
      btns: {
        clear: document.getElementById("btnClearData"),
        save: document.getElementById("btnDownloadBackup"),
        restore: document.getElementById("btnRestoreBackup"),
        back: document.getElementById("btnBackToCalendar"),
      },
      backupInput: document.getElementById("backupInput"),
    },

    reset() {
      // [수정] 통계 섹션 전체를 숨김
      if (this.els.statsSection) this.els.statsSection.style.display = "none";

      this.els.restoreNotice.style.display = "none";
      this.els.userSelect.innerHTML = '<option value="">데이터 없음</option>';
      this.els.userSelect.disabled = true;
      this.els.fileName.textContent = "선택된 파일 없음";
      this.els.dropZone.title = "";
    },

    updateFileName(name, isRestore = false) {
      this.els.fileName.textContent = name;
      this.els.dropZone.title = name;

      if (isRestore) {
        this.els.restoreNotice.style.display = "flex";
      } else {
        this.els.restoreNotice.style.display = "none";
      }
    },

    renderStats(totalIssues, totalUsers) {
      // [수정] 통계 섹션 전체를 보이게 함
      if (this.els.statsSection) this.els.statsSection.style.display = "block";
      // (혹은 flex가 필요하다면 'flex'로 지정, 위 CSS에서 .group-section은 flex-col이므로 block도 무관)

      this.els.issueCount.textContent = totalIssues;
      this.els.userCount.textContent = totalUsers;
    },

    switchView(viewName) {
      this.els.views.calendar.classList.remove("active");
      this.els.views.list.classList.remove("active");
      this.els.views[viewName].classList.add("active");
    },
  };

  // 3. APP CONTROLLER
  const App = {
    calendarInstance: null,

    init() {
      this.bindEvents();
      this.loadSession();
    },

    loadSession() {
      const cachedText = localStorage.getItem("watchtower_cached_text");
      const cachedName = localStorage.getItem("watchtower_cached_filename");

      if (cachedText) {
        State.rawText = cachedText;
        UI.updateFileName(cachedName || "복구된 파일", true);
        this.processData();
      } else {
        UI.reset();
      }
    },

    handleFileSelect(file) {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".txt") && file.type !== "text/plain") {
        alert("텍스트(.txt) 파일만 지원합니다.");
        return;
      }

      UI.updateFileName(file.name, false);

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        if (!text.trim()) {
          alert("내용 없음");
          return;
        }
        State.saveSession(file.name, text);
        this.processData();
      };
      reader.readAsText(file);
    },

    processData() {
      // --- Parsing Logic ---
      const parse = (text) => {
        const results = [];
        const lines = text.split("\n");
        const headerPattern = /\[WatchCenter\] \[(.*?)\]/;
        const datePattern = /-{15}\s(\d{4}년\s\d{1,2}월\s\d{1,2}일.*?)\s-{15}/;
        let currentDate = "",
          currentIso = "",
          buffer = [],
          bufferTime = "";

        const toIso = (s) => {
          const m = s.match(/\d+/g);
          return m && m.length >= 3 ? `${m[0]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
        };

        const flush = () => {
          if (buffer.length === 0) return;
          const first = buffer[0];
          let user = first.includes("님") ? first.split("님")[0].trim() : first.trim();
          if (!user) user = "알 수 없음";
          let key = "키 없음",
            url = "#",
            summary = "",
            action = "알림",
            found = false;

          buffer.forEach((line, i) => {
            const l = line.trim();
            const kMatch = l.match(/browse\/([A-Z]+-\d+)/);
            if (kMatch) {
              key = kMatch[1];
              url = l;
              if (buffer[i + 1]) summary = buffer[i + 1].replace(/[└|]/g, "").trim();
            }
            if (["할당", "멘션", "코멘트"].some((k) => l.includes(k))) {
              if (l.includes("할당")) action = "할당";
              else if (l.includes("멘션")) action = "멘션";
              else action = "코멘트";
              found = true;
            }
          });
          if (found || key !== "키 없음") {
            results.push({ targetLdap: user, issueKey: key, summary, actionType: action, rawDate: bufferTime, isoDate: currentIso, fullDate: currentDate, issueUrl: url });
          }
          buffer = [];
        };

        for (let line of lines) {
          line = line.trim();
          if (!line) continue;
          if (datePattern.test(line)) {
            flush();
            currentDate = line.match(datePattern)[1];
            currentIso = toIso(currentDate);
            continue;
          }
          const hMatch = line.match(headerPattern);
          if (hMatch) {
            flush();
            bufferTime = hMatch[1];
            buffer.push(line.replace(headerPattern, "").trim());
          } else {
            buffer.push(line);
          }
        }
        flush();
        return results;
      };

      const deduplicate = (data) => {
        const map = new Map();
        data.forEach((item) => {
          const k = `${item.isoDate}_${item.issueKey}`;
          if (map.has(k)) {
            const ex = map.get(k);
            if (ex.actionType !== "할당" && item.actionType === "할당") map.set(k, item);
          } else {
            map.set(k, item);
          }
        });
        return Array.from(map.values());
      };

      State.parsedData = parse(State.rawText);
      if (State.parsedData.length === 0) {
        alert("데이터 없음");
        UI.reset();
        return;
      }
      State.dedupData = deduplicate(State.parsedData);
      this.updateFilters();
      UI.renderStats(State.dedupData.length, [...new Set(State.dedupData.map((d) => d.targetLdap))].length);
      this.renderCalendar(UI.els.userSelect.value);
    },

    updateFilters() {
      const users = [...new Set(State.dedupData.map((d) => d.targetLdap))].sort();
      const prev = UI.els.userSelect.value;
      UI.els.userSelect.innerHTML = `<option value="">전체 보기 (요약 모드)</option>`;
      users.forEach((u) => {
        const count = State.dedupData.filter((d) => d.targetLdap === u).length;
        const opt = document.createElement("option");
        opt.value = u;
        opt.textContent = `${u} (${count}건)`;
        UI.els.userSelect.appendChild(opt);
      });
      UI.els.userSelect.disabled = false;
      if (users.includes(prev)) UI.els.userSelect.value = prev;
    },

    renderCalendar(filterUser) {
      if (!UI.els.calendarEl) return;
      const data = filterUser === "" ? State.dedupData : State.dedupData.filter((d) => d.targetLdap === filterUser);
      const isSummary = filterUser === "";
      let events = [];

      if (isSummary) {
        const map = new Map();
        data.forEach((d) => {
          const k = `${d.isoDate}_${d.targetLdap}`;
          if (!map.has(k)) map.set(k, { id: d.targetLdap, date: d.isoDate, assign: 0, mention: 0, comment: 0 });
          const s = map.get(k);
          if (d.actionType === "할당") s.assign++;
          else if (d.actionType === "멘션") s.mention++;
          else s.comment++;
        });
        events = Array.from(map.values()).map((s) => {
          const t = [];
          if (s.assign) t.push(`할당 ${s.assign}`);
          if (s.mention) t.push(`멘션 ${s.mention}`);
          if (s.comment) t.push(`코멘트 ${s.comment}`);
          return { title: `[${s.id}] ${t.join(" ")}`, start: s.date, color: "#64748b", extendedProps: { userId: s.id } };
        });
      } else {
        events = data.map((d) => ({
          title: d.issueKey,
          start: d.isoDate,
          color: d.actionType === "할당" ? "#3b82f6" : d.actionType === "멘션" ? "#f97316" : "#22c55e",
          extendedProps: { ...d },
        }));
      }

      this.calendarInstance = new FullCalendar.Calendar(UI.els.calendarEl, {
        initialView: "dayGridMonth",
        locale: "ko",
        height: "100%",
        headerToolbar: { left: "prev,next today", center: "title", right: "" },
        dayMaxEvents: 4,
        events: events,
        eventClick: (info) => {
          const props = info.event.extendedProps;
          this.showList(info.event.startStr, isSummary ? props.userId : filterUser);
        },
        dateClick: (info) => this.showList(info.dateStr, filterUser || null),
      });
      this.calendarInstance.render();
      if (data.length > 0) this.calendarInstance.gotoDate(data[0].isoDate);
      UI.switchView("calendar");
    },

    showList(date, user) {
      let filtered = State.dedupData.filter((d) => d.isoDate === date);
      if (user) filtered = filtered.filter((d) => d.targetLdap === user);

      UI.els.listTitle.innerHTML = `
        <span class="iconify" data-icon="heroicons:calendar-days-solid" style="color:#64748b; font-size:20px; margin-right:6px;"></span>
        ${date} <span style="font-size:14px; color:#64748b; margin-left:6px;">(${filtered.length}건)</span>
      `;

      UI.els.cardGrid.innerHTML = filtered.length ? "" : '<div style="grid-column:1/-1; text-align:center; padding:40px; color:#94a3b8;">데이터 없음</div>';

      filtered.forEach((d) => {
        const isRead = State.readIssues.includes(d.issueKey);
        const div = document.createElement("div");
        div.className = `issue-card ${isRead ? "read" : ""}`;
        let badgeColor = d.actionType === "할당" ? "background:#eff6ff; color:#1d4ed8;" : d.actionType === "멘션" ? "background:#fff7ed; color:#c2410c;" : "background:#f0fdf4; color:#15803d;";

        div.innerHTML = `
          <div class="check-btn" onclick="App.toggleIssue('${d.issueKey}', this)">
            <span class="iconify" data-icon="heroicons:check-circle-solid" style="font-size:20px;"></span>
          </div>
          <div class="card-header">
            <span class="badge" style="${badgeColor}">${d.actionType}</span> 
            <a href="${d.issueUrl}" target="_blank" class="issue-link">${d.issueKey}</a>
          </div>
          <div class="card-body">${d.summary}</div>
          <div class="card-footer">
            <span class="meta-date">${d.fullDate} ${d.rawDate}</span> 
            <div class="user-info">
              <span class="iconify" data-icon="heroicons:user-circle-solid" style="font-size:16px;"></span>
              ${d.targetLdap}
            </div>
          </div>
        `;
        UI.els.cardGrid.appendChild(div);
      });
      UI.switchView("list");
    },

    toggleIssue(key, btn) {
      const card = btn.closest(".issue-card");
      if (State.readIssues.includes(key)) {
        State.readIssues = State.readIssues.filter((k) => k !== key);
        card.classList.remove("read");
      } else {
        State.readIssues.push(key);
        card.classList.add("read");
      }
      localStorage.setItem("readIssues_v3", JSON.stringify(State.readIssues));
    },

    bindEvents() {
      UI.els.fileInput.addEventListener("change", (e) => {
        if (e.target.files.length) this.handleFileSelect(e.target.files[0]);
        e.target.value = "";
      });
      ["dragenter", "dragover", "dragleave", "drop"].forEach((evt) => {
        UI.els.dropZone.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        window.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
      });
      UI.els.dropZone.addEventListener("dragenter", () => UI.els.dropZone.classList.add("drag-over"));
      UI.els.dropZone.addEventListener("dragover", () => UI.els.dropZone.classList.add("drag-over"));
      UI.els.dropZone.addEventListener("dragleave", () => UI.els.dropZone.classList.remove("drag-over"));
      UI.els.dropZone.addEventListener("drop", (e) => {
        UI.els.dropZone.classList.remove("drag-over");
        if (e.dataTransfer.files.length) this.handleFileSelect(e.dataTransfer.files[0]);
      });

      UI.els.userSelect.addEventListener("change", () => this.renderCalendar(UI.els.userSelect.value));
      UI.els.btns.back.addEventListener("click", () => {
        UI.switchView("calendar");
        if (this.calendarInstance) this.calendarInstance.render();
      });
      UI.els.btns.clear.addEventListener("click", () => {
        if (confirm("저장된 데이터를 모두 지우고 초기화하시겠습니까?")) {
          State.clearSession();
          location.reload();
        }
      });
      UI.els.btns.save.addEventListener("click", () => {
        if (!State.rawText) {
          alert("데이터 없음");
          return;
        }
        const now = new Date();
        const dateStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0") + "_" + String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
        const data = { date: now.toISOString(), readIssues: State.readIssues, cachedText: State.rawText };
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `JiraWatchtower_Backup_${dateStr}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
      UI.els.btns.restore.addEventListener("click", () => UI.els.backupInput.click());
      UI.els.backupInput.addEventListener("change", (e) => {
        if (!e.target.files.length) return;
        const r = new FileReader();
        r.onload = (ev) => {
          try {
            const json = JSON.parse(ev.target.result);
            if (json.readIssues) {
              State.readIssues = json.readIssues;
              localStorage.setItem("readIssues_v3", JSON.stringify(State.readIssues));
            }
            if (json.cachedText) {
              this.handleFileSelect(new File([json.cachedText], "Restored_Backup.txt", { type: "text/plain" }));
            }
            alert("복구 완료");
          } catch (err) {
            alert("백업 파일 오류");
          }
        };
        r.readAsText(e.target.files[0]);
        e.target.value = "";
      });
    },
    els: () => UI.els,
  };

  window.App = App;
  App.init();
});
