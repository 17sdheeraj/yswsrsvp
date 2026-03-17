      const API_BASE =
        window.__API_BASE__ || "https://ysws-rsvp-hca.sdheeraj.workers.dev";
      const ADMIN_SLACK_ID = "U0828RTU7FE";
      const DEFAULT_AVATAR =
        "https://user-cdn.hackclub-assets.com/019cf11f-eade-7304-ab15-71833ccc4c32/icon-rounded.svg";
      const MEMBERSHIP_LOAD_ERROR =
        "Couldn't load your memberships right now. Slack might be on a coffee break, try again in a bit.";

      let yswsList = [];
      let latestMembership = {};
      let latestRsvpDone = {};
      let currentFilter = "all";
      let currentSearchQuery = "";
      let currentSlackId = "";
      let currentUsername = "";
      let currentEmail = "";
      let isAdminUser = false;

      const statusBox = document.getElementById("statusBox");
      const supportBox = document.getElementById("supportBox");
      const supportMessage = document.getElementById("supportMessage");
      const usernameCopyBtn = document.getElementById("usernameCopyBtn");
      const emailCopyBtn = document.getElementById("emailCopyBtn");
      const yswsModal = document.getElementById("programModal");
      const yswsModalTitle = document.getElementById("programModalTitle");
      const yswsModalDesc = document.getElementById("programModalDesc");
      const yswsWebsiteBtn = document.getElementById("programWebsiteBtn");
      const adminLink = document.getElementById("adminLink");

      function api(path) {
        return `${API_BASE}${path}`;
      }

      async function apiGet(path) {
        return fetch(api(path), { credentials: "include" });
      }

      async function apiPost(path, body) {
        return fetch(api(path), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
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

      async function showRateLimitPopup(actionLabel, resetAtMs) {
        const waitText = getRateLimitWaitText(resetAtMs);
        await showPopup({
          icon: "warning",
          title: "Rate limited",
          text: `Too many ${actionLabel}. Try again in ${waitText}.`,
        });
      }

      function normalizeExternalUrl(value) {
        const url = String(value || "").trim();
        if (!url) return "";
        return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
      }

      function setView(view) {
        const loading = document.getElementById("loading");
        const step1 = document.getElementById("step1");
        const step2 = document.getElementById("step2");

        loading.style.display = view === "loading" ? "block" : "none";
        step1.style.display = view === "auth" ? "block" : "none";
        step2.style.display = view === "app" ? "block" : "none";
      }

      function setStats(joined, completed, total) {
        const remaining = Math.max(0, total - completed);
        const percent = total ? Math.round((completed / total) * 100) : 0;

        document.getElementById("joinedCount").textContent = String(joined);
        document.getElementById("remainingCount").textContent = String(remaining);
        document.getElementById("totalCount").textContent = String(total);
        document.getElementById("progressFill").style.width = `${percent}%`;
        document.getElementById("completionMeta").textContent = `${completed} of ${total} fully complete (${percent}%)`;
      }

      async function readJson(response, fallback) {
        return response.json().catch(() => fallback);
      }

      function getRateLimitWaitText(resetAtMs) {
        if (!resetAtMs) return "a few minutes";
        const remainingMs = Math.max(0, resetAtMs - Date.now());
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        if (mins > 0) return `${mins}m ${secs}s`;
        return `${secs}s`;
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

      function setSupportMessage(message = "") {
        supportMessage.value = message;
        supportBox.classList.toggle("show", !!message);
      }

      async function copySupportMessage() {
        const text = supportMessage.value.trim();
        if (!text) return;

        try {
          await navigator.clipboard.writeText(text);
          setStatus("success", "Copied! Paste it to Dheeraj S and we can debug this quickly.");
        } catch (_error) {
          supportMessage.focus();
          supportMessage.select();
          setStatus("error", "Auto-copy tripped. Select the text and copy it manually.");
        }
      }

      async function copyValue(text, successMessage) {
        const value = (text || "").trim();

        if (!value) {
          setStatus("error", "Value is not available yet.");
          return;
        }

        try {
          await navigator.clipboard.writeText(value);
          setStatus("success", successMessage);
        } catch (_error) {
          setStatus("error", "Clipboard said nope — please copy manually.");
        }
      }

      async function copySlackId() {
        await copyValue(currentSlackId, "Slack ID copied.");
      }

      async function copyUsername() {
        await copyValue(currentUsername, "Slack username copied.");
      }

      async function copyEmail() {
        await copyValue(currentEmail, "Email copied.");
      }

      async function detectAdminAccess() {
        try {
          const response = await apiGet("/api/admin/access");
          if (!response.ok) return false;
          const data = await readJson(response, { ok: false });
          return !!data.ok;
        } catch (_error) {
          return false;
        }
      }

      async function loadYswsList() {
        if (yswsList.length) return true;

        try {
          const response = await apiGet("/ysws.json");
          if (!response.ok) throw new Error("catalog_failed");

          const list = await response.json();
          if (!Array.isArray(list)) throw new Error("invalid_ysws_list");

          yswsList = list
            .filter((item) => item?.name && item?.form && item?.channel)
            .map((item) => ({
              name: String(item.name),
              form: normalizeExternalUrl(item.form),
              channel: String(item.channel),
              description: String(item.description || "No description added yet."),
              website: normalizeExternalUrl(item.website),
            }));

          return true;
        } catch (_error) {
          setStatus("error", "Couldn't load the YSWS list. Give it a refresh and we'll try again.");
          return false;
        }
      }

      function openYswsModal(channel) {
        const ysws = yswsList.find((entry) => entry.channel === channel);
        if (!ysws) return;

        yswsModalTitle.textContent = ysws.name;
        yswsModalDesc.textContent = ysws.description || "No description added yet.";

        if (ysws.website) {
          yswsWebsiteBtn.style.display = "inline-flex";
          yswsWebsiteBtn.onclick = () => window.open(ysws.website, "_blank");
        } else {
          yswsWebsiteBtn.style.display = "none";
          yswsWebsiteBtn.onclick = null;
        }

        yswsModal.classList.add("show");
      }

      function closeYswsModal(event) {
        if (event && event.target !== yswsModal) return;
        yswsModal.classList.remove("show");
      }

      function getQueryParam(name) {
        return new URLSearchParams(window.location.search).get(name) || "";
      }

      function clearOauthErrorFromUrl() {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete("oauth_error");
        window.history.replaceState({}, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
      }

      function showLoggedOut(message = "") {
        setView("auth");
        document.getElementById("programs").innerHTML = "";

        latestMembership = {};
        latestRsvpDone = {};
        currentSlackId = "";
        currentUsername = "";
        currentEmail = "";

        document.getElementById("hello").textContent = "";
        document.getElementById("avatar").removeAttribute("src");
        document.getElementById("slackIdText").textContent = "—";
        document.getElementById("usernameText").textContent = "—";
        document.getElementById("emailText").textContent = "—";
        updateVerificationUi({
          isVerified: null,
          verificationLabel: "Verification unknown",
          verificationStatus: "",
          yswsEligible: null,
        });
        usernameCopyBtn.style.display = "none";
        emailCopyBtn.style.display = "none";
        adminLink.style.display = "none";

        const searchInput = document.getElementById("searchYsws");
        if (searchInput) searchInput.value = "";
        currentSearchQuery = "";

        setStats(0, 0, 0);
        setFilter("all");
        setStatus(message ? "error" : "", message);
      }

      async function loadDashboard() {
        setView("loading");
        setStatus("", "");

        const yswsReady = await loadYswsList();
        if (!yswsReady) {
          showLoggedOut("Could not load the YSWS list. Please refresh and try again.");
          return;
        }

        let userResponse;
        try {
          userResponse = await apiGet("/api/user");
        } catch (_error) {
          showLoggedOut(MEMBERSHIP_LOAD_ERROR);
          return;
        }

        if (!userResponse.ok) {
          showLoggedOut(
            userResponse.status === 401 || userResponse.status === 403
              ? ""
              : MEMBERSHIP_LOAD_ERROR,
          );
          return;
        }

        const user = await readJson(userResponse, { ok: false });
        if (!user.ok) {
          showLoggedOut(user.error === "not_authenticated" ? "" : MEMBERSHIP_LOAD_ERROR);
          return;
        }

        setView("app");
        setSupportMessage("");

        document.getElementById("hello").textContent = `Hi ${user.name || "there"}!`;
        document.getElementById("avatar").src = user.avatar || DEFAULT_AVATAR;

        currentSlackId = String(user.slackId || "").trim().toUpperCase();
        currentUsername = String(user.username || "").trim();
        currentEmail = String(user.email || "").trim();
        isAdminUser = currentSlackId === ADMIN_SLACK_ID;

        document.getElementById("slackIdText").textContent = currentSlackId || "—";
        document.getElementById("usernameText").textContent = currentUsername || "—";
        document.getElementById("emailText").textContent = currentEmail || "—";
        usernameCopyBtn.style.display = currentUsername ? "inline-flex" : "none";
        emailCopyBtn.style.display = currentEmail ? "inline-flex" : "none";
        updateVerificationUi(user);

        latestMembership = user.membership || {};
        latestRsvpDone = user.rsvpDone || {};

        if (!isAdminUser) {
          isAdminUser = await detectAdminAccess();
        }
        adminLink.style.display = isAdminUser ? "inline-flex" : "none";

        renderYsws();
      }

      function updateVerificationUi(user) {
        const badge = document.getElementById("verificationBadge");
        const detail = document.getElementById("verificationDetail");
        const eligibility = document.getElementById("eligibilityDetail");
        const isVerified = typeof user?.isVerified === "boolean" ? user.isVerified : null;
        const yswsEligible = typeof user?.yswsEligible === "boolean" ? user.yswsEligible : null;
        const label = String(user?.verificationLabel || "Verification unknown").trim();
        const rawStatus = String(user?.verificationStatus || "").trim().replace(/[_-]+/g, " ");

        badge.className = `verification-pill ${
          isVerified === true ? "verified" : isVerified === false ? "not-verified" : "unknown"
        }`;
        badge.textContent = `Verification: ${label}`;
        detail.textContent = rawStatus ? `Status: ${rawStatus}` : "Status: unavailable";
        eligibility.textContent =
          yswsEligible === true
            ? "YSWS eligibility: eligible"
            : yswsEligible === false
              ? "YSWS eligibility: not eligible"
              : "YSWS eligibility: unknown";
      }

      function setFilter(nextFilter) {
        currentFilter = nextFilter;

        document.getElementById("filterAll").classList.toggle("active", nextFilter === "all");
        document.getElementById("filterTodo").classList.toggle("active", nextFilter === "todo");
        document.getElementById("filterJoined").classList.toggle("active", nextFilter === "joined");

        renderYsws();
      }

      function setSearch(value) {
        currentSearchQuery = String(value || "").trim().toLowerCase();
        renderYsws();
      }

      function renderYsws() {
        const yswsGrid = document.getElementById("programs");
        yswsGrid.innerHTML = "";

        const rows = yswsList
          .map((item) => ({
            ...item,
            joined: !!latestMembership[item.channel],
            rsvpDone: !!latestRsvpDone[item.channel],
          }))
          .filter((item) => {
            if (currentFilter === "joined") return item.joined;
            if (currentFilter === "todo") return !item.joined;
            return true;
          })
          .filter((item) => {
            if (!currentSearchQuery) return true;
            return (
              item.name.toLowerCase().includes(currentSearchQuery) ||
              item.channel.toLowerCase().includes(currentSearchQuery)
            );
          })
          .sort((a, b) => Number(a.joined) - Number(b.joined) || a.name.localeCompare(b.name));

        const joinedCount = yswsList.filter((item) => latestMembership[item.channel]).length;
        const completedCount = yswsList.filter(
          (item) => latestMembership[item.channel] && latestRsvpDone[item.channel],
        ).length;
        setStats(joinedCount, completedCount, yswsList.length);

        if (!rows.length) {
          const empty = document.createElement("div");
          empty.className = "card";
          empty.innerHTML = "<h3>Nothing here</h3><p class='muted'>No matches right now - try a different filter or search.</p>";
          yswsGrid.appendChild(empty);
          return;
        }

        rows.forEach((ysws) => {
          const card = document.createElement("div");
          const isComplete = ysws.joined && ysws.rsvpDone;
          const isPartial = ysws.joined || ysws.rsvpDone;
          card.className = `card${isComplete ? " card-complete" : isPartial ? " card-partial" : ""}`;

          const cardHead = document.createElement("div");
          cardHead.className = "card-head";

          const titleGroup = document.createElement("div");
          titleGroup.className = "card-title-group";

          const title = document.createElement("h3");
          title.textContent = ysws.name;

          const channelId = document.createElement("span");
          channelId.className = "channel-id";
          channelId.textContent = ysws.channel;

          const rsvpToggle = document.createElement("button");
          rsvpToggle.type = "button";
          rsvpToggle.className = `rsvp-toggle${ysws.rsvpDone ? " is-checked" : ""}`;
          rsvpToggle.setAttribute(
            "aria-label",
            ysws.rsvpDone ? `Unmark RSVP done for ${ysws.name}` : `Mark RSVP done for ${ysws.name}`,
          );
          rsvpToggle.title = ysws.rsvpDone ? "Undo RSVP done" : "Mark RSVP done";
          rsvpToggle.addEventListener("click", () => toggleRsvpDone(ysws.channel, !ysws.rsvpDone, rsvpToggle, ysws.name));

          titleGroup.append(title, channelId);
          cardHead.append(titleGroup, rsvpToggle);

          card.appendChild(cardHead);

          const actions = document.createElement("div");
          actions.className = "actions";

          const joinButton = document.createElement("button");
          if (ysws.joined) {
            joinButton.classList.add("joined");
            joinButton.disabled = true;
            joinButton.textContent = "Joined";
          } else {
            joinButton.textContent = "Add me to channel";
            joinButton.addEventListener("click", () => joinYsws(ysws.channel, joinButton, ysws.name));
          }

          const formButton = document.createElement("button");
          formButton.textContent = "Fill RSVP";
          formButton.addEventListener("click", () => window.open(ysws.form, "_blank"));

          const modalButton = document.createElement("button");
          modalButton.className = "joined description-btn";
          modalButton.type = "button";
          modalButton.textContent = "Description";
          modalButton.addEventListener("click", () => openYswsModal(ysws.channel));

          actions.append(joinButton, formButton, modalButton);
          card.appendChild(actions);
          yswsGrid.appendChild(card);
        });
      }

      async function toggleRsvpDone(channel, done, btn, yswsName) {
        btn.disabled = true;
        btn.classList.add("is-loading");

        let data = { ok: false };
        let response;

        try {
          response = await apiPost("/api/rsvp", { channel, done });
          data = await response.json().catch(() => ({ ok: false }));
        } catch (_error) {
          data = { ok: false };
        }

        if (!response?.ok || !data.ok) {
          btn.disabled = false;
          btn.classList.remove("is-loading");
          const resetAtHeader = Number(response?.headers?.get("X-RateLimit-Reset") || 0);
          const rateLimitMessage =
            response?.status === 429
              ? `Too many RSVP updates. Try again in ${getRateLimitWaitText(resetAtHeader)}.`
              : "";
          if (response?.status === 429) {
            await showRateLimitPopup("RSVP updates", resetAtHeader);
          }
          setStatus(
            "error",
            rateLimitMessage ||
              data.message ||
              `Couldn't ${done ? "save" : "undo"} your RSVP completion for ${yswsName} right now.`,
          );
          return;
        }

        latestRsvpDone = data.rsvpDone || { ...latestRsvpDone, [channel]: done };
        renderYsws();
        setStatus("success", done ? `Marked ${yswsName} RSVP as done.` : `Removed the RSVP done mark for ${yswsName}.`);
      }

      async function joinYsws(channel, btn, yswsName) {
        btn.innerText = "Joining channel...";
        btn.disabled = true;

        let data = { ok: false };
        let response;

        try {
          response = await apiPost("/api/join", { channel });
          data = await response.json().catch(() => ({ ok: false }));
        } catch (_error) {
          data = { ok: false };
        }

        if (!response?.ok || !data.ok) {
          btn.innerText = "Try again";
          btn.disabled = false;
          const resetAtHeader = Number(response?.headers?.get("X-RateLimit-Reset") || 0);
          const rateLimitMessage =
            response?.status === 429
              ? `Too many requests. Try again in ${getRateLimitWaitText(resetAtHeader)}.`
              : "";
          if (response?.status === 429) {
            await showRateLimitPopup("join requests", resetAtHeader);
          }
          setStatus(
            "error",
            rateLimitMessage ||
              data.message ||
              `Couldn't add you to ${yswsName} right now. If this keeps happening, ask an organizer to add the bot to the channel.`,
          );
          return;
        }

        latestMembership[channel] = true;
        renderYsws();
        setStatus("success", `You were added to ${yswsName}.`);
      }

      async function boot() {
        document.getElementById("loginBtn").href = api("/auth/start");
        document.getElementById("logoutBtn").href = api("/auth/logout");

        const oauthError = getQueryParam("oauth_error");
        if (oauthError) {
          showLoggedOut("HC login failed. If this keeps happening, send the details below to Dheeraj S.");
          setSupportMessage(decodeURIComponent(oauthError));
          clearOauthErrorFromUrl();
          return;
        }

        setSupportMessage("");
        await loadDashboard();
      }

      window.setFilter = setFilter;
      window.copySupportMessage = copySupportMessage;
      window.copySlackId = copySlackId;
      window.copyUsername = copyUsername;
      window.copyEmail = copyEmail;
      window.openYswsModal = openYswsModal;
      window.closeYswsModal = closeYswsModal;
      window.setSearch = setSearch;

      boot();
