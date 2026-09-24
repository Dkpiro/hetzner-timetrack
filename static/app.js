const TimeTracker = (() => {
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

    function fmtHms(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds));
        const h = String(Math.floor(s / 3600)).padStart(2, "0");
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
        const sec = String(s % 60).padStart(2, "0");
        return `${h}:${m}:${sec}`;
    }

    function fmtHoursMinutes(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `${h}h ${String(m).padStart(2, "0")}m`;
    }

    function fmtLocalTime(iso) {
        return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function entryDurationSeconds(entry) {
        const start = new Date(entry.start_ts).getTime();
        const end = entry.end_ts ? new Date(entry.end_ts).getTime() : Date.now();
        return (end - start) / 1000;
    }

    function toLocalTimeInputValue(iso) {
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    // Combines an HH:MM (local) with the calendar date of referenceIso (also local).
    // Editing across midnight isn't supported — same simplifying assumption as
    // the rest of the app's "today"/"week" date-boundary logic.
    function combineDateAndTime(referenceIso, hhmm) {
        const ref = new Date(referenceIso);
        const [h, m] = hhmm.split(":").map(Number);
        return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, m, 0).toISOString();
    }

    function groupTopicsByCategory(topics) {
        const map = new Map();
        for (const t of topics) {
            if (!map.has(t.category_id)) {
                map.set(t.category_id, { category_name: t.category_name, topics: [] });
            }
            map.get(t.category_id).topics.push(t);
        }
        return [...map.values()];
    }

    // ---------------- Today page ----------------

    const ALERT_THRESHOLD_MINUTES = [15, 30, 45];

    function initToday() {
        let tickHandle = null;
        let activeEntry = null;
        let topicsCache = [];
        const notifiedKeys = new Set();

        function renderStatus() {
            const display = document.getElementById("timer-display");
            const topicLabel = document.getElementById("timer-topic");
            const stopBtn = document.getElementById("stop-btn");
            if (activeEntry) {
                display.classList.remove("idle");
                topicLabel.textContent = `${activeEntry.category_name} / ${activeEntry.topic_name}`;
                stopBtn.style.display = "inline-block";
                display.textContent = fmtHms(entryDurationSeconds(activeEntry));
                checkTimeAlerts(activeEntry);
            } else {
                display.classList.add("idle");
                topicLabel.textContent = "No topic running";
                stopBtn.style.display = "none";
                display.textContent = "00:00:00";
            }
        }

        function startTicking() {
            if (tickHandle) clearInterval(tickHandle);
            tickHandle = setInterval(renderStatus, 1000);
        }

        async function refreshStatus() {
            const data = await api("/api/status");
            activeEntry = data.active;
            renderStatus();
        }

        // ---- Gentle time-on-topic alerts (15/30/45 min, nothing after) ----

        function updateNotifBtnLabel() {
            const btn = document.getElementById("notif-btn");
            if (!btn) return;
            if (!("Notification" in window)) {
                btn.textContent = "🔔 Alerts unsupported";
                btn.disabled = true;
                return;
            }
            if (Notification.permission === "granted") btn.textContent = "🔔 Alerts on";
            else if (Notification.permission === "denied") btn.textContent = "🔕 Alerts blocked";
            else btn.textContent = "🔔 Enable alerts";
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

        document.getElementById("notif-btn")?.addEventListener("click", async () => {
            if (!("Notification" in window)) return;
            if (Notification.permission === "default") {
                await Notification.requestPermission();
            }
            updateNotifBtnLabel();
        });
        updateNotifBtnLabel();

        // ---- Pop-out floating timer (Document Picture-in-Picture where
        // supported, a plain small popup window otherwise) ----

        const widgetContent = document.getElementById("widget-content");
        const widgetHome = widgetContent.parentElement;
        const widgetHomeNext = widgetContent.nextSibling;
        let pipWindow = null;

        document.getElementById("popout-btn")?.addEventListener("click", async () => {
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

        async function refreshTopics() {
            const topics = await api("/api/topics");
            topicsCache = topics;
            const grid = document.getElementById("topic-grid");
            grid.innerHTML = "";
            for (const group of groupTopicsByCategory(topics)) {
                const wrap = document.createElement("div");
                wrap.className = "category-group";
                const label = document.createElement("div");
                label.className = "cat-name";
                label.textContent = group.category_name;
                wrap.appendChild(label);
                const chips = document.createElement("div");
                chips.className = "topic-chips";
                for (const t of group.topics) {
                    const chip = document.createElement("button");
                    chip.className = "topic-chip";
                    chip.textContent = t.name;
                    chip.addEventListener("click", async () => {
                        await api("/api/start", { method: "POST", body: JSON.stringify({ topic_id: t.id }) });
                        await refreshStatus();
                        await refreshEntries();
                    });
                    chips.appendChild(chip);
                }
                wrap.appendChild(chips);
                grid.appendChild(wrap);
            }
        }

        function localDayBoundsIso(offsetDays = 0) {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
            const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
            return { start: start.toISOString(), end: end.toISOString() };
        }

        function renderViewRow(tr, e) {
            tr.innerHTML = "";

            const topicTd = document.createElement("td");
            const catLine = document.createElement("div");
            catLine.className = "muted";
            catLine.style.fontSize = "11px";
            catLine.textContent = e.category_name;
            const topicLine = document.createElement("div");
            topicLine.textContent = e.topic_name;
            topicTd.appendChild(catLine);
            topicTd.appendChild(topicLine);
            tr.appendChild(topicTd);

            const fromTd = document.createElement("td");
            fromTd.textContent = fmtLocalTime(e.start_ts);
            tr.appendChild(fromTd);

            const toTd = document.createElement("td");
            toTd.textContent = e.end_ts ? fmtLocalTime(e.end_ts) : "running";
            tr.appendChild(toTd);

            const durTd = document.createElement("td");
            durTd.className = "num";
            durTd.textContent = fmtHoursMinutes(entryDurationSeconds(e));
            tr.appendChild(durTd);

            const actionTd = document.createElement("td");
            const editBtn = document.createElement("button");
            editBtn.className = "small";
            editBtn.textContent = "Edit";
            editBtn.title = "Adjust topic / start / end time";
            editBtn.addEventListener("click", () => renderEditRow(tr, e));
            actionTd.appendChild(editBtn);

            const delBtn = document.createElement("button");
            delBtn.className = "small";
            delBtn.textContent = "✕";
            delBtn.title = "Delete entry";
            delBtn.addEventListener("click", async () => {
                if (!confirm("Delete this entry?")) return;
                await api(`/api/entries/${e.id}`, { method: "DELETE" });
                await refreshEntries();
                await refreshStatus();
            });
            actionTd.appendChild(delBtn);
            tr.appendChild(actionTd);
        }

        function renderEditRow(tr, e) {
            tr.innerHTML = "";

            const topicTd = document.createElement("td");
            const topicSelect = document.createElement("select");
            let options = topicsCache;
            if (!options.some((t) => t.id === e.topic_id)) {
                options = [...options, { id: e.topic_id, name: e.topic_name, category_name: e.category_name }];
            }
            topicSelect.innerHTML = options
                .map((t) => `<option value="${t.id}" ${t.id === e.topic_id ? "selected" : ""}>${t.category_name} / ${t.name}</option>`)
                .join("");
            topicTd.appendChild(topicSelect);
            tr.appendChild(topicTd);

            const fromTd = document.createElement("td");
            const fromInput = document.createElement("input");
            fromInput.type = "time";
            fromInput.value = toLocalTimeInputValue(e.start_ts);
            fromTd.appendChild(fromInput);
            tr.appendChild(fromTd);

            const toTd = document.createElement("td");
            const toInput = document.createElement("input");
            toInput.type = "time";
            if (e.end_ts) {
                toInput.value = toLocalTimeInputValue(e.end_ts);
            } else {
                toInput.placeholder = "running";
                toInput.title = "Leave blank to keep this entry running; set a time to close it out";
            }
            toTd.appendChild(toInput);
            tr.appendChild(toTd);

            const durTd = document.createElement("td");
            durTd.className = "num muted";
            durTd.textContent = "—";
            tr.appendChild(durTd);

            const actionTd = document.createElement("td");
            const saveBtn = document.createElement("button");
            saveBtn.className = "small primary";
            saveBtn.textContent = "Save";
            saveBtn.addEventListener("click", async () => {
                const payload = {
                    topic_id: parseInt(topicSelect.value, 10),
                    start_ts: combineDateAndTime(e.start_ts, fromInput.value),
                };
                if (toInput.value) {
                    payload.end_ts = combineDateAndTime(e.end_ts || e.start_ts, toInput.value);
                }
                await api(`/api/entries/${e.id}`, { method: "PATCH", body: JSON.stringify(payload) });
                await refreshEntries();
                await refreshStatus();
            });
            actionTd.appendChild(saveBtn);

            const cancelBtn = document.createElement("button");
            cancelBtn.className = "small";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", () => renderViewRow(tr, e));
            actionTd.appendChild(cancelBtn);
            tr.appendChild(actionTd);
        }

        async function refreshEntries() {
            const { start, end } = localDayBoundsIso(0);
            const entries = await api(`/api/entries?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
            const body = document.getElementById("today-body");
            const empty = document.getElementById("today-empty");
            body.innerHTML = "";
            empty.style.display = entries.length ? "none" : "block";
            for (const e of entries) {
                const tr = document.createElement("tr");
                renderViewRow(tr, e);
                body.appendChild(tr);
            }
        }

        document.getElementById("stop-btn").addEventListener("click", async () => {
            await api("/api/stop", { method: "POST" });
            await refreshStatus();
            await refreshEntries();
        });

        refreshTopics();
        refreshStatus();
        refreshEntries();
        startTicking();
        setInterval(refreshEntries, 60000);
    }

    // ---------------- Week page ----------------

    function initWeek() {
        let weekOffset = 0;

        function mondayOf(date) {
            const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const day = (d.getDay() + 6) % 7; // 0 = Monday
            d.setDate(d.getDate() - day);
            return d;
        }

        function weekRange(offset) {
            const monday = mondayOf(new Date());
            monday.setDate(monday.getDate() + offset * 7);
            const nextMonday = new Date(monday);
            nextMonday.setDate(monday.getDate() + 7);
            return { start: monday, end: nextMonday };
        }

        function fmtDate(d) {
            return d.toLocaleDateString([], { month: "short", day: "numeric" });
        }

        async function render() {
            const { start, end } = weekRange(weekOffset);
            document.getElementById("week-label").textContent =
                weekOffset === 0 ? `This week (${fmtDate(start)} – ${fmtDate(new Date(end - 86400000))})`
                                  : `${fmtDate(start)} – ${fmtDate(new Date(end - 86400000))}`;

            const entries = await api(`/api/entries?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);

            let total = 0;
            const byCategory = new Map();
            const byTopic = new Map();
            const byDay = new Map();

            for (const e of entries) {
                const secs = entryDurationSeconds(e);
                total += secs;

                byCategory.set(e.category_name, (byCategory.get(e.category_name) || 0) + secs);
                byTopic.set(e.topic_name, (byTopic.get(e.topic_name) || 0) + secs);

                const dayKey = new Date(e.start_ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
                byDay.set(dayKey, (byDay.get(dayKey) || 0) + secs);
            }

            document.getElementById("week-total").textContent = fmtHoursMinutes(total);
            renderBars("by-category", byCategory, total);
            renderBars("by-topic", byTopic, total);
            renderDayTable(start, byDay);
        }

        function renderBars(containerId, map, total) {
            const container = document.getElementById(containerId);
            container.innerHTML = "";
            const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
            if (!entries.length) {
                container.innerHTML = '<div class="empty">Nothing logged.</div>';
                return;
            }
            const max = Math.max(...entries.map(([, v]) => v), 1);
            for (const [name, secs] of entries) {
                const row = document.createElement("div");
                row.className = "row-flex";
                row.style.marginBottom = "8px";
                row.innerHTML = `
                    <div style="width:110px;flex-shrink:0;">${name}</div>
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
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                const key = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
                const tr = document.createElement("tr");
                tr.innerHTML = `<td>${key}</td><td class="num">${fmtHoursMinutes(byDay.get(key) || 0)}</td>`;
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
            select.innerHTML = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
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
                catSelect.innerHTML = categories.map(c => `<option value="${c.id}" ${c.id === t.category_id ? "selected" : ""}>${c.name}</option>`).join("");
                catSelect.addEventListener("change", async () => {
                    await api(`/api/topics/${t.id}`, { method: "PATCH", body: JSON.stringify({ category_id: parseInt(catSelect.value, 10) }) });
                });

                const archiveBtn = document.createElement("button");
                archiveBtn.className = "small";
                archiveBtn.textContent = t.archived ? "Unarchive" : "Archive";
                archiveBtn.addEventListener("click", async () => {
                    await api(`/api/topics/${t.id}`, { method: "PATCH", body: JSON.stringify({ archived: !t.archived }) });
                    const cats = await refreshCategories();
                    await refreshTopics(cats);
                });

                const delBtn = document.createElement("button");
                delBtn.className = "small";
                delBtn.textContent = "Delete";
                delBtn.addEventListener("click", async () => {
                    if (!confirm(`Delete topic "${t.name}"?`)) return;
                    await api(`/api/topics/${t.id}`, { method: "DELETE" });
                    const cats = await refreshCategories();
                    await refreshTopics(cats);
                });

                row.appendChild(input);
                row.appendChild(catSelect);
                row.appendChild(archiveBtn);
                row.appendChild(delBtn);
                list.appendChild(row);
            }
        }

        document.getElementById("new-category-form").addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const input = document.getElementById("new-category-name");
            if (!input.value.trim()) return;
            await api("/api/categories", { method: "POST", body: JSON.stringify({ name: input.value.trim() }) });
            input.value = "";
            const cats = await refreshCategories();
            await refreshTopics(cats);
        });

        document.getElementById("new-topic-form").addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const input = document.getElementById("new-topic-name");
            const select = document.getElementById("new-topic-category");
            if (!input.value.trim() || !select.value) return;
            await api("/api/topics", { method: "POST", body: JSON.stringify({ name: input.value.trim(), category_id: parseInt(select.value, 10) }) });
            input.value = "";
            const cats = await refreshCategories();
            await refreshTopics(cats);
        });

        refreshCategories().then(cats => refreshTopics(cats));
    }

    // ---------------- Widget page (popup fallback when Document
    // Picture-in-Picture isn't supported by the browser) ----------------

    function initWidget() {
        let activeEntry = null;

        function render() {
            const display = document.getElementById("w-display");
            const topicLabel = document.getElementById("w-topic");
            const stopBtn = document.getElementById("w-stop");
            if (activeEntry) {
                display.classList.remove("idle");
                topicLabel.textContent = `${activeEntry.category_name} / ${activeEntry.topic_name}`;
                display.textContent = fmtHms(entryDurationSeconds(activeEntry));
                stopBtn.style.display = "inline-block";
            } else {
                display.classList.add("idle");
                topicLabel.textContent = "No topic running";
                display.textContent = "00:00:00";
                stopBtn.style.display = "none";
            }
        }

        async function poll() {
            const data = await api("/api/status");
            activeEntry = data.active;
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

    return { initToday, initWeek, initTopics, initWidget };
})();
