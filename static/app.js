const TimeTracker = (() => {
    // ---------------- shared helpers ----------------

    async function api(path, opts) {
        const res = await fetch(path, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
            ...opts,
        });
        if (res.status === 401 || res.status === 302) {
            window.location.href = "/login";
            return null;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.error || `Request failed (${res.status})`);
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        return data;
    }

    const pad2 = (n) => String(n).padStart(2, "0");

    function fmtHms(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds));
        return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
    }

    function fmtHoursMinutes(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds));
        return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
    }

    function fmtMinutes(mins) {
        const h = Math.floor(mins / 60);
        return h ? `${h}h ${pad2(mins % 60)}m` : `${mins}m`;
    }

    function fmtClock(msOrIso) {
        return new Date(msOrIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function entryDurationSeconds(entry) {
        const start = new Date(entry.start_ts).getTime();
        const end = entry.end_ts ? new Date(entry.end_ts).getTime() : Date.now();
        return (end - start) / 1000;
    }

    function toLocalTimeInputValue(msOrIso) {
        const d = new Date(msOrIso);
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    function toLocalDateInputValue(d) {
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function parseLocalDate(yyyymmdd) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd || "");
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    }

    function startOfLocalDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function addDays(d, n) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    }

    // Next Mon-Fri day after d (Friday/Saturday/Sunday -> Monday).
    function nextWorkday(d) {
        let n = addDays(d, 1);
        while (n.getDay() === 0 || n.getDay() === 6) n = addDays(n, 1);
        return n;
    }

    function fmtDayLabel(d) {
        return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    }

    // HH:MM on the local calendar date of dateObj -> UTC ISO string.
    function localDateTimeIso(dateObj, hhmm) {
        const [h, m] = hhmm.split(":").map(Number);
        return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), h, m, 0).toISOString();
    }

    function combineDateAndTime(referenceIso, hhmm) {
        return localDateTimeIso(new Date(referenceIso), hhmm);
    }

    function catHue(name) {
        let h = 0;
        for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
        return h;
    }

    function makeTag(name, extraClass) {
        const span = document.createElement("span");
        span.className = "tag" + (extraClass ? ` ${extraClass}` : "");
        span.style.setProperty("--h", catHue(name));
        span.textContent = name;
        return span;
    }

    function makeTicketPill(ticket) {
        const span = document.createElement("span");
        span.className = "ticket";
        span.textContent = ticket;
        return span;
    }

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        for (const c of children) node.append(c);
        return node;
    }

    function topicSelect(topics, selectedId, placeholder) {
        const select = document.createElement("select");
        if (placeholder) select.append(el("option", { value: "", textContent: placeholder }));
        for (const t of topics) {
            const opt = el("option", { value: String(t.id), textContent: `${t.category_name} / ${t.name}` });
            if (t.id === selectedId) opt.selected = true;
            select.append(opt);
        }
        return select;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function showToast(msg) {
        const t = el("div", { className: "toast", textContent: msg });
        document.body.append(t);
        setTimeout(() => t.remove(), 2200);
    }

    function localTodayStr() {
        return toLocalDateInputValue(new Date());
    }

    // What the big clock should show, given /api/status data.
    function clockView(st, now) {
        const { active, day, untracked_since } = st;
        if (active) {
            return {
                label: `${active.category_name} / ${active.topic_name}` + (active.ticket ? ` · ${active.ticket}` : ""),
                text: fmtHms(entryDurationSeconds(active)),
                mode: "running",
                showStop: true,
            };
        }
        if (day && !day.finished_at) {
            const since = Date.parse(untracked_since || day.started_at);
            return { label: "Untracked", text: fmtHms((now - since) / 1000), mode: "untracked", showStop: false };
        }
        if (day && day.finished_at) {
            return { label: `Day finished ${fmtClock(day.finished_at)}`, text: "00:00:00", mode: "idle", showStop: false };
        }
        return { label: "Day not started", text: "00:00:00", mode: "idle", showStop: false };
    }

    // Takes element references (not ids) so it keeps working after the
    // timer is moved into the pop-out window's separate document.
    function clockElements(displayId, topicId, stopId) {
        return {
            display: document.getElementById(displayId),
            topic: document.getElementById(topicId),
            stop: document.getElementById(stopId),
        };
    }

    function applyClock(view, els) {
        els.display.className = "timer-display" + (view.mode === "running" ? "" : view.mode === "untracked" ? " untracked" : " idle");
        els.display.textContent = view.text;
        els.topic.textContent = view.label;
        els.stop.style.display = view.showStop ? "inline-block" : "none";
    }

    async function staleOpenDays() {
        const open = await api("/api/days/open");
        const today = localTodayStr();
        return open.filter((d) => d.date < today);
    }

    // Untracked = parts of the open/finished day span not covered by any entry.
    function computeGaps(entries, day, hasActive, nowMs) {
        if (!day) return [];
        const spanStart = Date.parse(day.started_at);
        const spanEnd = day.finished_at ? Date.parse(day.finished_at) : nowMs;
        const ivs = entries
            .map((e) => [
                Math.max(Date.parse(e.start_ts), spanStart),
                Math.min(e.end_ts ? Date.parse(e.end_ts) : nowMs, spanEnd),
            ])
            .filter(([a, b]) => b > a)
            .sort((x, y) => x[0] - y[0]);
        const gaps = [];
        let cursor = spanStart;
        for (const [a, b] of ivs) {
            if (a - cursor >= 60000) gaps.push({ start: cursor, end: a, open: false });
            cursor = Math.max(cursor, b);
        }
        if (spanEnd - cursor >= 60000) {
            gaps.push({ start: cursor, end: spanEnd, open: !day.finished_at && !hasActive });
        }
        return gaps;
    }

    function groupTopicsByCategory(topics) {
        const map = new Map();
        for (const t of topics) {
            if (!map.has(t.category_id)) map.set(t.category_id, { category_name: t.category_name, topics: [] });
            map.get(t.category_id).topics.push(t);
        }
        return [...map.values()];
    }

    // ---------------- Today page ----------------

    const ALERT_THRESHOLD_MINUTES = [15, 30, 45];

    function initToday() {
        const todayStr = localTodayStr();
        let status = { active: null, day: null, untracked_since: null };
        let topicsCache = [];
        let staleDays = [];
        let viewDay = null;
        let viewEntries = [];
        const notifiedKeys = new Set();
        const ticketCache = new Map();
        let ticketRowKey = null;
        const clockEls = clockElements("timer-display", "timer-topic", "stop-btn");

        let viewDate = startOfLocalDay(
            parseLocalDate(new URLSearchParams(window.location.search).get("d")) || new Date()
        );

        // ---- clock ----

        function renderStatus() {
            const view = clockView(status, Date.now());
            applyClock(view, clockEls);
            if (status.active) checkTimeAlerts(status.active);

            const day = status.day;
            document.getElementById("start-day-btn").style.display = !day ? "inline-block" : "none";
            document.getElementById("feierabend-btn").style.display = day && !day.finished_at ? "inline-block" : "none";
            const finished = document.getElementById("day-finished");
            finished.style.display = day && day.finished_at ? "inline" : "none";
            if (day && day.finished_at) {
                document.getElementById("day-finished-text").textContent = `Day finished at ${fmtClock(day.finished_at)}.`;
            }
            const locked = !!(day && day.finished_at);
            const search = document.getElementById("topic-search");
            search.disabled = locked;
            search.placeholder = locked
                ? "Day finished — reopen to keep tracking"
                : "Start a topic — type to search, Enter to start";
        }

        async function refreshStatus() {
            status = await api(`/api/status?date=${todayStr}`);
            renderStatus();
            await renderTicketRow();
        }

        // ---- ticket row (optional third layer, after the topic is chosen) ----

        async function renderTicketRow() {
            const row = document.getElementById("ticket-row");
            const a = status.active;
            if (!a) {
                row.style.display = "none";
                ticketRowKey = null;
                return;
            }
            const key = `${a.id}:${a.ticket || ""}`;
            if (key === ticketRowKey) return;
            ticketRowKey = key;
            let tickets = ticketCache.get(a.topic_id);
            if (!tickets) {
                tickets = await api(`/api/tickets?topic_id=${a.topic_id}`);
                ticketCache.set(a.topic_id, tickets);
            }
            row.innerHTML = "";
            row.style.display = "flex";
            if (a.ticket) {
                const clear = el("button", { className: "small link", textContent: "×", title: "Remove ticket" });
                clear.addEventListener("click", () => setTicket(""));
                row.append(makeTicketPill(a.ticket), clear);
            } else {
                row.append(el("span", { className: "muted", textContent: "Ticket:", style: "font-size:12px;" }));
            }
            for (const t of tickets.filter((x) => x !== a.ticket)) {
                const chip = el("button", { className: "topic-chip", textContent: t });
                chip.addEventListener("click", () => setTicket(t));
                row.append(chip);
            }
            const input = el("input", { type: "text", placeholder: a.ticket ? "change…" : "new ticket…" });
            input.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter" && input.value.trim()) setTicket(input.value.trim());
            });
            row.append(input);
        }

        async function setTicket(value) {
            if (!status.active) return;
            await api(`/api/entries/${status.active.id}`, { method: "PATCH", body: JSON.stringify({ ticket: value }) });
            ticketCache.delete(status.active.topic_id);
            await refreshStatus();
            await refreshEntries();
        }

        // ---- gentle alerts at 15/30/45 min ----

        function updateNotifBtnLabel() {
            const btn = document.getElementById("notif-btn");
            if (!("Notification" in window)) {
                btn.textContent = "🔔✕";
                btn.disabled = true;
                return;
            }
            btn.textContent = Notification.permission === "granted" ? "🔔" : Notification.permission === "denied" ? "🔕" : "🔔?";
            btn.title =
                Notification.permission === "granted"
                    ? "Alerts on: gentle notification at 15/30/45 min"
                    : Notification.permission === "denied"
                    ? "Alerts blocked in browser settings"
                    : "Click to enable gentle alerts at 15/30/45 min";
        }

        function checkTimeAlerts(entry) {
            if (!("Notification" in window) || Notification.permission !== "granted") return;
            const elapsedMin = entryDurationSeconds(entry) / 60;
            for (const threshold of ALERT_THRESHOLD_MINUTES) {
                const key = `${entry.id}:${threshold}`;
                if (elapsedMin >= threshold && !notifiedKeys.has(key)) {
                    notifiedKeys.add(key);
                    new Notification(`${threshold} min on ${entry.topic_name}`, {
                        body: entry.category_name,
                        silent: true,
                        tag: key,
                    });
                }
            }
        }

        document.getElementById("notif-btn").addEventListener("click", async () => {
            if ("Notification" in window && Notification.permission === "default") {
                await Notification.requestPermission();
            }
            updateNotifBtnLabel();
        });
        updateNotifBtnLabel();

        // ---- pop-out floating timer ----

        const widgetContent = document.getElementById("widget-content");
        const widgetHome = widgetContent.parentElement;
        const widgetHomeNext = widgetContent.nextSibling;
        let pipWindow = null;

        document.getElementById("popout-btn").addEventListener("click", async () => {
            if (pipWindow) {
                pipWindow.focus();
                return;
            }
            if ("documentPictureInPicture" in window) {
                try {
                    pipWindow = await window.documentPictureInPicture.requestWindow({ width: 280, height: 140 });
                } catch (err) {
                    console.warn("Document Picture-in-Picture unavailable, falling back to a popup window:", err);
                    pipWindow = null;
                }
            }
            if (pipWindow) {
                const link = pipWindow.document.createElement("link");
                link.rel = "stylesheet";
                link.href = "/static/style.css";
                pipWindow.document.head.appendChild(link);
                const style = pipWindow.document.createElement("style");
                style.textContent = `
                    html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text);
                                 display: flex; align-items: center; justify-content: center;
                                 font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
                    #widget-content { width: 100%; text-align: center; padding: 6px; }
                `;
                pipWindow.document.head.appendChild(style);
                pipWindow.document.body.appendChild(widgetContent);
                pipWindow.addEventListener("pagehide", () => {
                    widgetHome.insertBefore(widgetContent, widgetHomeNext);
                    pipWindow = null;
                }, { once: true });
            } else {
                window.open("/widget", "timetrack-widget", "width=300,height=160,popup=yes");
            }
        });

        // ---- starting / stopping / day lifecycle ----

        async function startTopic(topic, ticket) {
            if (staleDays.length) {
                alert("An earlier day is still open — finish it in the banner above first, so its clock isn't cut at \"now\".");
                return;
            }
            await api("/api/start", {
                method: "POST",
                body: JSON.stringify({ topic_id: topic.id, ticket: ticket || null, date: todayStr }),
            });
            await Promise.all([refreshStatus(), refreshEntries(), refreshRecent()]);
        }

        document.getElementById("stop-btn").addEventListener("click", async () => {
            await api("/api/stop", { method: "POST" });
            await Promise.all([refreshStatus(), refreshEntries()]);
        });

        document.getElementById("start-day-btn").addEventListener("click", async () => {
            if (staleDays.length) {
                alert("An earlier day is still open — finish it in the banner above first.");
                return;
            }
            await api("/api/day/start", { method: "POST", body: JSON.stringify({ date: todayStr }) });
            await Promise.all([refreshStatus(), refreshEntries()]);
        });

        document.getElementById("feierabend-btn").addEventListener("click", async () => {
            if (!confirm("Feierabend? This stops the running topic and ends today's tracking.")) return;
            await api("/api/day/finish", { method: "POST", body: JSON.stringify({ date: todayStr }) });
            await Promise.all([refreshStatus(), refreshEntries()]);
        });

        document.getElementById("reopen-day-btn").addEventListener("click", async () => {
            await api("/api/day/reopen", { method: "POST", body: JSON.stringify({ date: todayStr }) });
            await Promise.all([refreshStatus(), refreshEntries()]);
        });

        // ---- stale (never finished) days ----

        async function refreshStale() {
            staleDays = await staleOpenDays();
            const banner = document.getElementById("stale-banner");
            banner.innerHTML = "";
            banner.style.display = staleDays.length ? "block" : "none";
            for (const d of staleDays) {
                const dateObj = parseLocalDate(d.date);
                const { start, end } = dayBoundsIso(dateObj);
                const entries = await api(`/api/entries?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
                const ends = entries.filter((e) => e.end_ts && e.end_ts >= d.started_at).map((e) => e.end_ts).sort();
                const stillRunning = entries.some((e) => !e.end_ts);
                const lastActivity = ends.length ? ends[ends.length - 1] : stillRunning ? null : d.started_at;

                const input = el("input", { type: "time", value: lastActivity ? toLocalTimeInputValue(lastActivity) : "" });
                const btn = el("button", { className: "small primary", textContent: "Finish that day" });
                btn.addEventListener("click", async () => {
                    if (!input.value) {
                        alert("Enter the time you actually stopped working.");
                        return;
                    }
                    const finishedAt = localDateTimeIso(dateObj, input.value);
                    if (Date.parse(finishedAt) < Date.parse(d.started_at)) {
                        alert("That is before the day started.");
                        return;
                    }
                    const running = entries.find((e) => !e.end_ts);
                    if (running && Date.parse(finishedAt) < Date.parse(running.start_ts)) {
                        alert(
                            `The running topic started at ${fmtClock(running.start_ts)}. ` +
                            "Pick a time after that, or correct its start time first."
                        );
                        return;
                    }
                    await api("/api/day/finish", {
                        method: "POST",
                        body: JSON.stringify({ date: d.date, finished_at: finishedAt }),
                    });
                    await refreshAll();
                });
                banner.append(
                    el("div", {}, [
                        el("strong", { textContent: fmtDayLabel(dateObj) }),
                        ` was never finished${stillRunning ? " and its clock may still be running" : ""}. I stopped working at `,
                    ]),
                    el("div", { className: "row-flex" }, [input, btn])
                );
            }
        }

        // ---- picker (search + recents) ----

        const searchInput = document.getElementById("topic-search");
        const resultsBox = document.getElementById("topic-results");
        let activeIdx = 0;
        let currentMatches = [];

        function matchTopics(query) {
            const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
            if (!tokens.length) return [];
            return topicsCache.filter((t) => {
                const hay = `${t.category_name} ${t.name}`.toLowerCase();
                return tokens.every((tok) => hay.includes(tok));
            });
        }

        function renderResults() {
            resultsBox.innerHTML = "";
            currentMatches = matchTopics(searchInput.value);
            if (!searchInput.value.trim()) {
                resultsBox.style.display = "none";
                return;
            }
            resultsBox.style.display = "block";
            if (!currentMatches.length) {
                resultsBox.append(el("div", { className: "muted", textContent: "No matching topic — add one under Topics." }));
                return;
            }
            activeIdx = Math.min(activeIdx, currentMatches.length - 1);
            currentMatches.forEach((t, i) => {
                const row = el("div", { className: i === activeIdx ? "active" : "" }, [makeTag(t.category_name), " ", t.name]);
                row.addEventListener("mousedown", (ev) => {
                    ev.preventDefault();
                    chooseTopic(t);
                });
                resultsBox.append(row);
            });
        }

        function chooseTopic(t) {
            searchInput.value = "";
            renderResults();
            startTopic(t);
        }

        searchInput.addEventListener("input", () => {
            activeIdx = 0;
            renderResults();
        });
        searchInput.addEventListener("keydown", (ev) => {
            if (ev.key === "ArrowDown") {
                ev.preventDefault();
                activeIdx = Math.min(activeIdx + 1, currentMatches.length - 1);
                renderResults();
            } else if (ev.key === "ArrowUp") {
                ev.preventDefault();
                activeIdx = Math.max(activeIdx - 1, 0);
                renderResults();
            } else if (ev.key === "Enter" && currentMatches[activeIdx]) {
                ev.preventDefault();
                chooseTopic(currentMatches[activeIdx]);
            } else if (ev.key === "Escape") {
                searchInput.value = "";
                renderResults();
            }
        });
        searchInput.addEventListener("blur", () => {
            resultsBox.style.display = "none";
        });
        searchInput.addEventListener("focus", renderResults);

        async function refreshTopics() {
            topicsCache = await api("/api/topics");
        }

        async function refreshRecent() {
            const recent = await api("/api/recent-topics?limit=6");
            const row = document.getElementById("recent-chips");
            row.innerHTML = "";
            for (const t of recent) {
                const chip = el("button", { className: "topic-chip", title: `${t.category_name} / ${t.name}` }, [
                    makeTag(t.category_name),
                    " ",
                    t.name,
                ]);
                chip.addEventListener("click", () => startTopic(t));
                row.append(chip);
            }
        }

        // ---- next up (from the Plan tab) ----

        async function refreshNextUp() {
            const box = document.getElementById("nextup");
            const items = await api(`/api/plan?date=${todayStr}`);
            const open = items.filter((i) => !i.done);
            if (!open.length) {
                box.style.display = "none";
                return;
            }
            const first = open[0];
            box.innerHTML = "";
            box.style.display = "flex";
            const startBtn = el("button", { className: "small primary", textContent: "▶ Start" });
            startBtn.addEventListener("click", () => startTopic({ id: first.topic_id }, first.ticket));
            const label = el("span", { className: "grow" }, [
                el("span", { className: "muted", textContent: "Next up: " }),
                makeTag(first.category_name),
                " ",
                first.title,
                first.expected_minutes ? el("span", { className: "est-badge", textContent: fmtMinutes(first.expected_minutes) }) : "",
            ]);
            const more = el("a", { href: "/plan", textContent: open.length > 1 ? `+${open.length - 1} more` : "Plan" });
            box.append(label, startBtn, more);
        }

        // ---- day navigation + entries timeline ----

        function dayBoundsIso(date) {
            const start = startOfLocalDay(date);
            return { start: start.toISOString(), end: addDays(start, 1).toISOString() };
        }

        function isViewingToday() {
            return viewDate.getTime() === startOfLocalDay(new Date()).getTime();
        }

        function renderDayControls() {
            document.getElementById("day-label").textContent = isViewingToday() ? "Today" : fmtDayLabel(viewDate);
            const picker = document.getElementById("day-picker");
            picker.value = toLocalDateInputValue(viewDate);
            picker.max = todayStr;
            document.getElementById("day-next").disabled = isViewingToday();
            document.getElementById("day-today").style.visibility = isViewingToday() ? "hidden" : "visible";
        }

        function setViewDate(date) {
            const target = startOfLocalDay(date);
            const today = startOfLocalDay(new Date());
            viewDate = target.getTime() > today.getTime() ? today : target;
            const url = new URL(window.location.href);
            if (isViewingToday()) url.searchParams.delete("d");
            else url.searchParams.set("d", toLocalDateInputValue(viewDate));
            window.history.replaceState(null, "", url);
            renderDayControls();
            refreshEntries();
        }

        document.getElementById("day-prev").addEventListener("click", () => setViewDate(addDays(viewDate, -1)));
        document.getElementById("day-next").addEventListener("click", () => setViewDate(addDays(viewDate, 1)));
        document.getElementById("day-today").addEventListener("click", () => setViewDate(new Date()));
        document.getElementById("day-picker").addEventListener("change", (ev) => {
            const picked = parseLocalDate(ev.target.value);
            if (picked) setViewDate(picked);
        });

        function timeCell(startMs, endMs, running) {
            return el("td", {
                className: "row-time",
                textContent: `${fmtClock(startMs)}–${running ? "now" : fmtClock(endMs)}`,
            });
        }

        function renderEntryRow(tr, e) {
            tr.className = "";
            tr.innerHTML = "";
            tr.append(timeCell(Date.parse(e.start_ts), e.end_ts ? Date.parse(e.end_ts) : 0, !e.end_ts));

            const what = el("td", {}, [makeTag(e.category_name), " ", e.topic_name]);
            if (e.ticket) what.append(makeTicketPill(e.ticket));
            tr.append(what);

            tr.append(el("td", { className: "num", textContent: fmtHoursMinutes(entryDurationSeconds(e)) }));

            const editBtn = el("button", { className: "small", textContent: "Edit", title: "Adjust topic / times / ticket" });
            editBtn.addEventListener("click", () => renderForm(tr, { entry: e }));
            const delBtn = el("button", { className: "small", textContent: "✕", title: "Delete entry" });
            delBtn.addEventListener("click", async () => {
                if (!confirm("Delete this entry?")) return;
                await api(`/api/entries/${e.id}`, { method: "DELETE" });
                await Promise.all([refreshEntries(), refreshStatus()]);
            });
            tr.append(el("td", {}, [editBtn, delBtn]));
        }

        function renderGapRow(tr, gap) {
            tr.className = "gap";
            tr.innerHTML = "";
            tr.append(timeCell(gap.start, gap.end, gap.open));
            tr.append(el("td", {}, [makeTag("untracked")]));
            tr.append(el("td", { className: "num", textContent: fmtHoursMinutes((gap.end - gap.start) / 1000) }));
            const assign = el("button", { className: "small", textContent: "Assign", title: "Book this gap to a topic" });
            assign.addEventListener("click", () => renderForm(tr, { gap }));
            tr.append(el("td", {}, [assign]));
        }

        function renderForm(tr, { entry, gap }) {
            tr.className = "";
            tr.innerHTML = "";
            const refMs = entry ? Date.parse(entry.start_ts) : gap.start;
            let options = topicsCache;
            if (entry && !options.some((t) => t.id === entry.topic_id)) {
                options = [...options, { id: entry.topic_id, name: entry.topic_name, category_name: entry.category_name }];
            }
            const select = topicSelect(options, entry ? entry.topic_id : null, entry ? null : "Choose topic…");
            const from = el("input", { type: "time", value: toLocalTimeInputValue(entry ? entry.start_ts : gap.start) });
            const toDefault = entry ? (entry.end_ts ? toLocalTimeInputValue(entry.end_ts) : "") : toLocalTimeInputValue(gap.end);
            const to = el("input", { type: "time", value: toDefault });
            if (entry && !entry.end_ts) to.title = "Leave blank to keep this entry running; set a time to close it";
            const ticket = el("input", { type: "text", placeholder: "ticket", value: entry && entry.ticket ? entry.ticket : "" });

            const save = el("button", { className: "small primary", textContent: "Save" });
            save.addEventListener("click", async () => {
                if (!select.value) {
                    alert("Choose a topic.");
                    return;
                }
                const startIso = combineDateAndTime(new Date(refMs).toISOString(), from.value);
                const endIso = to.value
                    ? combineDateAndTime(new Date(entry && entry.end_ts ? Date.parse(entry.end_ts) : refMs).toISOString(), to.value)
                    : null;
                if (endIso && Date.parse(endIso) <= Date.parse(startIso)) {
                    alert("The end time must be after the start time.");
                    return;
                }
                if (entry) {
                    const payload = { topic_id: parseInt(select.value, 10), start_ts: startIso, ticket: ticket.value };
                    if (endIso) payload.end_ts = endIso;
                    await api(`/api/entries/${entry.id}`, { method: "PATCH", body: JSON.stringify(payload) });
                } else {
                    if (!endIso) {
                        alert("Enter an end time for the gap.");
                        return;
                    }
                    await api("/api/entries", {
                        method: "POST",
                        body: JSON.stringify({
                            topic_id: parseInt(select.value, 10),
                            start_ts: startIso,
                            end_ts: endIso,
                            ticket: ticket.value,
                        }),
                    });
                }
                ticketCache.clear();
                await Promise.all([refreshEntries(), refreshStatus(), refreshRecent()]);
            });
            const cancel = el("button", { className: "small", textContent: "Cancel" });
            cancel.addEventListener("click", () => refreshEntries());

            const form = el("div", { className: "edit-form" }, [select, from, "–", to, ticket, save, cancel]);
            tr.append(el("td", { colSpan: 4 }, [form]));
        }

        async function refreshEntries() {
            const { start, end } = dayBoundsIso(viewDate);
            const dateStr = toLocalDateInputValue(viewDate);
            const [entries, dayResp] = await Promise.all([
                api(`/api/entries?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
                api(`/api/day?date=${dateStr}`),
            ]);
            viewEntries = entries;
            viewDay = dayResp.day;
            const hasActive = entries.some((e) => !e.end_ts);
            const gaps = computeGaps(entries, viewDay, hasActive, Date.now());

            const rows = [
                ...entries.map((e) => ({ at: Date.parse(e.start_ts), entry: e })),
                ...gaps.map((g) => ({ at: g.start, gap: g })),
            ].sort((a, b) => b.at - a.at);

            const body = document.getElementById("today-body");
            body.innerHTML = "";
            document.getElementById("today-empty").style.display = rows.length ? "none" : "block";
            for (const r of rows) {
                const tr = document.createElement("tr");
                if (r.entry) renderEntryRow(tr, r.entry);
                else renderGapRow(tr, r.gap);
                body.append(tr);
            }
            renderRecap(entries, gaps);
        }

        // Keyed by topic id so same-named topics in different categories stay separate.
        function renderRecap(entries, gaps) {
            const section = document.getElementById("recap-section");
            const body = document.getElementById("recap-body");
            body.innerHTML = "";
            section.style.display = entries.length || gaps.length ? "" : "none";
            const byTopic = new Map();
            let tracked = 0;
            for (const e of entries) {
                const secs = entryDurationSeconds(e);
                tracked += secs;
                const row = byTopic.get(e.topic_id) || { category: e.category_name, topic: e.topic_name, secs: 0 };
                row.secs += secs;
                byTopic.set(e.topic_id, row);
            }
            const untracked = gaps.reduce((sum, g) => sum + (g.end - g.start) / 1000, 0);
            const rows = [...byTopic.values()].sort((a, b) => a.category.localeCompare(b.category) || b.secs - a.secs);
            for (const r of rows) {
                body.append(el("tr", {}, [
                    el("td", {}, [makeTag(r.category)]),
                    el("td", { textContent: r.topic }),
                    el("td", { className: "num", textContent: fmtHoursMinutes(r.secs) }),
                ]));
            }
            if (untracked >= 60) {
                body.append(el("tr", { className: "gap" }, [
                    el("td", {}, [makeTag("untracked")]),
                    el("td", { textContent: "—" }),
                    el("td", { className: "num", textContent: fmtHoursMinutes(untracked) }),
                ]));
            }
            document.getElementById("recap-total").textContent = fmtHoursMinutes(tracked);
            document.getElementById("recap-summary").textContent =
                `Recap · tracked ${fmtHoursMinutes(tracked)}` + (untracked >= 60 ? ` · untracked ${fmtHoursMinutes(untracked)}` : "");
        }

        async function refreshAll() {
            await Promise.all([refreshStatus(), refreshEntries(), refreshStale(), refreshNextUp()]);
        }

        renderDayControls();
        renderStatus();
        Promise.all([refreshTopics(), refreshRecent()]).then(refreshAll);
        setInterval(renderStatus, 1000);
        setInterval(refreshEntries, 30000);
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) refreshAll();
        });
    }

    // ---------------- Plan page ----------------

    function initPlan() {
        const today = startOfLocalDay(new Date());
        const requested = parseLocalDate(new URLSearchParams(window.location.search).get("d"));
        // Late in the day you are planning tomorrow; earlier you want today's list.
        let planDate = requested || (new Date().getHours() >= 15 ? nextWorkday(today) : today);
        let topics = [];
        let items = [];

        const dateStr = () => toLocalDateInputValue(planDate);

        function setPlanDate(d) {
            planDate = startOfLocalDay(d);
            const url = new URL(window.location.href);
            url.searchParams.set("d", dateStr());
            window.history.replaceState(null, "", url);
            load();
        }

        document.getElementById("plan-prev").addEventListener("click", () => setPlanDate(addDays(planDate, -1)));
        document.getElementById("plan-next").addEventListener("click", () => setPlanDate(addDays(planDate, 1)));
        document.getElementById("plan-today").addEventListener("click", () => setPlanDate(new Date()));
        document.getElementById("plan-next-workday").addEventListener("click", () => setPlanDate(nextWorkday(new Date())));
        document.getElementById("plan-picker").addEventListener("change", (ev) => {
            const d = parseLocalDate(ev.target.value);
            if (d) setPlanDate(d);
        });

        function fillTopicSelect() {
            const select = document.getElementById("plan-topic");
            let remembered = "";
            try { remembered = localStorage.getItem("tt-plan-topic") || ""; } catch (e) { /* storage unavailable */ }
            select.innerHTML = "";
            for (const g of groupTopicsByCategory(topics)) {
                const og = el("optgroup", { label: g.category_name });
                for (const t of g.topics) og.append(el("option", { value: String(t.id), textContent: t.name }));
                select.append(og);
            }
            if (remembered && [...select.options].some((o) => o.value === remembered)) select.value = remembered;
            select.addEventListener("change", () => {
                try { localStorage.setItem("tt-plan-topic", select.value); } catch (e) { /* ignore */ }
            });
        }

        document.getElementById("plan-form").addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const title = document.getElementById("plan-title");
            await api("/api/plan", {
                method: "POST",
                body: JSON.stringify({
                    plan_date: dateStr(),
                    topic_id: parseInt(document.getElementById("plan-topic").value, 10),
                    title: title.value,
                    expected_minutes: document.getElementById("plan-est").value,
                    ticket: document.getElementById("plan-ticket").value,
                    notes: document.getElementById("plan-notes").value,
                }),
            });
            for (const id of ["plan-title", "plan-est", "plan-ticket", "plan-notes"]) document.getElementById(id).value = "";
            title.focus();
            await load();
        });

        async function patch(id, body) {
            await api(`/api/plan/${id}`, { method: "PATCH", body: JSON.stringify(body) });
            await load();
        }

        async function startItem(item) {
            const stale = await staleOpenDays();
            if (stale.length) {
                alert("An earlier day is still open — finish it on the Today tab first.");
                return;
            }
            await api("/api/start", {
                method: "POST",
                body: JSON.stringify({ topic_id: item.topic_id, ticket: item.ticket, date: localTodayStr() }),
            });
            showToast(`Started: ${item.category_name} / ${item.topic_name}`);
        }

        function renderForm(container, item) {
            container.innerHTML = "";
            const topic = topicSelect(topics, item.topic_id);
            const title = el("input", { type: "text", value: item.title, className: "title" });
            const est = el("input", { type: "number", min: 0, step: 5, value: item.expected_minutes ?? "", placeholder: "min", style: "width:70px;" });
            const ticket = el("input", { type: "text", value: item.ticket || "", placeholder: "ticket", style: "width:90px;" });
            const notes = el("textarea", { rows: 2, value: item.notes || "", placeholder: "Notes", style: "width:100%;" });
            const save = el("button", { className: "small primary", textContent: "Save" });
            save.addEventListener("click", () =>
                patch(item.id, {
                    topic_id: parseInt(topic.value, 10),
                    title: title.value,
                    expected_minutes: est.value,
                    ticket: ticket.value,
                    notes: notes.value,
                })
            );
            const cancel = el("button", { className: "small", textContent: "Cancel" });
            cancel.addEventListener("click", () => load());
            container.append(
                el("div", { className: "edit-form" }, [topic, title, est, ticket]),
                notes,
                el("div", { className: "row-flex", style: "justify-content:flex-start;gap:6px;margin-top:4px;" }, [save, cancel])
            );
        }

        function renderItem(item) {
            const row = el("div", { className: "plan-item" + (item.done ? " done" : "") });
            row.dataset.id = item.id;
            const handle = el("span", { className: "handle", textContent: "⋮⋮", title: "Drag to reprioritise" });
            const check = el("input", { type: "checkbox", checked: !!item.done, title: "Mark done" });
            check.addEventListener("change", () => patch(item.id, { done: check.checked }));

            const body = el("div", { className: "body" });
            const head = el("div", {}, [makeTag(item.category_name), " ", el("span", { className: "muted", textContent: item.topic_name })]);
            if (item.ticket) head.append(makeTicketPill(item.ticket));
            if (item.expected_minutes) head.append(el("span", { className: "est-badge", textContent: fmtMinutes(item.expected_minutes) }));
            body.append(head, el("div", { className: "title-text", textContent: item.title }));
            if (item.notes) body.append(el("div", { className: "notes", textContent: item.notes }));

            const acts = el("div", { className: "acts" });
            const mk = (text, title, fn) => {
                const b = el("button", { className: "small", textContent: text, title });
                b.addEventListener("click", fn);
                return b;
            };
            if (!item.done) acts.append(mk("▶", "Start the timer on this task", () => startItem(item)));
            acts.append(
                mk("✎", "Edit", () => renderForm(body, item)),
                mk("→", `Move to ${fmtDayLabel(nextWorkday(planDate))}`, async () => {
                    await patch(item.id, { plan_date: toLocalDateInputValue(nextWorkday(planDate)) });
                    showToast(`Moved to ${fmtDayLabel(nextWorkday(planDate))}`);
                }),
                mk("✕", "Delete", async () => {
                    if (!confirm("Delete this task?")) return;
                    await api(`/api/plan/${item.id}`, { method: "DELETE" });
                    await load();
                })
            );

            if (!item.done) {
                row.draggable = true;
                row.addEventListener("dragstart", (ev) => {
                    row.classList.add("dragging");
                    ev.dataTransfer.effectAllowed = "move";
                    ev.dataTransfer.setData("text/plain", String(item.id));
                });
                row.addEventListener("dragend", async () => {
                    row.classList.remove("dragging");
                    const ids = [...document.querySelectorAll("#plan-open .plan-item")].map((n) => Number(n.dataset.id));
                    await api("/api/plan/reorder", { method: "POST", body: JSON.stringify({ plan_date: dateStr(), ids }) });
                    await load();
                });
            }
            row.append(handle, check, body, acts);
            return row;
        }

        const openBox = document.getElementById("plan-open");
        openBox.addEventListener("dragover", (ev) => {
            ev.preventDefault();
            const dragging = openBox.querySelector(".dragging");
            if (!dragging) return;
            const others = [...openBox.querySelectorAll(".plan-item:not(.dragging)")];
            const next = others.find((n) => ev.clientY <= n.getBoundingClientRect().top + n.offsetHeight / 2);
            if (next) openBox.insertBefore(dragging, next);
            else openBox.append(dragging);
        });

        document.getElementById("plan-sort-est").addEventListener("click", async () => {
            const open = items.filter((i) => !i.done);
            const sorted = [...open].sort(
                (a, b) => (a.expected_minutes ?? Infinity) - (b.expected_minutes ?? Infinity) || a.sort_order - b.sort_order
            );
            await api("/api/plan/reorder", {
                method: "POST",
                body: JSON.stringify({ plan_date: dateStr(), ids: sorted.map((i) => i.id) }),
            });
            await load();
        });

        async function load() {
            items = await api(`/api/plan?date=${dateStr()}`);
            const isToday = planDate.getTime() === today.getTime();
            document.getElementById("plan-label").textContent = (isToday ? "Today · " : "") + fmtDayLabel(planDate);
            document.getElementById("plan-picker").value = dateStr();

            const open = items.filter((i) => !i.done);
            const done = items.filter((i) => i.done);
            const est = open.reduce((s, i) => s + (i.expected_minutes || 0), 0);
            const noEst = open.filter((i) => !i.expected_minutes).length;
            document.getElementById("plan-summary").textContent =
                `${open.length} open · ${fmtMinutes(est)} estimated` +
                (noEst ? ` (+${noEst} without estimate)` : "") +
                (done.length ? ` · ${done.length} done` : "");

            const openEl = document.getElementById("plan-open");
            const doneEl = document.getElementById("plan-done");
            openEl.innerHTML = "";
            doneEl.innerHTML = "";
            open.forEach((i) => openEl.append(renderItem(i)));
            done.forEach((i) => doneEl.append(renderItem(i)));
            document.getElementById("plan-empty").style.display = open.length ? "none" : "block";
        }

        api("/api/topics").then((t) => {
            topics = t;
            fillTopicSelect();
            load();
        });
    }

    // ---------------- Week page ----------------

    function initWeek() {
        let weekOffset = 0;

        function mondayOf(date) {
            const d = startOfLocalDay(date);
            return addDays(d, -((d.getDay() + 6) % 7));
        }

        function weekRange(offset) {
            const monday = addDays(mondayOf(new Date()), offset * 7);
            return { start: monday, end: addDays(monday, 7) };
        }

        function fmtDate(d) {
            return d.toLocaleDateString([], { month: "short", day: "numeric" });
        }

        async function render() {
            const { start, end } = weekRange(weekOffset);
            const range = `${fmtDate(start)} – ${fmtDate(addDays(end, -1))}`;
            document.getElementById("week-label").textContent = weekOffset === 0 ? `This week (${range})` : range;

            const q = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
            const exportLink = document.getElementById("export-link");
            if (exportLink) exportLink.href = `/api/export?${q}`;
            const entries = await api(`/api/entries?${q}`);

            let total = 0;
            const byCategory = new Map();
            const byTopic = new Map();
            const byDay = new Map();

            for (const e of entries) {
                const secs = entryDurationSeconds(e);
                total += secs;
                byCategory.set(e.category_name, (byCategory.get(e.category_name) || 0) + secs);
                const topicKey = `${e.category_name} / ${e.topic_name}`;
                byTopic.set(topicKey, (byTopic.get(topicKey) || 0) + secs);
                const dayKey = toLocalDateInputValue(new Date(e.start_ts));
                byDay.set(dayKey, (byDay.get(dayKey) || 0) + secs);
            }

            document.getElementById("week-total").textContent = fmtHoursMinutes(total);
            renderBars("by-category", byCategory);
            renderBars("by-topic", byTopic);
            renderDayTable(start, byDay);
        }

        function renderBars(containerId, map) {
            const container = document.getElementById(containerId);
            container.innerHTML = "";
            const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
            if (!rows.length) {
                container.innerHTML = '<div class="empty">Nothing logged.</div>';
                return;
            }
            const max = Math.max(...rows.map(([, v]) => v), 1);
            for (const [name, secs] of rows) {
                const row = document.createElement("div");
                row.className = "row-flex";
                row.style.marginBottom = "8px";
                row.innerHTML = `
                    <div style="width:150px;flex-shrink:0;">${esc(name)}</div>
                    <div class="bar-track"><div class="bar-fill" style="width:${(secs / max) * 100}%"></div></div>
                    <div style="width:70px;text-align:right;flex-shrink:0;">${fmtHoursMinutes(secs)}</div>
                `;
                container.appendChild(row);
            }
        }

        function renderDayTable(monday, byDay) {
            const body = document.getElementById("by-day");
            body.innerHTML = "";
            for (let i = 0; i < 7; i++) {
                const d = addDays(monday, i);
                const key = toLocalDateInputValue(d);
                const tr = document.createElement("tr");
                tr.innerHTML = `<td><a href="/?d=${key}" title="View / edit this day">${esc(fmtDayLabel(d))}</a></td><td class="num">${fmtHoursMinutes(byDay.get(key) || 0)}</td>`;
                body.appendChild(tr);
            }
        }

        document.getElementById("prev-week").addEventListener("click", () => { weekOffset -= 1; render(); });
        document.getElementById("next-week").addEventListener("click", () => { weekOffset += 1; render(); });
        render();
    }

    // ---------------- Topics page ----------------

    function initTopics() {
        async function refreshCategories() {
            const categories = await api("/api/categories");
            const list = document.getElementById("category-list");
            list.innerHTML = "";
            for (const c of categories) {
                const row = document.createElement("div");
                row.className = "row-flex";
                row.style.marginBottom = "6px";

                const input = document.createElement("input");
                input.type = "text";
                input.value = c.name;
                input.style.flex = "1";
                input.addEventListener("change", async () => {
                    await api(`/api/categories/${c.id}`, { method: "PATCH", body: JSON.stringify({ name: input.value }) });
                });

                const delBtn = document.createElement("button");
                delBtn.className = "small";
                delBtn.textContent = "Delete";
                delBtn.addEventListener("click", async () => {
                    if (!confirm(`Delete category "${c.name}"?`)) return;
                    await api(`/api/categories/${c.id}`, { method: "DELETE" });
                    await refreshCategories();
                });

                row.appendChild(input);
                row.appendChild(delBtn);
                list.appendChild(row);
            }

            const select = document.getElementById("new-topic-category");
            select.innerHTML = categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
            return categories;
        }

        async function refreshTopics(categories) {
            const topics = await api("/api/topics?include_archived=1");
            const list = document.getElementById("topic-list");
            list.innerHTML = "";
            for (const t of topics) {
                const row = document.createElement("div");
                row.className = "row-flex";
                row.style.marginBottom = "6px";
                row.style.opacity = t.archived ? "0.5" : "1";

                const input = document.createElement("input");
                input.type = "text";
                input.value = t.name;
                input.style.flex = "1";
                input.addEventListener("change", async () => {
                    await api(`/api/topics/${t.id}`, { method: "PATCH", body: JSON.stringify({ name: input.value }) });
                });

                const catSelect = document.createElement("select");
                catSelect.innerHTML = categories
                    .map((c) => `<option value="${c.id}" ${c.id === t.category_id ? "selected" : ""}>${esc(c.name)}</option>`)
                    .join("");
                catSelect.addEventListener("change", async () => {
                    await api(`/api/topics/${t.id}`, { method: "PATCH", body: JSON.stringify({ category_id: parseInt(catSelect.value, 10) }) });
                });

                const archiveBtn = document.createElement("button");
                archiveBtn.className = "small";
                archiveBtn.textContent = t.archived ? "Unarchive" : "Archive";
                archiveBtn.addEventListener("click", async () => {
                    await api(`/api/topics/${t.id}`, { method: "PATCH", body: JSON.stringify({ archived: !t.archived }) });
                    await refreshTopics(await refreshCategories());
                });

                const delBtn = document.createElement("button");
                delBtn.className = "small";
                delBtn.textContent = "Delete";
                delBtn.addEventListener("click", async () => {
                    if (!confirm(`Delete topic "${t.name}"?`)) return;
                    await api(`/api/topics/${t.id}`, { method: "DELETE" });
                    await refreshTopics(await refreshCategories());
                });

                row.append(input, catSelect, archiveBtn, delBtn);
                list.appendChild(row);
            }
        }

        document.getElementById("new-category-form").addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const input = document.getElementById("new-category-name");
            if (!input.value.trim()) return;
            await api("/api/categories", { method: "POST", body: JSON.stringify({ name: input.value.trim() }) });
            input.value = "";
            await refreshTopics(await refreshCategories());
        });

        document.getElementById("new-topic-form").addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const input = document.getElementById("new-topic-name");
            const select = document.getElementById("new-topic-category");
            if (!input.value.trim() || !select.value) return;
            await api("/api/topics", {
                method: "POST",
                body: JSON.stringify({ name: input.value.trim(), category_id: parseInt(select.value, 10) }),
            });
            input.value = "";
            await refreshTopics(await refreshCategories());
        });

        refreshCategories().then((cats) => refreshTopics(cats));
    }

    // ---------------- Widget page (popup fallback when Document
    // Picture-in-Picture isn't supported by the browser) ----------------

    function initWidget() {
        let status = { active: null, day: null, untracked_since: null };
        const todayStr = localTodayStr();
        const els = clockElements("w-display", "w-topic", "w-stop");

        function render() {
            applyClock(clockView(status, Date.now()), els);
        }

        async function poll() {
            status = await api(`/api/status?date=${todayStr}`);
            render();
        }

        document.getElementById("w-stop").addEventListener("click", async () => {
            await api("/api/stop", { method: "POST" });
            await poll();
        });

        poll();
        setInterval(render, 1000);
        setInterval(poll, 5000);
    }

    return { initToday, initPlan, initWeek, initTopics, initWidget };
})();
