      const apibase =
        window.__API_BASE__ || "https://ysws-rsvp-hca.sdheeraj.workers.dev";
      const adminslackid = "U0828RTU7FE";
      const defaultavatar =
        "https://user-cdn.hackclub-assets.com/019cf11f-eade-7304-ab15-71833ccc4c32/icon-rounded.svg";
      const membershiploaderror =
        "Couldn't load your memberships right now. Slack might be on a coffee break, try again in a bit.";
      const loginsessionerror =
        "Login completed, but your browser blocked the session cookie. Allow third-party cookies for this site or try a different browser, then log in again.";
      const sessiontokenstoragekey = "ysws_session_token";

      let yswslist = [];
      let latestmembership = {};
      let latestrsvpdone = {};
      let currentfilter = "all";
      let currentsearchquery = "";
      let currentslackid = "";
      let currentusername = "";
      let currentemail = "";
      let isadminuser = false;

      const statusbox = document.getElementById("statusbox");
      const supportbox = document.getElementById("supportbox");
      const supportmessage = document.getElementById("supportmessage");
      const authnavbtn = document.getElementById("authnavbtn");
      const usernamecopybtn = document.getElementById("usernamecopybtn");
      const emailcopybtn = document.getElementById("emailcopybtn");
      const publicsection = document.getElementById("publicsection");
      const yswsmodal = document.getElementById("programmodal");
      const yswsmodaltitle = document.getElementById("programmodaltitle");
      const yswsmodaldesc = document.getElementById("programmodaldesc");
      const yswswebsitebtn = document.getElementById("programwebsitebtn");
      const adminlink = document.getElementById("adminlink");

      function isloginview() {
        const path = window.location.pathname.replace(/\/+$/, "") || "/";
        return path === "/login" || getqueryparam("view") === "login";
      }

      function api(path) {
        return `${apibase}${path}`;
      }

      function getsessiontoken() {
        const token = String(localStorage.getItem(sessiontokenstoragekey) || "").trim();
        if (!token) return "";
        if (!/^[a-f0-9]{32,128}$/i.test(token)) {
          clearsessiontoken();
          return "";
        }
        return token;
      }

      function setsessiontoken(token) {
        const next = String(token || "").trim();
        if (!next) return;
        localStorage.setItem(sessiontokenstoragekey, next);
      }

      function clearsessiontoken() {
        localStorage.removeItem(sessiontokenstoragekey);
      }

      function getauthheaders() {
        const token = getsessiontoken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      }

      async function apiget(path) {
        return fetch(api(path), {
          credentials: "include",
          headers: {
            ...getauthheaders(),
          },
        });
      }

      async function apipost(path, body) {
        return fetch(api(path), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...getauthheaders(),
          },
          body: JSON.stringify(body),
        });
      }

      function getswaloptions(overrides = {}) {
        return {
          background: "#111827",
          color: "#f8fafc",
          buttonsStyling: false,
          customClass: {
            popup: "hcswalpopup",
            confirmButton: "swalconfirmbtn",
            cancelButton: "swalcancelbtn",
          },
          ...overrides,
        };
      }

      async function showpopup({ icon = "info", title = "Notice", text = "" } = {}) {
        if (window.Swal) {
          return window.Swal.fire(getswaloptions({ icon, title, text, confirmButtonText: "OK" }));
        }

        setstatus("error", text || title);
        return null;
      }

      async function showratelimitpopup(actionlabel, resetatms) {
        const waittext = getratelimitwaittext(resetatms);
        await showpopup({
          icon: "warning",
          title: "Rate limited",
          text: `Too many ${actionlabel}. Try again in ${waittext}.`,
        });
      }

      function normalizeexternalurl(value) {
        const url = String(value || "").trim();
        if (!url) return "";
        return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
      }

      function setauthnavbutton(isloggedin) {
        if (!authnavbtn) return;

        const loggedin = !!isloggedin;
        authnavbtn.dataset.authstate = loggedin ? "logout" : "login";
        authnavbtn.textContent = loggedin ? "Logout" : "Login";
        authnavbtn.href = loggedin ? api("/auth/logout") : "/login";
        authnavbtn.setAttribute(
          "aria-label",
          loggedin ? "Log out and switch account" : "Log in with HC Auth",
        );
      }

      function setview(view) {
        const loading = document.getElementById("loading");
        const publichome = document.getElementById("publicsection");
        const step1 = document.getElementById("step1");
        const step2 = document.getElementById("step2");

        loading.style.display = view === "loading" ? "block" : "none";
        publichome.style.display = view === "public" ? "block" : "none";
        step1.style.display = view === "auth" ? "block" : "none";
        step2.style.display = view === "app" ? "block" : "none";
      }

      function setstats(joined, completed, total) {
        const remaining = Math.max(0, total - completed);
        const percent = total ? Math.round((completed / total) * 100) : 0;

        document.getElementById("joinedcount").textContent = String(joined);
        document.getElementById("remainingcount").textContent = String(remaining);
        document.getElementById("totalcount").textContent = String(total);
        document.getElementById("progressfill").style.width = `${percent}%`;
        document.getElementById("completionmeta").textContent = `${completed} of ${total} fully complete (${percent}%)`;
      }

      async function readjson(response, fallback) {
        return response.json().catch(() => fallback);
      }

      function getratelimitwaittext(resetatms) {
        if (!resetatms) return "a few minutes";
        const remainingms = Math.max(0, resetatms - Date.now());
        const totalseconds = Math.ceil(remainingms / 1000);
        const mins = Math.floor(totalseconds / 60);
        const secs = totalseconds % 60;
        if (mins > 0) return `${mins}m ${secs}s`;
        return `${secs}s`;
      }

      function setstatus(type, msg) {
        statusbox.className = "status";

        if (!msg) {
          statusbox.textContent = "";
          return;
        }

        statusbox.classList.add(type);
        statusbox.textContent = msg;
      }

      function setsupportmessage(message = "") {
        supportmessage.value = message;
        supportbox.classList.toggle("show", !!message);
      }

      async function copysupportmessage() {
        const text = supportmessage.value.trim();
        if (!text) return;

        try {
          await navigator.clipboard.writeText(text);
          setstatus("success", "Copied! Paste it to Dheeraj S and we can debug this quickly.");
        } catch (_error) {
          supportmessage.focus();
          supportmessage.select();
          setstatus("error", "Auto-copy tripped. Select the text and copy it manually.");
        }
      }

      async function copyvalue(text, successmessage) {
        const value = (text || "").trim();

        if (!value) {
          setstatus("error", "Value is not available yet.");
          return;
        }

        try {
          await navigator.clipboard.writeText(value);
          setstatus("success", successmessage);
        } catch (_error) {
          setstatus("error", "Clipboard said nope - please copy manually.");
        }
      }

      async function copyslackid() {
        await copyvalue(currentslackid, "Slack ID copied.");
      }

      async function copyusername() {
        await copyvalue(currentusername, "Slack username copied.");
      }

      async function copyemail() {
        await copyvalue(currentemail, "Email copied.");
      }

      async function detectadminaccess() {
        try {
          const response = await apiget("/api/admin/access");
          if (!response.ok) return false;
          const data = await readjson(response, { ok: false });
          return !!data.ok;
        } catch (_error) {
          return false;
        }
      }

      async function loadyswslist() {
        if (yswslist.length) return true;

        try {
          const response = await apiget("/ysws.json");
          if (!response.ok) throw new Error("catalog_failed");

          const list = await response.json();
          if (!Array.isArray(list)) throw new Error("invalid_ysws_list");

          yswslist = list
            .filter((item) => item?.name && item?.form && item?.channel)
            .map((item) => ({
              name: String(item.name),
              form: normalizeexternalurl(item.form),
              channel: String(item.channel),
              description: String(item.description || "No description added yet."),
              website: normalizeexternalurl(item.website),
            }));

          return true;
        } catch (_error) {
          setstatus("error", "Couldn't load the YSWS list. Give it a refresh and we'll try again.");
          return false;
        }
      }

      function openyswsmodal(channel) {
        const ysws = yswslist.find((entry) => entry.channel === channel);
        if (!ysws) return;

        yswsmodaltitle.textContent = ysws.name;
        yswsmodaldesc.textContent = ysws.description || "No description added yet.";

        if (ysws.website) {
          yswswebsitebtn.style.display = "inline-flex";
          yswswebsitebtn.onclick = () => window.open(ysws.website, "_blank");
        } else {
          yswswebsitebtn.style.display = "none";
          yswswebsitebtn.onclick = null;
        }

        yswsmodal.classList.add("show");
      }

      function closeyswsmodal(event) {
        if (event && event.target !== yswsmodal) return;
        yswsmodal.classList.remove("show");
      }

      function getqueryparam(name) {
        return new URLSearchParams(window.location.search).get(name) || "";
      }

      function clearoautherrorfromurl() {
        const nexturl = new URL(window.location.href);
        nexturl.searchParams.delete("oauth_error");
        window.history.replaceState({}, "", nexturl.pathname + nexturl.search + nexturl.hash);
      }

      function clearauthattemptfromurl() {
        const nexturl = new URL(window.location.href);
        nexturl.searchParams.delete("auth_attempted");
        window.history.replaceState({}, "", nexturl.pathname + nexturl.search + nexturl.hash);
      }

      function consumesessiontokenfromurl() {
        const nexturl = new URL(window.location.href);
        const sessiontoken = String(nexturl.searchParams.get("session_token") || "").trim();
        if (!sessiontoken) return false;
        setsessiontoken(sessiontoken);
        nexturl.searchParams.delete("session_token");
        window.history.replaceState({}, "", nexturl.pathname + nexturl.search + nexturl.hash);
        return true;
      }

      function showloggedout(message = "", forceloginview = false) {
        const useloginview = forceloginview || isloginview();
        setview(useloginview ? "auth" : "public");
        setauthnavbutton(!!getsessiontoken());
        document.getElementById("programs").innerHTML = "";

        if (!useloginview && yswslist.length) {
          renderpublicysws();
        }

        latestmembership = {};
        latestrsvpdone = {};
        currentslackid = "";
        currentusername = "";
        currentemail = "";

        document.getElementById("hello").textContent = "";
        document.getElementById("avatar").removeAttribute("src");
        document.getElementById("slackidtext").textContent = "-";
        document.getElementById("usernametext").textContent = "-";
        document.getElementById("emailtext").textContent = "-";
        updateverificationui({
          isVerified: null,
          verificationLabel: "Verification unknown",
          verificationStatus: "",
          yswsEligible: null,
        });
        usernamecopybtn.style.display = "none";
        emailcopybtn.style.display = "none";
        adminlink.style.display = "none";

        const searchinput = document.getElementById("searchysws");
        if (searchinput) searchinput.value = "";
        currentsearchquery = "";

        setstats(0, 0, 0);
        setfilter("all");
        setstatus(message ? "error" : "", message);
      }

      function renderpublicysws() {
        const grid = document.getElementById("publicprograms");
        if (!grid) return;

        grid.innerHTML = "";

        const rows = [...yswslist].sort((a, b) => a.name.localeCompare(b.name));

        rows.forEach((ysws) => {
          const card = document.createElement("div");
          card.className = "card";

          const cardhead = document.createElement("div");
          cardhead.className = "cardhead";

          const title = document.createElement("h3");
          title.textContent = ysws.name;

          const channelid = document.createElement("span");
          channelid.className = "channelid";
          channelid.textContent = ysws.channel;

          cardhead.append(title, channelid);

          const copy = document.createElement("p");
          copy.className = "muted";
          copy.textContent = "Open the channel, then complete your RSVP form.";

          const actions = document.createElement("div");
          actions.className = "actions";

          const channelbutton = document.createElement("button");
          channelbutton.textContent = "Open channel";
          channelbutton.addEventListener("click", () => {
            window.open(
              `https://hackclub.enterprise.slack.com/archives/${ysws.channel}`,
              "_blank",
            );
          });

          const formbutton = document.createElement("button");
          formbutton.textContent = "Fill RSVP";
          formbutton.addEventListener("click", () => window.open(ysws.form, "_blank"));

          const modalbutton = document.createElement("button");
          modalbutton.className = "joined descriptionbtn";
          modalbutton.type = "button";
          modalbutton.textContent = "Description";
          modalbutton.addEventListener("click", () => openyswsmodal(ysws.channel));

          actions.append(channelbutton, formbutton, modalbutton);
          card.append(cardhead, copy, actions);
          grid.appendChild(card);
        });
      }

      async function loaddashboard({ authattempted = false } = {}) {
        setview("loading");
        setstatus("", "");

        const yswsready = await loadyswslist();
        if (!yswsready) {
          showloggedout("Could not load the YSWS list. Please refresh and try again.");
          return;
        }

        let userresponse;
        try {
          userresponse = await apiget("/api/user");
        } catch (_error) {
          showloggedout(membershiploaderror);
          return;
        }

        if (!userresponse.ok) {
          showloggedout(
            userresponse.status === 401 || userresponse.status === 403
              ? authattempted
                ? loginsessionerror
                : ""
              : membershiploaderror,
            authattempted,
          );
          return;
        }

        const user = await readjson(userresponse, { ok: false });
        if (!user.ok) {
          showloggedout(
            user.error === "not_authenticated"
              ? authattempted
                ? loginsessionerror
                : ""
              : membershiploaderror,
            authattempted,
          );
          return;
        }

        setview("app");
        setauthnavbutton(true);
        setsupportmessage("");

        document.getElementById("hello").textContent = `Hi ${user.name || "there"}!`;
        document.getElementById("avatar").src = user.avatar || defaultavatar;

        currentslackid = String(user.slackId || "").trim().toUpperCase();
        currentusername = String(user.username || "").trim();
        currentemail = String(user.email || "").trim();
        isadminuser = currentslackid === adminslackid;

        document.getElementById("slackidtext").textContent = currentslackid || "-";
        document.getElementById("usernametext").textContent = currentusername || "-";
        document.getElementById("emailtext").textContent = currentemail || "-";
        usernamecopybtn.style.display = currentusername ? "inline-flex" : "none";
        emailcopybtn.style.display = currentemail ? "inline-flex" : "none";
        updateverificationui(user);

        latestmembership = user.membership || {};
        latestrsvpdone = user.rsvpDone || {};

        if (!isadminuser) {
          isadminuser = await detectadminaccess();
        }
        adminlink.style.display = isadminuser ? "inline-flex" : "none";

        renderysws();
      }

      function updateverificationui(user) {
        const badge = document.getElementById("verificationbadge");
        const detail = document.getElementById("verificationdetail");
        const eligibility = document.getElementById("eligibilitydetail");
        const isVerified = typeof user?.isVerified === "boolean" ? user.isVerified : null;
        const yswsEligible = typeof user?.yswsEligible === "boolean" ? user.yswsEligible : null;
        const label = String(user?.verificationLabel || "Verification unknown").trim();
        const rawstatus = String(user?.verificationStatus || "").trim().replace(/[_-]+/g, " ");

        badge.className = `verificationpill ${
          isVerified === true ? "verified" : isVerified === false ? "notverified" : "unknown"
        }`;
        badge.textContent = `Verification: ${label}`;
        detail.textContent = rawstatus ? `Status: ${rawstatus}` : "Status: unavailable";
        eligibility.textContent =
          yswsEligible === true
            ? "YSWS eligibility: eligible"
            : yswsEligible === false
              ? "YSWS eligibility: not eligible"
              : "YSWS eligibility: unknown";
      }

      function setfilter(nextfilter) {
        currentfilter = nextfilter;

        document.getElementById("filterall").classList.toggle("active", nextfilter === "all");
        document.getElementById("filtertodo").classList.toggle("active", nextfilter === "todo");
        document.getElementById("filterjoined").classList.toggle("active", nextfilter === "joined");

        renderysws();
      }

      function setsearch(value) {
        currentsearchquery = String(value || "").trim().toLowerCase();
        renderysws();
      }

      function renderysws() {
        const yswsgrid = document.getElementById("programs");
        yswsgrid.innerHTML = "";

        const rows = yswslist
          .map((item) => ({
            ...item,
            joined: !!latestmembership[item.channel],
            rsvpDone: !!latestrsvpdone[item.channel],
          }))
          .filter((item) => {
            if (currentfilter === "joined") return item.joined;
            if (currentfilter === "todo") return !item.joined;
            return true;
          })
          .filter((item) => {
            if (!currentsearchquery) return true;
            return (
              item.name.toLowerCase().includes(currentsearchquery) ||
              item.channel.toLowerCase().includes(currentsearchquery)
            );
          })
          .sort((a, b) => Number(a.joined) - Number(b.joined) || a.name.localeCompare(b.name));

        const joinedcount = yswslist.filter((item) => latestmembership[item.channel]).length;
        const completedcount = yswslist.filter(
          (item) => latestmembership[item.channel] && latestrsvpdone[item.channel],
        ).length;
        setstats(joinedcount, completedcount, yswslist.length);

        if (!rows.length) {
          const empty = document.createElement("div");
          empty.className = "card";
          empty.innerHTML = "<h3>Nothing here</h3><p class='muted'>No matches right now - try a different filter or search.</p>";
          yswsgrid.appendChild(empty);
          return;
        }

        rows.forEach((ysws) => {
          const card = document.createElement("div");
          const iscomplete = ysws.joined && ysws.rsvpDone;
          const ispartial = ysws.joined || ysws.rsvpDone;
          card.className = `card${iscomplete ? " cardcomplete" : ispartial ? " cardpartial" : ""}`;

          const cardhead = document.createElement("div");
          cardhead.className = "cardhead";

          const titlegroup = document.createElement("div");
          titlegroup.className = "cardtitlegroup";

          const title = document.createElement("h3");
          title.textContent = ysws.name;

          const channelid = document.createElement("span");
          channelid.className = "channelid";
          channelid.textContent = ysws.channel;

          const rsvptoggle = document.createElement("button");
          rsvptoggle.type = "button";
          rsvptoggle.className = `rsvptoggle${ysws.rsvpDone ? " ischecked" : ""}`;
          rsvptoggle.setAttribute(
            "aria-label",
            ysws.rsvpDone ? `Unmark RSVP done for ${ysws.name}` : `Mark RSVP done for ${ysws.name}`,
          );
          rsvptoggle.title = ysws.rsvpDone ? "Undo RSVP done" : "Mark RSVP done";
          rsvptoggle.addEventListener("click", () => togglersvpdone(ysws.channel, !ysws.rsvpDone, rsvptoggle, ysws.name));

          titlegroup.append(title, channelid);
          cardhead.append(titlegroup, rsvptoggle);

          card.appendChild(cardhead);

          const actions = document.createElement("div");
          actions.className = "actions";

          const joinbutton = document.createElement("button");
          if (ysws.joined) {
            joinbutton.classList.add("joined");
            joinbutton.disabled = true;
            joinbutton.textContent = "Joined";
          } else {
            joinbutton.textContent = "Add me to channel";
            joinbutton.addEventListener("click", () => joinysws(ysws.channel, joinbutton, ysws.name));
          }

          const formbutton = document.createElement("button");
          formbutton.textContent = "Fill RSVP";
          formbutton.addEventListener("click", () => window.open(ysws.form, "_blank"));

          const modalbutton = document.createElement("button");
          modalbutton.className = "joined descriptionbtn";
          modalbutton.type = "button";
          modalbutton.textContent = "Description";
          modalbutton.addEventListener("click", () => openyswsmodal(ysws.channel));

          actions.append(joinbutton, formbutton, modalbutton);
          card.appendChild(actions);
          yswsgrid.appendChild(card);
        });
      }

      async function togglersvpdone(channel, done, btn, yswsname) {
        btn.disabled = true;
        btn.classList.add("isloading");

        let data = { ok: false };
        let response;

        try {
          response = await apipost("/api/rsvp", { channel, done });
          data = await response.json().catch(() => ({ ok: false }));
        } catch (_error) {
          data = { ok: false };
        }

        if (!response?.ok || !data.ok) {
          btn.disabled = false;
          btn.classList.remove("isloading");
          const resetatheader = Number(response?.headers?.get("X-RateLimit-Reset") || 0);
          const ratelimitmessage =
            response?.status === 429
              ? `Too many RSVP updates. Try again in ${getratelimitwaittext(resetatheader)}.`
              : "";
          if (response?.status === 429) {
            await showratelimitpopup("RSVP updates", resetatheader);
          }
          setstatus(
            "error",
            ratelimitmessage ||
              data.message ||
              `Couldn't ${done ? "save" : "undo"} your RSVP completion for ${yswsname} right now.`,
          );
          return;
        }

        latestrsvpdone = data.rsvpDone || { ...latestrsvpdone, [channel]: done };
        renderysws();
        setstatus("success", done ? `Marked ${yswsname} RSVP as done.` : `Removed the RSVP done mark for ${yswsname}.`);
      }

      async function joinysws(channel, btn, yswsname) {
        btn.innerText = "Joining channel...";
        btn.disabled = true;

        let data = { ok: false };
        let response;

        try {
          response = await apipost("/api/join", { channel });
          data = await response.json().catch(() => ({ ok: false }));
        } catch (_error) {
          data = { ok: false };
        }

        if (!response?.ok || !data.ok) {
          btn.innerText = "Try again";
          btn.disabled = false;
          const resetatheader = Number(response?.headers?.get("X-RateLimit-Reset") || 0);
          const ratelimitmessage =
            response?.status === 429
              ? `Too many requests. Try again in ${getratelimitwaittext(resetatheader)}.`
              : "";
          if (response?.status === 429) {
            await showratelimitpopup("join requests", resetatheader);
          }
          setstatus(
            "error",
            ratelimitmessage ||
              data.message ||
              `Couldn't add you to ${yswsname} right now. If this keeps happening, ask an organizer to add the bot to the channel.`,
          );
          return;
        }

        latestmembership[channel] = true;
        renderysws();
        setstatus("success", `You were added to ${yswsname}.`);
      }

      async function bootapp() {
        document.getElementById("loginbtn").href = api("/auth/start");
        document.getElementById("logoutbtn").href = api("/auth/logout");
        document.getElementById("logoutbtn").addEventListener("click", clearsessiontoken);
        if (authnavbtn) {
          authnavbtn.addEventListener("click", () => {
            if (authnavbtn.dataset.authstate === "logout") {
              clearsessiontoken();
            }
          });
        }

        consumesessiontokenfromurl();
        setauthnavbutton(!!getsessiontoken());
        const authattempted = getqueryparam("auth_attempted") === "1";
        if (authattempted) {
          clearauthattemptfromurl();
        }

        const oautherror = getqueryparam("oauth_error");
        if (oautherror) {
          showloggedout("HC login failed. If this keeps happening, send the details below to Dheeraj S.", true);
          setsupportmessage(decodeURIComponent(oautherror));
          clearoautherrorfromurl();
          return;
        }

        const yswsready = await loadyswslist();
        if (!yswsready) {
          showloggedout("Could not load the YSWS list. Please refresh and try again.");
          return;
        }

        if (!isloginview()) {
          renderpublicysws();
        }

        setsupportmessage("");
        await loaddashboard({ authattempted });
      }

      window.setfilter = setfilter;
      window.copysupportmessage = copysupportmessage;
      window.copyslackid = copyslackid;
      window.copyusername = copyusername;
      window.copyemail = copyemail;
      window.openyswsmodal = openyswsmodal;
      window.closeyswsmodal = closeyswsmodal;
      window.setsearch = setsearch;

      bootapp();
