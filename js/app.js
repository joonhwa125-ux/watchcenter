document.addEventListener("DOMContentLoaded", () => {
  // --- [Core] 전역 변수 ---
  let rawTextData = "";
  let parsedData = []; // 파싱된 원본 데이터
  let deduplicatedData = []; // 중복 제거된 데이터
  let currentFilteredData = [];
  let calendar = null;
  let readIssues = JSON.parse(localStorage.getItem("readIssues_v3")) || [];

  // --- [UI] DOM 요소 ---
  const fileInput = document.getElementById("fileInput");
  const uploadBox = document.getElementById("uploadDropZone");
  const fileNameDisplay = document.getElementById("fileName");
  const userSelect = document.getElementById("userSelect");
  const btnBack = document.getElementById("btnBackToCalendar");

  // 통계 표시용
  const globalStats = document.getElementById("globalStats");
  const totalIssueCount = document.getElementById("totalIssueCount");
  const totalUserCount = document.getElementById("totalUserCount");

  const calendarView = document.getElementById("calendarView");
  const listView = document.getElementById("listView");
  const cardGrid = document.getElementById("cardGrid");
  const listTitle = document.getElementById("listTitle");

  // --- [Event] 리스너 ---
  uploadBox.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fileNameDisplay.textContent = file.name;

    const reader = new FileReader();
    reader.onload = (event) => {
      rawTextData = event.target.result;
      processLogAndInit();
    };
    reader.readAsText(file, "UTF-8");
  });

  userSelect.addEventListener("change", () => {
    renderApp(userSelect.value);
  });

  btnBack.addEventListener("click", showCalendarView);

  // --- [Logic 1] 파싱 및 초기화 ---
  function processLogAndInit() {
    parsedData = parseKakaoLogJS(rawTextData);

    if (parsedData.length === 0) {
      alert("유효한 데이터가 없습니다. 파일을 확인해주세요.");
      return;
    }

    deduplicatedData = deduplicateIssues(parsedData);

    const uniqueUsers = [...new Set(deduplicatedData.map((item) => item.targetLdap))].sort();

    userSelect.innerHTML = `<option value="">전체 보기 (요약 모드)</option>`;
    uniqueUsers.forEach((user) => {
      const count = deduplicatedData.filter((i) => i.targetLdap === user).length;
      const option = document.createElement("option");
      option.value = user;
      option.textContent = `${user} (${count}건)`;
      userSelect.appendChild(option);
    });

    userSelect.disabled = false;

    globalStats.style.display = "block";
    totalIssueCount.textContent = deduplicatedData.length;
    totalUserCount.textContent = uniqueUsers.length;

    renderApp("");
  }

  // --- [Logic 2] 데이터 정제 (중복 제거) ---
  function deduplicateIssues(data) {
    const map = new Map();

    data.forEach((item) => {
      const uniqueKey = `${item.isoDate}_${item.issueKey}`;

      if (map.has(uniqueKey)) {
        const existing = map.get(uniqueKey);
        if (existing.actionType !== "할당" && item.actionType === "할당") {
          map.set(uniqueKey, item);
        }
      } else {
        map.set(uniqueKey, item);
      }
    });

    return Array.from(map.values());
  }

  // --- [Logic 3] 정밀 파서 (버퍼 방식) ---
  function parseKakaoLogJS(text) {
    const results = [];
    const lines = text.split("\n");

    const datePattern = /-{15}\s(\d{4}년\s\d{1,2}월\s\d{1,2}일.*?)\s-{15}/;
    const headerPattern = /\[WatchCenter\] \[(.*?)\]/;

    let currentDate = "날짜 미상";
    let currentIsoDate = "";

    let messageBuffer = [];
    let bufferTimestamp = "";

    const toIso = (dateStr) => {
      const nums = dateStr.match(/\d+/g);
      if (nums && nums.length >= 3) return `${nums[0]}-${String(nums[1]).padStart(2, "0")}-${String(nums[2]).padStart(2, "0")}`;
      return "";
    };

    const flushBuffer = () => {
      if (messageBuffer.length === 0) return;

      // 1. LDAP 추출 (첫 줄에 있음)
      // 예: "  userid 님아" 또는 "  userid님∽" 또는 "   님아" (주석 수정됨)
      const firstLine = messageBuffer[0];
      let rawTarget = "";
      if (firstLine.includes("님")) {
        rawTarget = firstLine.split("님")[0].trim();
      } else {
        rawTarget = firstLine.trim();
      }

      const targetLdap = rawTarget === "" ? "알 수 없음" : rawTarget;

      // 2. 내용 분석
      let issueKey = "키 없음";
      let issueUrl = "#";
      let summary = "";
      let actionType = "알림";
      let foundAction = false;

      messageBuffer.forEach((line, idx) => {
        const cleanLine = line.trim();

        const keyMatch = cleanLine.match(/browse\/([A-Z]+-\d+)/);
        if (keyMatch) {
          issueKey = keyMatch[1];
          issueUrl = cleanLine;
          if (messageBuffer[idx + 1]) {
            summary = messageBuffer[idx + 1].replace(/[└|]/g, "").trim();
          }
        }

        if (["할당", "멘션", "코멘트", "생성"].some((k) => cleanLine.includes(k))) {
          if (cleanLine.includes("할당")) actionType = "할당";
          else if (cleanLine.includes("멘션")) actionType = "멘션";
          else actionType = "코멘트";
          foundAction = true;
        }
      });

      if (foundAction || issueKey !== "키 없음") {
        results.push({
          targetLdap,
          issueKey,
          summary,
          actionType,
          rawDate: bufferTimestamp,
          fullDate: currentDate,
          isoDate: currentIsoDate,
          issueUrl,
        });
      }

      messageBuffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      const dateMatch = line.match(datePattern);
      if (dateMatch) {
        flushBuffer();
        currentDate = dateMatch[1];
        currentIsoDate = toIso(currentDate);
        continue;
      }

      const headerMatch = line.match(headerPattern);
      if (headerMatch) {
        flushBuffer();
        bufferTimestamp = headerMatch[1];
        const remaining = line.replace(headerPattern, "").trim();
        messageBuffer.push(remaining);
      } else {
        messageBuffer.push(line);
      }
    }
    flushBuffer();

    return results;
  }

  // --- [Logic 4] 앱 렌더링 ---
  function renderApp(filterLdap) {
    if (filterLdap === "") {
      currentFilteredData = deduplicatedData;
    } else {
      currentFilteredData = deduplicatedData.filter((item) => item.targetLdap === filterLdap);
    }

    initCalendar(filterLdap);
    showCalendarView();
  }

  // --- [UI] 캘린더 생성 ---
  function initCalendar(filterLdap) {
    const calendarEl = document.getElementById("calendar");
    const isAllView = filterLdap === "";

    let calendarEvents = [];

    if (isAllView) {
      const summaryMap = new Map();

      currentFilteredData.forEach((item) => {
        const key = `${item.isoDate}_${item.targetLdap}`;
        if (!summaryMap.has(key)) {
          summaryMap.set(key, {
            id: item.targetLdap,
            date: item.isoDate,
            assign: 0,
            comment: 0,
            mention: 0,
          });
        }
        const stat = summaryMap.get(key);
        if (item.actionType === "할당") stat.assign++;
        else if (item.actionType === "멘션") stat.mention++;
        else stat.comment++;
      });

      calendarEvents = Array.from(summaryMap.values()).map((stat) => {
        const parts = [];
        if (stat.assign) parts.push(`할당 ${stat.assign}`);
        if (stat.mention) parts.push(`멘션 ${stat.mention}`);
        if (stat.comment) parts.push(`코멘트 ${stat.comment}`);

        return {
          title: `[${stat.id}] ${parts.join(", ")}`,
          start: stat.date,
          color: "#64748b",
          extendedProps: { isSummary: true, userId: stat.id },
        };
      });
    } else {
      calendarEvents = currentFilteredData.map((item) => ({
        title: item.issueKey,
        start: item.isoDate,
        backgroundColor: getColor(item.actionType),
        borderColor: getColor(item.actionType),
        extendedProps: item,
      }));
    }

    calendar = new FullCalendar.Calendar(calendarEl, {
      initialView: "dayGridMonth",
      locale: "ko",
      height: "100%",
      headerToolbar: { left: "prev,next today", center: "title", right: "" },
      dayMaxEvents: 4,

      events: calendarEvents,

      dateClick: (info) => {
        showListView(info.dateStr, isAllView ? null : filterLdap);
      },

      eventClick: (info) => {
        const props = info.event.extendedProps;
        if (props.isSummary) {
          showListView(info.event.startStr, props.userId);
        } else {
          showListView(info.event.startStr, filterLdap);
        }
      },

      dayCellDidMount: (info) => {
        if (isAllView) return;

        const dateStr = info.dateStr;
        const dayItems = currentFilteredData.filter((i) => i.isoDate === dateStr);

        if (dayItems.length > 0) {
          const statsDiv = document.createElement("div");
          statsDiv.className = "day-stats";
          let counts = { 할당: 0, 멘션: 0, 코멘트: 0 };
          dayItems.forEach((i) => counts[i.actionType]++);
          if (counts.할당) statsDiv.innerHTML += `<div class="stat-dot assign"></div>`;
          if (counts.멘션) statsDiv.innerHTML += `<div class="stat-dot mention"></div>`;
          if (counts.코멘트) statsDiv.innerHTML += `<div class="stat-dot comment"></div>`;
          info.el.querySelector(".fc-daygrid-day-top").appendChild(statsDiv);
        }
      },
    });

    calendar.render();
    if (currentFilteredData.length > 0) calendar.gotoDate(currentFilteredData[0].isoDate);
  }

  // --- [UI] 리스트 뷰 ---
  function showListView(dateStr, specificUser = null) {
    let targetData = deduplicatedData.filter((i) => i.isoDate === dateStr);

    if (specificUser) {
      targetData = targetData.filter((i) => i.targetLdap === specificUser);
    } else if (userSelect.value !== "") {
      targetData = targetData.filter((i) => i.targetLdap === userSelect.value);
    }

    const titleText = specificUser ? `📅 ${dateStr} - ${specificUser} 이슈` : `📅 ${dateStr} 전체 이슈`;

    listTitle.innerHTML = `${titleText} <span style="font-size:14px; color:#64748b; font-weight:normal;">(${targetData.length}건)</span>`;
    cardGrid.innerHTML = "";

    if (targetData.length === 0) {
      cardGrid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:50px; color:#94a3b8;">표시할 이슈가 없습니다.</div>`;
    } else {
      targetData.forEach((item) => {
        const isRead = readIssues.includes(item.issueKey);
        const card = document.createElement("div");
        card.className = `issue-card ${isRead ? "read" : ""}`;

        let badgeClass = "assign";
        if (item.actionType === "멘션") badgeClass = "mention";
        if (item.actionType === "코멘트") badgeClass = "comment";

        card.innerHTML = `
                    <div class="check-btn" data-key="${item.issueKey}">
                        <span class="iconify" data-icon="heroicons:check-16-solid"></span>
                    </div>
                    <div style="margin-bottom:10px;">
                        <span class="badge ${badgeClass}">${item.actionType}</span>
                        <span style="font-size:11px; color:#64748b; margin-left:5px;">👤 ${item.targetLdap}</span>
                        <a href="${item.issueUrl}" target="_blank" style="font-weight:700; color:#1e293b; text-decoration:none; margin-left:5px;">
                            ${item.issueKey}
                        </a>
                    </div>
                    <div style="font-size:14px; margin-bottom:10px; line-height:1.5;">${item.summary}</div>
                    <div style="font-size:12px; color:#94a3b8;">${item.fullDate} ${item.rawDate}</div>
                `;

        const checkBtn = card.querySelector(".check-btn");
        checkBtn.addEventListener("click", (e) => toggleRead(item.issueKey, checkBtn));
        cardGrid.appendChild(card);
      });
    }

    calendarView.classList.remove("active");
    listView.classList.add("active");
  }

  function showCalendarView() {
    listView.classList.remove("active");
    calendarView.classList.add("active");
    if (calendar) calendar.render();
  }

  function toggleRead(key, btn) {
    const card = btn.closest(".issue-card");
    if (readIssues.includes(key)) {
      readIssues = readIssues.filter((k) => k !== key);
      card.classList.remove("read");
    } else {
      readIssues.push(key);
      card.classList.add("read");
    }
    localStorage.setItem("readIssues_v3", JSON.stringify(readIssues));
  }

  function getColor(type) {
    if (type === "할당") return "#3b82f6";
    if (type === "멘션") return "#f97316";
    return "#22c55e";
  }
});
