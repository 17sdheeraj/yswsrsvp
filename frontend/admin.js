      const API_BASE =
        window.__API_BASE__ || "https://ysws-rsvp-hca.sdheeraj.workers.dev";
      const NO_ACCESS_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const SESSION_TOKEN_STORAGE_KEY = "ysws_session_token";

      function api(path) {
        return `${API_BASE}${path}`;
      }

      function getSessionToken() {
        const token = String(localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) || "").trim();
        if (!token) return "";
        if (!/^[a-f0-9]{32,128}$/i.test(token)) {
          localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
          return "";
        }
        return token;
      }

      function getAuthHeaders() {
        const token = getSessionToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      }

      async function apiFetch(path, init = {}) {
        const baseHeaders = getAuthHeaders();
        const nextHeaders = {
          ...baseHeaders,
          ...(init.headers || {}),
        };
        return fetch(api(path), {
          ...init,
          credentials: "include",
          headers: nextHeaders,
        });
      }

      async function apiGet(path) {
        return apiFetch(path);
      }

      async function readJson(response, fallback) {
        return response.json().catch(() => fallback);
      }

      function formatPercent(value) {
        return `${Number(value || 0).toFixed(1).replace(/\.0$/, "")}%`;
      }

      function formatDateTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Unknown time";
        return date.toLocaleString();
      }

      function getSwalOptions(overrides = {}) {
        return {
          background: "#111827",
          color: "#f8fafc",
          buttonsStyling: false,
          customClass: {
            popup: "hc-swal-popup",
            confirmButton: "swal-confirm-btn",
            cancelButton: "swal-cancel-btn",
          },
          ...overrides,
        };
      }

      async function showPopup({ icon = "info", title = "Notice", text = "" } = {}) {
        if (window.Swal) {
          return window.Swal.fire(getSwalOptions({ icon, title, text, confirmButtonText: "OK" }));
        }

        setStatus("error", text || title);
        return null;
      }

      async function showConfirm({ title, text, confirmButtonText = "Continue", cancelButtonText = "Cancel" }) {
        if (window.Swal) {
          return window.Swal.fire(
            getSwalOptions({
              icon: "question",
              title,
              text,
              showCancelButton: true,
              confirmButtonText,
              cancelButtonText,
              reverseButtons: true,
              focusCancel: true,
            }),
          );
        }

        setStatus("error", text || title || "Confirmation dialog unavailable.");
        return { isConfirmed: false };
      }

      const statusBox = document.getElementById("adminStatus");
      const auditList = document.getElementById("adminAuditList");
      const auditMeta = document.getElementById("adminAuditMeta");
      const errorCodes = document.getElementById("adminErrorCodes");
      const authRate = document.getElementById("adminAuthRate");
      const authMeta = document.getElementById("adminAuthMeta");
      const joinRate = document.getElementById("adminJoinRate");
      const joinMeta = document.getElementById("adminJoinMeta");
      const errorCount = document.getElementById("adminErrorCount");
      const rateLimitMeta = document.getElementById("adminRateLimitMeta");
      const rsvpRateLimitMeta = document.getElementById("adminRsvpRateLimitMeta");
      const retentionNote = document.getElementById("adminRetentionNote");
      const refreshBtn = document.getElementById("refreshAdminBtn");
      const adminPanel = document.getElementById("adminPanel");
      const adminNoAccess = document.getElementById("adminNoAccess");
      const viewAsModal = document.getElementById("viewAsModal");
      const viewAsModalContent = document.getElementById("viewAsModalContent");
      const viewAsModalStatus = document.getElementById("viewAsModalStatus");
      const SOURCE_CODE_URL = "https://github.com/17sdheeraj/yswsrsvp";
      let yswsCatalog = [];
      let viewAsState = null;
      let currentAuditPage = 1;
      const auditPerPage = 5;
      let allAuditEvents = [];

      function renderNoAccess(code = "admin_only") {
        const message =
          "ay! what are you doing here, stop poking around the admin dashboard theres nothing here for you to see. if you want check out the sourcecode";

        adminPanel.style.display = "none";
        adminNoAccess.style.display = "grid";
        adminNoAccess.innerHTML = `
          <img src="https://hackclub.com/404/dinobox.svg" alt="Dino guard" class="admin-no-access-dino" />
          <h2>Nice try sherlock👀</h2>
          <p>${message} <a href="${SOURCE_CODE_URL}" target="_blank" rel="noreferrer">here</a>.</p>
          <div class="admin-no-access-actions">
            <a class="button-link joined" href="./index.html">Back to Home</a>
            <a class="button-link" href="${NO_ACCESS_URL}" target="_blank" rel="noreferrer">Mystery button</a>
          </div>
        `;
      }

      function getErrorCodeLabel(code) {
        const labels = {
          rate_limited: "Slow down! You're making too many requests so you have been ratelimited",
          admin_only: "No VIP for you! This action is only for admins",
          not_authenticated: "Session vanished into thin air, try logging in",
          auth_expired: "Session timed out, it went for a coffee",
          oauth_state_invalid: "Login handshake got scrambled",
          oauth_token_exchange_failed: "Login token machine jammed",
          invalid_payload: "Payload looks a little cursed",
          channel_not_allowed: "Channel is outside the approved list, this aint supposed to happen",
          missing_slack_id: "No Slack ID was provided",
          user_not_found: "Could not find that Slack user",
          invite_failed: "Slack invite API said nope, try again later",
          audit_event_not_found: "That audit log item already disappeared",
        };

        return labels[code] || "Something odd happened";
      }

      function formatApiError(data, fallback = "Request failed.") {
        const code = String(data?.code || data?.error || "").trim();
        if (code) return getErrorCodeLabel(code);
        return String(data?.message || fallback);
      }

      function setStatus(type, msg) {
        statusBox.className = "status";
        if (!msg) {
          statusBox.textContent = "";
          return;
        }
        statusBox.classList.add(type);
        statusBox.textContent = msg;
      }

      function renderErrorCodes(byCode = {}) {
        errorCodes.innerHTML = "";
        const entries = Object.entries(byCode).sort((a, b) => b[1] - a[1]);

        if (!entries.length) {
          const empty = document.createElement("p");
          empty.className = "admin-empty";
          empty.textContent = "No errors yet.";
          errorCodes.appendChild(empty);
          return;
        }

        entries.forEach(([code, count]) => {
          const row = document.createElement("div");
          row.className = "error-code-item";

          const chip = document.createElement("span");
          chip.className = "code-chip";
          chip.textContent = code;

          const value = document.createElement("strong");
          value.textContent = String(count);

          const meta = document.createElement("p");
          meta.className = "audit-meta";
          meta.textContent = getErrorCodeLabel(code);

          row.append(chip, value, meta);
          errorCodes.appendChild(row);
        });
      }

      function renderAudit(events = []) {
        allAuditEvents = events;
        currentAuditPage = 1;
        renderAuditPage();
      }

      function renderAuditPage() {
        const pagination = document.getElementById("auditPagination");
        auditList.innerHTML = "";

        const totalPages = Math.max(1, Math.ceil(allAuditEvents.length / auditPerPage));
        currentAuditPage = Math.min(currentAuditPage, totalPages);

        auditMeta.textContent = `${allAuditEvents.length} total event${allAuditEvents.length === 1 ? "" : "s"}`;

        if (!allAuditEvents.length) {
          const empty = document.createElement("p");
          empty.className = "admin-empty";
          empty.textContent = "Nothing here yet, Its suspiciously quiet.";
          auditList.appendChild(empty);
          pagination.innerHTML = "";
          return;
        }

        const startIdx = (currentAuditPage - 1) * auditPerPage;
        const endIdx = startIdx + auditPerPage;
        const pageEvents = allAuditEvents.slice(startIdx, endIdx);

        pageEvents.forEach((event, idx) => {
          const item = document.createElement("div");
          item.className = "audit-item";

          const contentWrapper = document.createElement("div");
          contentWrapper.style.flex = "1";

          const head = document.createElement("div");
          head.className = "audit-item-head";

          const type = document.createElement("span");
          type.className = "audit-type";
          type.textContent = String(event.type || "event").replace(/_/g, " ");

          const outcome = document.createElement("span");
          outcome.className = `audit-outcome ${event.outcome === "success" ? "success" : "failure"}`;
          outcome.textContent = event.outcome || "unknown";

          head.append(type, outcome);

          const meta = document.createElement("p");
          meta.className = "audit-meta";
          meta.textContent = formatDateTime(event.timestamp);

          const details = document.createElement("p");
          details.className = "audit-details";
          details.textContent = [
            event.code ? `code: ${event.code}` : "",
            event.channel ? `channel: ${event.channel}` : "",
            event.slackId ? `slack: ${event.slackId}` : "",
            event.result ? `result: ${event.result}` : "",
            event.status ? `status: ${event.status}` : "",
            event.details ? `details: ${event.details}` : "",
          ]
            .filter(Boolean)
            .join(" | ");

          contentWrapper.append(head, meta);
          if (details.textContent) contentWrapper.appendChild(details);

          const deleteBtn = document.createElement("button");
          deleteBtn.className = "audit-item-delete";
          deleteBtn.textContent = "Delete";
          deleteBtn.addEventListener("click", async () => {
            deleteBtn.disabled = true;
            deleteBtn.textContent = "Deleting...";

            const deleted = await deleteAuditEvent(event.id);
            if (!deleted) {
              deleteBtn.disabled = false;
              deleteBtn.textContent = "Delete";
              return;
            }

            const eventIndex = startIdx + idx;
            allAuditEvents.splice(eventIndex, 1);
            renderAuditPage();
          });

          item.append(contentWrapper, deleteBtn);
          auditList.appendChild(item);
        });

        pagination.innerHTML = "";
        if (totalPages > 1) {
          const prevBtn = document.createElement("button");
          prevBtn.textContent = "← Prev";
          prevBtn.disabled = currentAuditPage === 1;
          prevBtn.addEventListener("click", () => {
            if (currentAuditPage > 1) {
              currentAuditPage--;
              renderAuditPage();
            }
          });
          pagination.appendChild(prevBtn);

          for (let i = 1; i <= totalPages; i++) {
            const pageBtn = document.createElement("button");
            pageBtn.textContent = String(i);
            pageBtn.className = i === currentAuditPage ? "active" : "";
            pageBtn.addEventListener("click", () => {
              currentAuditPage = i;
              renderAuditPage();
            });
            pagination.appendChild(pageBtn);
          }

          const nextBtn = document.createElement("button");
          nextBtn.textContent = "Next →";
          nextBtn.disabled = currentAuditPage === totalPages;
          nextBtn.addEventListener("click", () => {
            if (currentAuditPage < totalPages) {
              currentAuditPage++;
              renderAuditPage();
            }
          });
          pagination.appendChild(nextBtn);
        }
      }

      async function loadData() {
        setStatus("", "");
        refreshBtn.disabled = true;

        try {
          const [metricsRes, auditRes] = await Promise.all([
            apiGet("/api/admin/metrics"),
            apiGet("/api/admin/audit?limit=100"),
          ]);

          const metricsData = await readJson(metricsRes, { ok: false });
          const auditData = await readJson(auditRes, { ok: false });

          if (!metricsRes.ok || !metricsData.ok) {
            throw new Error(metricsData.message || "Couldn't load metrics right now.");
          }

          if (!auditRes.ok || !auditData.ok) {
            throw new Error(auditData.message || "Couldn't load the audit log right now.");
          }

          const m = metricsData.metrics || {};
          authRate.textContent = formatPercent(m.auth?.successRate);
          authMeta.textContent = `${m.auth?.success || 0} logins out of ${m.auth?.attempts || 0}`;
          joinRate.textContent = formatPercent(m.join?.successRate);
          joinMeta.textContent = `${m.join?.success || 0} successful joins out of ${m.join?.attempts || 0}`;
          errorCount.textContent = String(m.errors?.total || 0);

          const windowMin = Math.round(Number(m.join?.rateLimit?.windowMs || 0) / 60000);
          const maxReq = Number(m.join?.rateLimit?.maxRequests || 0);
          const rsvpWindowMin = Math.round(Number(m.rsvp?.rateLimit?.windowMs || 0) / 60000);
          const rsvpMaxReq = Number(m.rsvp?.rateLimit?.maxRequests || 0);
          rateLimitMeta.textContent = maxReq
            ? `${maxReq} join requests per IP every ${windowMin} min`
            : "Join rate limit disabled";
          rsvpRateLimitMeta.textContent = rsvpMaxReq
            ? `${rsvpMaxReq} RSVP updates per IP every ${rsvpWindowMin} min`
            : "RSVP rate limit disabled";
          retentionNote.textContent = `Audit logs are retained for ${auditData.retentionDays || m.audit?.retentionDays || 14} days.`;

          renderErrorCodes(m.errors?.byCode || {});
          renderAudit(auditData.events || []);
        } catch (err) {
          setStatus("error", err.message || "Dashboard had a tiny wobble. Try again.");
        } finally {
          refreshBtn.disabled = false;
        }
      }

      async function clearAuditLog() {
        const confirm = await showConfirm({
          title: "Clear audit log?",
          text: "This deletes all current entries.",
          confirmButtonText: "Yes, clear it",
          cancelButtonText: "Cancel",
        });
        if (!confirm?.isConfirmed) return;

        const clearBtn = document.getElementById("clearAuditBtn");
        clearBtn.disabled = true;
        setStatus("", "");

        try {
          const response = await apiFetch("/api/admin/audit", {
            method: "DELETE",
          });
          const data = await readJson(response, { ok: false });

          if (!response.ok || !data.ok) {
            throw new Error(formatApiError(data, "Couldn't clear the audit log."));
          }

          setStatus("success", `Cleared ${data.clearedCount || 0} audit event${data.clearedCount === 1 ? "" : "s"}.`);
          await loadData();
        } catch (err) {
          setStatus("error", err.message || "Couldn't clear the audit log right now.");
        } finally {
          clearBtn.disabled = false;
        }
      }

      async function deleteAuditEvent(eventId) {
        if (!eventId) return false;

        setStatus("", "");

        try {
          const response = await apiFetch(`/api/admin/audit?id=${encodeURIComponent(eventId)}`, {
            method: "DELETE",
          });
          const data = await readJson(response, { ok: false });

          if (!response.ok || !data.ok) {
            throw new Error(formatApiError(data, "Couldn't delete that audit event."));
          }

          setStatus("success", "Deleted audit event.");
          return true;
        } catch (err) {
          setStatus("error", err.message || "Couldn't delete that audit event right now.");
          return false;
        }
      }

      async function clearErrorsByCode() {
        const confirm = await showConfirm({
          title: "Clear all errors?",
          text: "This will reset the error code statistics.",
          confirmButtonText: "Yes, clear them",
          cancelButtonText: "Cancel",
        });
        if (!confirm?.isConfirmed) return;

        const clearErrorsBtn = document.getElementById("clearErrorsBtn");
        clearErrorsBtn.disabled = true;
        setStatus("", "");

        try {
          const response = await apiFetch("/api/admin/errors", {
            method: "DELETE",
          });
          const data = await readJson(response, { ok: false });

          if (!response.ok || !data.ok) {
            throw new Error(formatApiError(data, "Couldn't clear errors."));
          }

          setStatus("success", "Cleared all error statistics.");
          await loadData();
        } catch (err) {
          setStatus("error", err.message || "Couldn't clear errors right now.");
        } finally {
          clearErrorsBtn.disabled = false;
        }
      }

      async function viewAs() {
        const input = document.getElementById("viewAsSlackIdInput");
        const btn = document.getElementById("viewAsBtn");
        const slackId = input.value.trim().toUpperCase();

        if (!slackId) {
          await showPopup({
            icon: "warning",
            title: "Slack ID needed",
            text: "Enter a Slack ID first.",
          });
          return;
        }

        btn.disabled = true;
        viewAsModal.style.display = "flex";
        viewAsModalContent.innerHTML = `<p style="color:var(--hc-muted); text-align:center;">Loading…</p>`;
        viewAsModalStatus.textContent = "";

        try {
          const response = await apiGet(`/api/admin/view-as?slackId=${encodeURIComponent(slackId)}`);
          const data = await readJson(response, { ok: false });

          if (!data.ok) {
            viewAsModalContent.innerHTML = `<p class="result-err">Failed: ${formatApiError(data, "Request failed.")}</p>`;
            return;
          }

          if (!yswsCatalog.length) {
            await loadYswsCatalog();
          }
          viewAsState = {
            ...data,
            membership: { ...(data.membership || {}) },
            rsvpDone: { ...(data.rsvpDone || {}) },
          };
          renderViewAsDashboard();
        } catch (_err) {
          viewAsModalContent.innerHTML = `<p class="result-err">Request failed.</p>`;
        } finally {
          btn.disabled = false;
        }
      }

      function renderViewAsDashboard(actionMessage = "") {
        if (!viewAsState) {
          viewAsModalContent.innerHTML = `<p class="result-err">No user selected.</p>`;
          return;
        }

        const data = viewAsState;
        const rows = (yswsCatalog.length
          ? yswsCatalog
          : Object.keys(data.membership || {}).map((channel) => ({
              name: channel,
              channel,
              form: "",
            })))
          .map((item) => ({
            ...item,
            joined: !!data.membership?.[item.channel],
            rsvpDone: !!data.rsvpDone?.[item.channel],
          }))
          .sort((a, b) => Number(a.joined) - Number(b.joined) || a.name.localeCompare(b.name));

        const joinedCount = rows.filter((item) => item.joined).length;
        const completedCount = rows.filter((item) => item.joined && item.rsvpDone).length;
        const totalCount = rows.length;
        const remainingCount = Math.max(0, totalCount - completedCount);
        const completionPercent = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;
        const verificationLabel = data.verificationLabel || "Unknown";
        const verificationStatus = data.verificationStatus || "Unavailable";
        const eligibilityLabel =
          data.yswsEligible === true
            ? "Eligible"
            : data.yswsEligible === false
              ? "Not eligible"
              : "Unknown";

        const cardsHtml = rows.length
          ? rows
              .map(
                (item) => `
                  <div class="card view-as-card${item.joined && item.rsvpDone ? " card-complete" : item.joined || item.rsvpDone ? " card-partial" : ""}">
                    <div class="card-head">
                      <div class="card-title-group">
                        <h3>${item.name}</h3>
                        <span class="channel-id">${item.channel}</span>
                      </div>
                      <button
                        type="button"
                        class="rsvp-toggle view-as-rsvp-btn ${item.rsvpDone ? "is-checked" : ""}"
                        data-channel="${item.channel}"
                        data-name="${item.name}"
                        data-done="${item.rsvpDone ? "false" : "true"}"
                        aria-label="${item.rsvpDone ? `Unmark RSVP done for ${item.name}` : `Mark RSVP done for ${item.name}` }"
                        title="${item.rsvpDone ? "Undo RSVP done" : "Mark RSVP done"}"
                      ></button>
                    </div>
                    <div class="actions">
                      ${
                        item.joined
                          ? '<button class="joined" disabled>Joined</button>'
                          : `<button class="view-as-join-btn" data-channel="${item.channel}" data-name="${item.name}">Add user to channel</button>`
                      }
                      <button ${item.form ? `onclick="window.open('${item.form}', '_blank')"` : "disabled"}>Fill RSVP</button>
                      <button class="joined" disabled>Description</button>
                    </div>
                  </div>
                `,
              )
              .join("")
          : '<div class="card view-as-card"><h3>No programs found</h3><p class="muted">Could not load channel catalog.</p></div>';

        viewAsModalContent.innerHTML = `
          <div class="view-as-shell">
            <div class="view-as-head">
              <div class="user">
                <img class="avatar" src="${data.avatar || "https://user-cdn.hackclub-assets.com/019cf11f-eade-7304-ab15-71833ccc4c32/icon-rounded.svg"}" alt="avatar" />
                <div class="user-meta">
                  <h3>Viewing as ${data.name || data.username || data.slackId || "user"}</h3>
                  <div class="slack-id-row">
                    <span class="slack-id-text">Slack ID: <strong>${data.slackId || "—"}</strong></span>
                    <span class="slack-id-text">Username: <strong>${data.username ? `@${data.username}` : "—"}</strong></span>
                    <span class="slack-id-text">Email: <strong>${data.email || "—"}</strong></span>
                  </div>
                  <div class="verification-row">
                    <span class="verification-pill ${data.isVerified === true ? "verified" : data.isVerified === false ? "not-verified" : "unknown"}">Verification: ${verificationLabel}</span>
                    <span class="verification-detail">Status: ${verificationStatus}</span>
                    <span class="verification-detail">YSWS eligibility: ${eligibilityLabel}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="stats-grid view-as-stats">
              <div class="stat">
                <p class="stat-label">Joined channels</p>
                <p class="stat-value">${joinedCount}</p>
              </div>
              <div class="stat">
                <p class="stat-label">Remaining</p>
                <p class="stat-value">${remainingCount}</p>
              </div>
              <div class="stat">
                <p class="stat-label">Total YSWSes</p>
                <p class="stat-value">${totalCount}</p>
              </div>
            </div>
            <div class="progress-wrap" style="margin-top: 10px">
              <p class="stat-label" style="margin: 0">Completion</p>
              <p class="progress-meta">${completedCount} of ${totalCount} fully complete (${completionPercent}%)</p>
              <div class="progress-bar">
                <div class="progress-fill" style="width:${completionPercent}%"></div>
              </div>
            </div>
            <div class="grid view-as-grid">${cardsHtml}</div>
          </div>
        `;

        if (actionMessage) {
          viewAsModalStatus.textContent = actionMessage;
          viewAsModalStatus.className = /Added|Marked|Removed|already in/i.test(actionMessage)
            ? "status success"
            : "status";
        }

        viewAsModalContent.querySelectorAll(".view-as-join-btn").forEach((button) => {
          button.addEventListener("click", () => {
            const channel = button.getAttribute("data-channel");
            const channelName = button.getAttribute("data-name");
            showPermissionPrompt({
              question: `Did this user (${data.slackId}) give you permission to add them to ${channelName}?`,
              loadingText: "Joining...",
              selector: `.view-as-join-btn[data-channel="${channel}"]`,
              onConfirm: async () => {
                const response = await apiFetch("/api/admin/test-join", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ slackId: data.slackId, channel }),
                });
                const joinData = await readJson(response, { ok: false });

                if (!joinData.ok) {
                  return `Could not add ${data.slackId} to ${channelName}: ${formatApiError(joinData, "failed")}`;
                }

                viewAsState.membership[channel] = true;
                return joinData.result === "already_in_channel"
                  ? `${data.slackId} is already in ${channelName}.`
                  : `Added ${data.slackId} to ${channelName}. ✓`;
              },
            });
          });
        });

        viewAsModalContent.querySelectorAll(".view-as-rsvp-btn").forEach((button) => {
          button.addEventListener("click", () => {
            const channel = button.getAttribute("data-channel");
            const channelName = button.getAttribute("data-name");
            const done = button.getAttribute("data-done") === "true";
            showPermissionPrompt({
              question: done
                ? `Did this user (${data.slackId}) ask you to mark the ${channelName} RSVP as done?`
                : `Did this user (${data.slackId}) ask you to undo the ${channelName} RSVP done mark?`,
              loadingText: done ? "Saving..." : "Undoing...",
              selector: `.view-as-rsvp-btn[data-channel="${channel}"]`,
              onConfirm: async () => {
                const response = await apiFetch("/api/admin/test-rsvp", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ slackId: data.slackId, channel, done }),
                });
                const rsvpData = await readJson(response, { ok: false });

                if (!rsvpData.ok) {
                  return `Could not ${done ? "mark" : "undo"} ${channelName}: ${formatApiError(rsvpData, "failed")}`;
                }

                viewAsState.rsvpDone = { ...(viewAsState.rsvpDone || {}), ...(rsvpData.rsvpDone || {}), [channel]: done };
                return done
                  ? `Marked ${channelName} RSVP as done for ${data.slackId}.`
                  : `Removed the RSVP done mark for ${channelName}.`;
              },
            });
          });
        });
      }

      function showPermissionPrompt({ question, selector, loadingText, onConfirm }) {
        (async () => {
          const result = await showConfirm({
            title: "Permission check",
            text: question,
            confirmButtonText: "Yes, proceed",
            cancelButtonText: "No, cancel",
          });
          if (!result?.isConfirmed) return;

          const button = selector ? viewAsModalContent.querySelector(selector) : null;
          if (button) {
            button.disabled = true;
            if (button.classList.contains("rsvp-toggle")) {
              button.classList.add("is-loading");
            } else {
              button.textContent = loadingText || "Working...";
            }
          }

          let message = "";
          try {
            message = await onConfirm();
          } catch (_err) {
            message = "Request failed while updating that user.";
          }

          renderViewAsDashboard(message);
        })();
      }

      async function lookupUser() {
        const input = document.getElementById("lookupSlackIdInput");
        const resultBox = document.getElementById("lookupResult");
        const btn = document.getElementById("lookupBtn");
        const slackId = input.value.trim().toUpperCase();

        if (!slackId) {
          resultBox.innerHTML = `<span class="result-err">Enter a Slack ID first.</span>`;
          return;
        }

        btn.disabled = true;
        resultBox.innerHTML = `<span style="color:var(--hc-muted)">Loading…</span>`;

        try {
          const response = await apiGet(`/api/admin/lookup?slackId=${encodeURIComponent(slackId)}`);
          const data = await readJson(response, { ok: false });

          if (!data.ok) {
            resultBox.innerHTML = `<span class="result-err">${formatApiError(data, "Lookup failed.")}</span>`;
            return;
          }

          const rows = [
            ["Name", data.name || "—"],
            ["Username", data.username ? `@${data.username}` : "—"],
            ["Slack ID", data.slackId || "—"],
          ];

          const rowsHtml = rows
            .map(([label, value]) =>
              `<div class="result-row"><span class="result-label">${label}</span><span class="result-value">${value}</span></div>`,
            )
            .join("");

          const chips = Object.entries(data.membership || {})
            .map(
              ([channel, inChannel]) =>
                `<span class="membership-chip ${inChannel ? "in" : "out"}">${inChannel ? "✓" : "○"} ${channel}</span>`,
            )
            .join("");

          resultBox.innerHTML = rowsHtml + (chips ? `<div class="membership-grid">${chips}</div>` : "");
        } catch (_err) {
          resultBox.innerHTML = `<span class="result-err">Request failed.</span>`;
        } finally {
          btn.disabled = false;
        }
      }

      async function loadYswsCatalog() {
        const response = await apiGet("/ysws.json").catch(() => null);
        if (!response || !response.ok) {
          yswsCatalog = [];
          return;
        }

        const list = await response.json().catch(() => []);
        yswsCatalog = list
          .filter((item) => item?.name && item?.channel)
          .map((item) => ({
            name: String(item.name),
            channel: String(item.channel).toUpperCase(),
            form: String(item.form || ""),
          }));
      }

      async function populateChannelSelect() {
        const select = document.getElementById("testJoinChannelSelect");
        select.innerHTML = "";
        if (!yswsCatalog.length) {
          await loadYswsCatalog();
        }

        yswsCatalog
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((item) => {
          if (!item.channel) return;
          const opt = document.createElement("option");
          opt.value = item.channel;
          opt.textContent = `${item.name} — ${item.channel}`;
          select.appendChild(opt);
          });
      }

      function selectAllChannels() {
        const select = document.getElementById("testJoinChannelSelect");
        for (const option of select.options) option.selected = true;
      }

      function clearSelectedChannels() {
        const select = document.getElementById("testJoinChannelSelect");
        for (const option of select.options) option.selected = false;
      }

      async function testJoin() {
        const slackIdInput = document.getElementById("testJoinSlackIdInput");
        const channelSelect = document.getElementById("testJoinChannelSelect");
        const resultBox = document.getElementById("testJoinResult");
        const btn = document.getElementById("testJoinBtn");
        const slackId = slackIdInput.value.trim().toUpperCase();
        const channels = Array.from(channelSelect.selectedOptions).map((o) => o.value);

        if (!slackId) {
          resultBox.innerHTML = `<span class="result-err">Enter a Slack ID.</span>`;
          return;
        }
        if (!channels.length) {
          resultBox.innerHTML = `<span class="result-err">Select at least one channel.</span>`;
          return;
        }

        btn.disabled = true;
        resultBox.innerHTML = `<span style="color:var(--hc-muted)">Working…</span>`;

        const results = [];
        for (const channel of channels) {
          try {
            const response = await apiFetch("/api/admin/test-join", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ slackId, channel }),
            });
            const data = await readJson(response, { ok: false });
            results.push({
              channel,
              ok: data.ok,
              result: data.result,
              message: data.ok ? data.message : formatApiError(data, "Failed"),
            });
          } catch (_err) {
            results.push({ channel, ok: false, message: "Request failed." });
          }
        }

        resultBox.innerHTML = results
          .map((r) =>
            r.ok
              ? `<div class="result-row"><span class="result-label">${r.channel}</span><span class="result-ok">✓ ${r.result === "already_in_channel" ? "Already in" : "Added"}</span></div>`
              : `<div class="result-row"><span class="result-label">${r.channel}</span><span class="result-err">✗ ${r.message || "Failed"}</span></div>`,
          )
          .join("");

        const successCount = results.filter((r) => r.ok).length;
        const totalCount = results.length;
        resultBox.innerHTML = `<div class="result-row"><span class="result-label">Summary</span><span class="result-value">${successCount}/${totalCount} channel updates succeeded</span></div>` + resultBox.innerHTML;

        await loadData();
        btn.disabled = false;
      }

      async function boot() {
        const accessRes = await apiGet("/api/admin/access").catch(() => null);
        if (!accessRes || !accessRes.ok) {
          renderNoAccess("not_authenticated");
          return;
        }
        const data = await readJson(accessRes, { ok: false });
        if (!data.ok) {
          renderNoAccess(data.code || "admin_only");
          return;
        }

        adminPanel.style.display = "grid";
        adminNoAccess.style.display = "none";

        refreshBtn.addEventListener("click", loadData);
        document.getElementById("clearAuditBtn").addEventListener("click", clearAuditLog);
        document.getElementById("clearErrorsBtn").addEventListener("click", clearErrorsByCode);

        document.getElementById("closeViewAsBtn").addEventListener("click", () => {
          viewAsModal.style.display = "none";
          viewAsModalStatus.textContent = "";
        });

        document.getElementById("viewAsBtn").addEventListener("click", viewAs);
        document.getElementById("viewAsSlackIdInput").addEventListener("keydown", (e) => {
          if (e.key === "Enter") viewAs();
        });

        document.getElementById("lookupBtn").addEventListener("click", lookupUser);
        document.getElementById("lookupSlackIdInput").addEventListener("keydown", (e) => {
          if (e.key === "Enter") lookupUser();
        });

        document.getElementById("testJoinBtn").addEventListener("click", testJoin);
        document.getElementById("selectAllChannelsBtn").addEventListener("click", selectAllChannels);
        document.getElementById("clearChannelsBtn").addEventListener("click", clearSelectedChannels);

        await loadYswsCatalog();
        await populateChannelSelect();
        await loadData();
      }

      boot();
