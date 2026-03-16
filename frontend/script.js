      const API_BASE =
        window.__API_BASE__ || "https://ysws-rsvp-hca.sdheeraj.workers.dev";
      const DEFAULT_AVATAR =
        "https://user-cdn.hackclub-assets.com/019cf11f-eade-7304-ab15-71833ccc4c32/icon-rounded.svg";
      const MEMBERSHIP_LOAD_ERROR =
        "Unable to load your memberships right now. Please try again.";

      let yswsList = [];
      let latestMembership = {};
      let currentFilter = "all";
      let currentSlackId = "";
      let currentUsername = "";
      let currentEmail = "";

      const statusBox = document.getElementById("statusBox");
      const supportBox = document.getElementById("supportBox");
      const supportMessage = document.getElementById("supportMessage");
      const usernameCopyBtn = document.getElementById("usernameCopyBtn");
      const emailCopyBtn = document.getElementById("emailCopyBtn");
      const yswsModal = document.getElementById("programModal");
      const yswsModalTitle = document.getElementById("programModalTitle");
      const yswsModalDesc = document.getElementById("programModalDesc");
      const yswsWebsiteBtn = document.getElementById("programWebsiteBtn");

      function api(path) {
        return `${API_BASE}${path}`;
      }

      async function apiGet(path) {
        return fetch(api(path), {
          credentials: "include",
        });
      }

      async function apiPost(path, body) {
        return fetch(api(path), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      function setView(view) {
        const loading = document.getElementById("loading");
        const step1 = document.getElementById("step1");
        const step2 = document.getElementById("step2");

        loading.style.display = view === "loading" ? "block" : "none";
        step1.style.display = view === "auth" ? "block" : "none";
        step2.style.display = view === "app" ? "block" : "none";
      }

      function setStats(joined, total) {
        const remaining = Math.max(0, total - joined);
        const percent = total ? Math.round((joined / total) * 100) : 0;

        document.getElementById("joinedCount").textContent = String(joined);
        document.getElementById("remainingCount").textContent =
          String(remaining);
        document.getElementById("totalCount").textContent = String(total);
        document.getElementById("progressFill").style.width = `${percent}%`;
      }

      async function readJson(response, fallback) {
        return response.json().catch(() => fallback);
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
          setStatus(
            "success",
            "Copied error details. Send them to Dheeraj S on Slack.",
          );
        } catch (_error) {
          supportMessage.focus();
          supportMessage.select();
          setStatus(
            "error",
            "Copy failed automatically. Select the text and copy it manually.",
          );
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
          setStatus(
            "error",
            "Could not copy automatically. Please copy manually.",
          );
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
              form: String(item.form),
              channel: String(item.channel),
              description: String(
                item.description || "No description added yet.",
              ),
              website: item.website ? String(item.website) : "",
            }));

          return true;
        } catch (_error) {
          setStatus(
            "error",
            "Could not load the YSWS list. Please refresh and try again.",
          );
          return false;
        }
      }

      function openYswsModal(channel) {
        const ysws = yswsList.find((entry) => entry.channel === channel);
        if (!ysws) return;

        yswsModalTitle.textContent = ysws.name;
        yswsModalDesc.textContent =
          ysws.description || "No description added yet.";

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
        window.history.replaceState(
          {},
          "",
          nextUrl.pathname + nextUrl.search + nextUrl.hash,
        );
      }

      function showLoggedOut(message = "") {
        setView("auth");
        document.getElementById("programs").innerHTML = "";

        latestMembership = {};
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

        setStats(0, 0);

        setFilter("all");
        setStatus(message ? "error" : "", message);
      }

      async function loadDashboard() {
        setView("loading");
        setStatus("", "");

        const yswsReady = await loadYswsList();
        if (!yswsReady) {
          showLoggedOut(
            "Could not load the YSWS list. Please refresh and try again.",
          );
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
          showLoggedOut(
            user.error === "not_authenticated" ? "" : MEMBERSHIP_LOAD_ERROR,
          );
          return;
        }

        setView("app");
        setSupportMessage("");

        document.getElementById("hello").textContent =
          `Hi ${user.name || "there"}!`;
        document.getElementById("avatar").src = user.avatar || DEFAULT_AVATAR;

        currentSlackId = String(user.slackId || "")
          .trim()
          .toUpperCase();
        currentUsername = String(user.username || "").trim();
        currentEmail = String(user.email || "").trim();

        document.getElementById("slackIdText").textContent =
          currentSlackId || "—";
        document.getElementById("usernameText").textContent =
          currentUsername || "—";
        document.getElementById("emailText").textContent = currentEmail || "—";
        usernameCopyBtn.style.display = currentUsername
          ? "inline-flex"
          : "none";
        emailCopyBtn.style.display = currentEmail ? "inline-flex" : "none";
        updateVerificationUi(user);

        latestMembership = user.membership || {};
        renderYsws();
      }

      function updateVerificationUi(user) {
        const badge = document.getElementById("verificationBadge");
        const detail = document.getElementById("verificationDetail");
        const eligibility = document.getElementById("eligibilityDetail");
        const isVerified =
          typeof user?.isVerified === "boolean" ? user.isVerified : null;
        const yswsEligible =
          typeof user?.yswsEligible === "boolean" ? user.yswsEligible : null;
        const label = String(
          user?.verificationLabel || "Verification unknown",
        ).trim();
        const rawStatus = String(user?.verificationStatus || "")
          .trim()
          .replace(/[_-]+/g, " ");

        badge.className = `verification-pill ${
          isVerified === true
            ? "verified"
            : isVerified === false
              ? "not-verified"
              : "unknown"
        }`;
        badge.textContent = `Verification: ${label}`;
        detail.textContent = rawStatus
          ? `Status: ${rawStatus}`
          : "Status: unavailable";
        eligibility.textContent =
          yswsEligible === true
            ? "YSWS eligibility: eligible"
            : yswsEligible === false
              ? "YSWS eligibility: not eligible"
              : "YSWS eligibility: unknown";
      }

      function setFilter(nextFilter) {
        currentFilter = nextFilter;

        document
          .getElementById("filterAll")
          .classList.toggle("active", nextFilter === "all");
        document
          .getElementById("filterTodo")
          .classList.toggle("active", nextFilter === "todo");
        document
          .getElementById("filterJoined")
          .classList.toggle("active", nextFilter === "joined");

        renderYsws();
      }

      function renderYsws() {
        const yswsGrid = document.getElementById("programs");
        yswsGrid.innerHTML = "";

        const rows = yswsList
          .map((item) => ({
            ...item,
            joined: !!latestMembership[item.channel],
          }))
          .filter((item) => {
            if (currentFilter === "joined") return item.joined;
            if (currentFilter === "todo") return !item.joined;
            return true;
          })
          .sort(
            (a, b) =>
              Number(a.joined) - Number(b.joined) ||
              a.name.localeCompare(b.name),
          );

        const joinedCount = yswsList.filter(
          (item) => latestMembership[item.channel],
        ).length;
        const total = yswsList.length;
        setStats(joinedCount, total);

        if (!rows.length) {
          const empty = document.createElement("div");
          empty.className = "card";
          empty.innerHTML =
            "<h3>Nothing here</h3><p class='muted'>Try a different filter.</p>";
          yswsGrid.appendChild(empty);
          return;
        }

        rows.forEach((ysws) => {
          const card = document.createElement("div");
          card.className = "card";

          const cardHead = document.createElement("div");
          cardHead.className = "card-head";

          const title = document.createElement("h3");
          title.textContent = ysws.name;

          const channelId = document.createElement("span");
          channelId.className = "channel-id";
          channelId.textContent = ysws.channel;

          cardHead.append(title, channelId);

          const description = document.createElement("p");
          description.className = "muted";
          description.textContent =
            "Join the Slack channel and complete your RSVP form.";

          card.append(cardHead, description);

          if (ysws.joined) {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "Already in channel";
            card.appendChild(badge);
          }

          const actions = document.createElement("div");
          actions.className = "actions";

          const joinButton = document.createElement("button");
          if (ysws.joined) {
            joinButton.classList.add("joined");
            joinButton.disabled = true;
            joinButton.textContent = "Joined";
          } else {
            joinButton.textContent = "Add me to channel";
            joinButton.addEventListener("click", () =>
              joinYsws(ysws.channel, joinButton, ysws.name),
            );
          }

          const formButton = document.createElement("button");
          formButton.textContent = "Fill RSVP";
          formButton.addEventListener("click", () =>
            window.open(ysws.form, "_blank"),
          );

          const modalButton = document.createElement("button");
          modalButton.className = "joined description-btn";
          modalButton.type = "button";
          modalButton.textContent = "Description";
          modalButton.addEventListener("click", () =>
            openYswsModal(ysws.channel),
          );

          actions.append(joinButton, formButton, modalButton);
          card.appendChild(actions);
          yswsGrid.appendChild(card);
        });
      }

      async function joinYsws(channel, btn, yswsName) {
        btn.innerText = "Joining...";
        btn.disabled = true;

        let data = { ok: false };

        try {
          const response = await apiPost("/api/join", { channel });
          data = await response.json().catch(() => ({ ok: false }));
        } catch (_error) {
          data = { ok: false };
        }

        if (!data.ok) {
          btn.innerText = "Try again";
          btn.disabled = false;
          setStatus(
            "error",
            data.message ||
              `Could not add you to ${yswsName}. If this keeps happening, ask an organizer to add the bot to the channel.`,
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
          showLoggedOut(
            "HC login failed. If this keeps happening, send the details below to Dheeraj S.",
          );
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

      boot();
